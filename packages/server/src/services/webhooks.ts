import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import net from 'node:net';
import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { Agent, fetch as undiciFetch } from 'undici';
import { createSsrfSafeLookup, isPrivateIp } from '@chronicle/ai/documents';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { webhookDeliveries, webhooks, type WebhookEventType } from '../db/schema.js';
import { badRequest } from '../http.js';

/**
 * Outgoing webhooks, signed per the Standard Webhooks spec
 * (https://www.standardwebhooks.com/):
 *
 * ```
 * webhook-id:        msg_<uuid>          (same on every retry; use it to de-duplicate)
 * webhook-timestamp: <unix seconds>
 * webhook-signature: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>
 * ```
 *
 * The secret is `whsec_<base64 key>`; the HMAC key is the decoded base64 part.
 * Deliveries are queued in the database and sent by a worker that claims
 * rows with `FOR UPDATE SKIP LOCKED`, so several instances can share the
 * queue. Failures are retried with backoff; a message that still fails after
 * every attempt switches the webhook off until its owner turns it back on.
 */

/** Delay before attempt n+1 (index = attempts made so far − 1). ~21 hours in total. */
const BACKOFF_MS = [
  10_000,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  12 * 3_600_000,
  12 * 3_600_000,
  12 * 3_600_000,
  12 * 3_600_000,
];
/** A delivery stuck in `delivering` this long (crashed worker) is retried. */
const STUCK_AFTER_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const BATCH = 10;

export interface WebhookPayload {
  type: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function generateSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function encryptionKey(config: Config): Buffer {
  return Buffer.from(
    hkdfSync('sha256', config.jwtSecret, Buffer.alloc(0), 'chronicle-webhook-secrets', 32),
  );
}

export function encryptSecret(config: Config, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(config), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv, data, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join('.');
}

export function decryptSecret(config: Config, stored: string): string {
  const [version, iv, data, tag] = stored.split('.');
  if (version !== 'v1' || !iv || !data || !tag) throw new Error('Unknown secret format');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(config),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/** The `webhook-signature` value for a message. */
export function signPayload(
  secret: string,
  messageId: string,
  timestamp: number,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const mac = createHmac('sha256', key)
    .update(`${messageId}.${String(timestamp)}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/** Rejects URLs a webhook may not target (throws a 400 explaining why). */
export function checkWebhookUrl(config: Config, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('Enter a valid URL');
  }
  const allowPrivate = config.WEBHOOK_ALLOW_PRIVATE_URLS;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowPrivate)) {
    throw badRequest('Webhook URLs must use https://');
  }
  if (url.username || url.password) throw badRequest('Credentials in URLs are not allowed');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      throw badRequest('Webhooks cannot target local or internal hosts');
    }
    if (net.isIP(host) && isPrivateIp(host)) {
      throw badRequest('Webhooks cannot target private network addresses');
    }
  }
  url.hash = '';
  return url.toString();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface DeliveryResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

export class WebhookService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private kicked = false;
  private stopped = false;
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastDraftSent = new Map<string, number>();
  private readonly agent: Agent | null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly log: {
      warn: (o: object, m: string) => void;
      error: (o: object, m: string) => void;
    },
    /** Injectable for tests; defaults to an SSRF-safe fetch. */
    private readonly fetchImpl?: typeof fetch,
  ) {
    // Pin every connection to a vetted public IP (no DNS rebinding).
    this.agent =
      fetchImpl || config.WEBHOOK_ALLOW_PRIVATE_URLS
        ? null
        : new Agent({ connect: { lookup: createSsrfSafeLookup() } });
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      this.kick();
    }, this.config.WEBHOOK_POLL_MS);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.draftTimers.values()) clearTimeout(t);
    this.draftTimers.clear();
    await this.running;
    await this.agent?.close().catch(() => undefined);
  }

  /** Processes due deliveries soon (no-op unless the worker is running). */
  kick(): void {
    if (!this.timer || this.stopped) return;
    if (this.running) {
      this.kicked = true;
      return;
    }
    this.running = (async () => {
      try {
        do {
          this.kicked = false;
          await this.runOnce();
        } while (this.shouldRunAgain());
      } catch (err) {
        this.log.error({ err }, 'webhook worker failed');
      } finally {
        this.running = null;
      }
    })();
  }

  /** A method, so TypeScript doesn't assume the flags can't change across an await. */
  private shouldRunAgain(): boolean {
    return this.kicked && !this.stopped;
  }

  /**
   * Queues `type` for every active webhook of the project subscribed to it.
   * Returns the ids of the queued deliveries.
   */
  async emit(
    projectId: string,
    type: WebhookEventType,
    data: Record<string, unknown>,
    onlyWebhookId?: string,
  ): Promise<string[]> {
    const targets = await this.db
      .select({ id: webhooks.id, events: webhooks.events })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.projectId, projectId),
          // A test ping may go to a switched-off webhook (to check it before re-enabling).
          type === 'ping' ? undefined : eq(webhooks.active, true),
          onlyWebhookId ? eq(webhooks.id, onlyWebhookId) : undefined,
        ),
      );
    const subscribed = targets.filter((w) => type === 'ping' || w.events.includes(type));
    if (subscribed.length === 0) return [];
    const payload: WebhookPayload = {
      type,
      timestamp: new Date().toISOString(),
      data: { projectId, ...data },
    };
    const body = JSON.stringify(payload);
    const rows = await this.db
      .insert(webhookDeliveries)
      .values(
        subscribed.map((w) => ({
          webhookId: w.id,
          messageId: `msg_${randomUUID()}`,
          eventType: type,
          payload: body,
        })),
      )
      .returning({ id: webhookDeliveries.id });
    this.kick();
    return rows.map((r) => r.id);
  }

  /** Fire-and-forget `emit` for request handlers: failures are logged, never thrown. */
  notify(projectId: string, type: WebhookEventType, data: Record<string, unknown>): void {
    this.emit(projectId, type, data).catch((err: unknown) => {
      this.log.error({ err, projectId, type }, 'failed to queue webhook');
    });
  }

  /**
   * `draft.updated`, throttled: at most one per project per interval, and the
   * last change in a burst is always reported (trailing edge).
   */
  draftUpdated(projectId: string, data: { draftVersion: number; updatedAt: Date }): void {
    if (this.stopped) return;
    const interval = this.config.WEBHOOK_DRAFT_INTERVAL_SECONDS * 1000;
    const send = () => {
      this.lastDraftSent.set(projectId, Date.now());
      this.notify(projectId, 'draft.updated', {
        draftVersion: data.draftVersion,
        updatedAt: data.updatedAt.toISOString(),
      });
    };
    const last = this.lastDraftSent.get(projectId) ?? 0;
    const wait = last + interval - Date.now();
    const existing = this.draftTimers.get(projectId);
    if (existing) clearTimeout(existing);
    this.draftTimers.delete(projectId);
    if (wait <= 0) {
      send();
      return;
    }
    // Re-armed on every save, so the trailing delivery carries the newest version.
    const timer = setTimeout(() => {
      this.draftTimers.delete(projectId);
      send();
    }, wait);
    timer.unref();
    this.draftTimers.set(projectId, timer);
  }

  /** Claims and sends due deliveries; returns how many were attempted. */
  async runOnce(): Promise<number> {
    const now = new Date();
    const claimed = await this.db
      .update(webhookDeliveries)
      .set({ status: 'delivering', lastAttemptAt: now })
      .where(
        inArray(
          webhookDeliveries.id,
          sql`(select ${webhookDeliveries.id} from ${webhookDeliveries}
               where (${webhookDeliveries.status} = 'pending'
                      and ${webhookDeliveries.nextAttemptAt} <= ${now.toISOString()}::timestamptz)
                  or (${webhookDeliveries.status} = 'delivering'
                      and ${webhookDeliveries.lastAttemptAt} < ${new Date(now.getTime() - STUCK_AFTER_MS).toISOString()}::timestamptz)
               order by ${webhookDeliveries.nextAttemptAt}
               limit ${BATCH}
               for update skip locked)`,
        ),
      )
      .returning();
    await Promise.all(claimed.map((d) => this.deliver(d)));
    return claimed.length;
  }

  private async deliver(delivery: typeof webhookDeliveries.$inferSelect): Promise<void> {
    const [hook] = await this.db
      .select()
      .from(webhooks)
      .where(eq(webhooks.id, delivery.webhookId))
      .limit(1);
    if (!hook) return; // deleted; the delivery row went with it
    if (!hook.active && delivery.eventType !== 'ping') {
      await this.db
        .update(webhookDeliveries)
        .set({ status: 'failed', lastError: 'Webhook is disabled' })
        .where(eq(webhookDeliveries.id, delivery.id));
      return;
    }

    const attempts = delivery.attempts + 1;
    let result: DeliveryResult;
    try {
      result = await this.send(hook.url, decryptSecret(this.config, hook.secretEncrypted), {
        messageId: delivery.messageId,
        body: delivery.payload,
      });
    } catch (err) {
      result = { ok: false, statusCode: null, error: describe(err) };
    }

    if (result.ok) {
      await this.db
        .update(webhookDeliveries)
        .set({
          status: 'succeeded',
          attempts,
          lastStatusCode: result.statusCode,
          lastError: null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
      await this.db
        .update(webhooks)
        .set({ consecutiveFailures: 0 })
        .where(eq(webhooks.id, hook.id));
      return;
    }

    const exhausted = attempts >= this.config.WEBHOOK_MAX_ATTEMPTS;
    await this.db
      .update(webhookDeliveries)
      .set({
        status: exhausted ? 'failed' : 'pending',
        attempts,
        lastStatusCode: result.statusCode,
        lastError: result.error?.slice(0, 500) ?? null,
        nextAttemptAt: new Date(
          Date.now() + (BACKOFF_MS[attempts - 1] ?? BACKOFF_MS.at(-1) ?? 3_600_000),
        ),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    await this.db
      .update(webhooks)
      .set({
        consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`,
        ...(exhausted && delivery.eventType !== 'ping'
          ? {
              active: false,
              disabledReason:
                `Turned off after a delivery failed ${String(attempts)} times (last error: ${result.error ?? `HTTP ${String(result.statusCode)}`})`.slice(
                  0,
                  500,
                ),
              updatedAt: new Date(),
            }
          : {}),
      })
      .where(eq(webhooks.id, hook.id));
    if (exhausted) {
      this.log.warn({ webhookId: hook.id, deliveryId: delivery.id }, 'webhook delivery failed');
    }
  }

  /** Sends one signed request. 2xx = success; redirects are not followed. */
  async send(
    url: string,
    secret: string,
    message: { messageId: string; body: string },
  ): Promise<DeliveryResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'Chronicle-Webhooks/1.0',
      'webhook-id': message.messageId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signPayload(secret, message.messageId, timestamp, message.body),
    };
    const init = {
      method: 'POST',
      headers,
      body: message.body,
      redirect: 'manual' as const,
      signal: AbortSignal.timeout(this.config.WEBHOOK_TIMEOUT_MS),
    };
    const res = this.fetchImpl
      ? await this.fetchImpl(url, init)
      : this.agent
        ? ((await undiciFetch(url, { ...init, dispatcher: this.agent })) as unknown as Response)
        : await fetch(url, init);
    // Read (a bounded amount of) the body so the connection can be reused.
    await drain(res);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status, error: null };
    }
    return {
      ok: false,
      statusCode: res.status,
      error:
        res.status >= 300 && res.status < 400
          ? `Redirects are not followed (HTTP ${String(res.status)})`
          : `HTTP ${String(res.status)}`,
    };
  }

  /** Puts a finished delivery back in the queue (owner-requested redelivery). */
  async redeliver(deliveryId: string): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: new Date(), lastError: null })
      .where(eq(webhookDeliveries.id, deliveryId));
    this.kick();
  }

  /** Deletes delivery history older than `days` (keeps the table small). */
  async prune(days = 30): Promise<void> {
    await this.db
      .delete(webhookDeliveries)
      .where(
        and(
          or(eq(webhookDeliveries.status, 'succeeded'), eq(webhookDeliveries.status, 'failed')),
          lt(webhookDeliveries.createdAt, new Date(Date.now() - days * 86_400_000)),
        ),
      );
  }

  /** Due deliveries count (for tests and diagnostics). */
  async dueCount(): Promise<number> {
    const rows = await this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lte(webhookDeliveries.nextAttemptAt, new Date()),
        ),
      );
    return rows.length;
  }
}

async function drain(res: Response): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  let read = 0;
  try {
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done) return;
      read += value?.byteLength ?? 0;
      if (read > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // The response body doesn't matter.
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'ESSRFBLOCKED') return 'The URL resolves to a private network address';
    if (err.name === 'TimeoutError') return 'Timed out';
    return cause?.message ?? err.message;
  }
  return String(err);
}
