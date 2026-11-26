import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { webhookDeliveries, webhooks } from '../db/schema.js';
import { loadConfig } from '../config.js';
import {
  checkWebhookUrl,
  decryptSecret,
  encryptSecret,
  signPayload,
} from '../services/webhooks.js';
import {
  createProject,
  createTestServer,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A local endpoint that records requests and answers with `status`. */
async function receiver(): Promise<{
  url: string;
  received: Received[];
  status: { code: number; location?: string };
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const status: { code: number; location?: string } = { code: 200 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(status.code, status.location ? { location: status.location } : {});
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`,
    received,
    status,
    close: () =>
      new Promise((r) =>
        server.close(() => {
          r();
        }),
      ),
  };
}

/** Independent Standard Webhooks verification. */
function verify(secret: string, r: Received): boolean {
  const id = r.headers['webhook-id'] as string;
  const ts = r.headers['webhook-timestamp'] as string;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${r.body}`).digest('base64');
  return (r.headers['webhook-signature'] as string).split(' ').includes(`v1,${expected}`);
}

describe('webhooks', () => {
  let ctx: TestContext;
  let owner: TestUser;
  let project: { id: string; slug: string };
  let endpoint: Awaited<ReturnType<typeof receiver>>;

  beforeEach(async () => {
    ctx = await createTestServer({
      WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
      WEBHOOK_WORKER: 'false',
      WEBHOOK_MAX_ATTEMPTS: '2',
      WEBHOOK_DRAFT_INTERVAL_SECONDS: '0',
    });
    owner = await signUp(ctx.app, 'Owner');
    project = await createProject(ctx.app, owner);
    endpoint = await receiver();
  });
  afterEach(async () => {
    await endpoint.close();
    await ctx.close();
  });

  const create = (payload: object, user: TestUser = owner) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/webhooks`,
      headers: user.auth,
      payload,
    });

  /** Runs the worker until nothing is due. */
  const drain = async () => {
    while ((await ctx.app.ctx.webhooks.runOnce()) > 0) {
      /* keep going */
    }
  };

  it('creates webhooks for owners only, showing the secret once and storing it encrypted', async () => {
    const res = await create({
      url: endpoint.url,
      events: ['timeline.published', 'timeline.published'],
      description: 'Rebuild site',
    });
    expect(res.statusCode).toBe(201);
    const hook = res.json<{ id: string; secret: string; events: string[] }>();
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9+/=]{40,}$/);
    expect(hook.events).toEqual(['timeline.published']);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/webhooks`,
      headers: owner.auth,
    });
    expect(listed.body).not.toContain(hook.secret);
    const [row] = await ctx.database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(row?.secretEncrypted).not.toContain(hook.secret.slice(6, 20));
    expect(decryptSecret(ctx.config, row?.secretEncrypted ?? '')).toBe(hook.secret);

    // Editors can't manage webhooks.
    const editor = await signUp(ctx.app, 'Editor');
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/collaborators`,
      headers: owner.auth,
      payload: { email: editor.email, role: 'editor' },
    });
    expect(
      (await create({ url: endpoint.url, events: ['draft.updated'] }, editor)).statusCode,
    ).toBe(403);
    expect((await create({ url: endpoint.url, events: [] })).statusCode).toBe(400);
    expect((await create({ url: endpoint.url, events: ['nope'] })).statusCode).toBe(400);
  });

  it('sends signed timeline.published deliveries', async () => {
    const hook = (await create({ url: endpoint.url, events: ['timeline.published'] })).json<{
      secret: string;
    }>();
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: { message: 'First' },
    });
    await drain();
    expect(endpoint.received).toHaveLength(1);
    const [req] = endpoint.received;
    if (!req) throw new Error('no request');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['webhook-id']).toMatch(/^msg_/);
    expect(verify(hook.secret, req)).toBe(true);
    const payload = JSON.parse(req.body) as { type: string; data: Record<string, unknown> };
    expect(payload).toMatchObject({
      type: 'timeline.published',
      data: {
        projectId: project.id,
        version: 1,
        message: 'First',
        slug: project.slug,
        pageUrl: `http://chronicle.test/timeline/${project.slug}`,
      },
    });
  });

  it('delivers comment and draft events to subscribers only', async () => {
    await create({ url: endpoint.url, events: ['comment.created', 'draft.updated'] });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: {},
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/comments`,
      headers: owner.auth,
      payload: { eventId: 'apollo', body: 'Check this' },
    });
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}`,
      headers: owner.auth,
      payload: { title: 'Renamed' },
    });
    await new Promise((r) => setTimeout(r, 50)); // notifications are queued asynchronously
    await drain();
    const types = endpoint.received.map((r) => (JSON.parse(r.body) as { type: string }).type);
    expect(types.sort()).toEqual(['comment.created', 'draft.updated']);
  });

  it('retries with backoff, then switches the webhook off; owners can redeliver', async () => {
    const hook = (await create({ url: endpoint.url, events: ['timeline.published'] })).json<{
      id: string;
    }>();
    endpoint.status.code = 500;
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: {},
    });
    await drain();
    let [delivery] = await ctx.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500 });
    expect(delivery?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Make the retry due now; it fails again and exhausts the 2 attempts.
    await ctx.database.db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(webhookDeliveries.webhookId, hook.id));
    await drain();
    [delivery] = await ctx.database.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.id));
    expect(delivery).toMatchObject({ status: 'failed', attempts: 2 });
    const [row] = await ctx.database.db.select().from(webhooks).where(eq(webhooks.id, hook.id));
    expect(row?.active).toBe(false);
    expect(row?.disabledReason).toContain('HTTP 500');

    // Turning it back on clears the failure state; redelivery succeeds.
    endpoint.status.code = 204;
    const on = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}`,
      headers: owner.auth,
      payload: { active: true },
    });
    expect(on.json()).toMatchObject({ active: true, disabledReason: null, consecutiveFailures: 0 });
    const redeliver = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}/deliveries/${delivery?.id ?? ''}/redeliver`,
      headers: owner.auth,
    });
    expect(redeliver.statusCode).toBe(202);
    await drain();
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}/deliveries`,
      headers: owner.auth,
    });
    expect(log.json<{ deliveries: { status: string; messageId: string }[] }>().deliveries).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    // Retries reuse the message id so receivers can de-duplicate.
    const ids = new Set(endpoint.received.map((r) => r.headers['webhook-id']));
    expect(ids.size).toBe(1);
  });

  it('does not follow redirects', async () => {
    await create({ url: endpoint.url, events: ['timeline.published'] });
    endpoint.status.code = 302;
    endpoint.status.location = 'http://169.254.169.254/latest/meta-data';
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: {},
    });
    await drain();
    expect(endpoint.received).toHaveLength(1);
    const [delivery] = await ctx.database.db.select().from(webhookDeliveries);
    expect(delivery?.lastError).toContain('Redirects are not followed');
  });

  it('sends test pings and rotates secrets', async () => {
    const hook = (await create({ url: endpoint.url, events: ['draft.updated'] })).json<{
      id: string;
      secret: string;
    }>();
    const rotated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}/rotate-secret`,
      headers: owner.auth,
    });
    const { secret } = rotated.json<{ secret: string }>();
    expect(secret).not.toBe(hook.secret);
    const ping = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}/test`,
      headers: owner.auth,
    });
    expect(ping.statusCode).toBe(202);
    await drain();
    const [req] = endpoint.received;
    if (!req) throw new Error('no ping');
    expect(JSON.parse(req.body)).toMatchObject({ type: 'ping' });
    expect(verify(secret, req)).toBe(true);
    expect(verify(hook.secret, req)).toBe(false);

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}/webhooks/${hook.id}`,
      headers: owner.auth,
    });
    expect(del.statusCode).toBe(204);
  });
});

describe('webhook URL policy and signing', () => {
  const strict = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

  it('allows only public https URLs by default', () => {
    expect(checkWebhookUrl(strict, 'https://hooks.example.com/x#frag')).toBe(
      'https://hooks.example.com/x',
    );
    for (const bad of [
      'http://hooks.example.com/x',
      'https://localhost/x',
      'https://api.localhost/x',
      'https://printer.local/x',
      'https://db.internal/x',
      'https://127.0.0.1/x',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://169.254.169.254/x',
      'https://user:pass@hooks.example.com/x',
      'ftp://hooks.example.com/x',
      'not a url',
    ]) {
      expect(() => checkWebhookUrl(strict, bad), bad).toThrow();
    }
  });

  it('refuses to allow private webhook URLs in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        JWT_SECRET: 'x'.repeat(40),
        PUBLIC_URL: 'https://chronicle.example',
        WEBHOOK_ALLOW_PRIVATE_URLS: 'true',
      }),
    ).toThrow(/WEBHOOK_ALLOW_PRIVATE_URLS/);
  });

  it('matches the Standard Webhooks reference signature', () => {
    // Test vector from the Standard Webhooks specification.
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const body = '{"test": 2432232314}';
    expect(signPayload(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, body)).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });

  it('encrypts secrets with authenticated encryption', () => {
    const stored = encryptSecret(strict, 'whsec_abc');
    expect(decryptSecret(strict, stored)).toBe('whsec_abc');
    const [v, iv, data, tag] = stored.split('.');
    const tampered = [v, iv, Buffer.from('x').toString('base64') + (data ?? ''), tag].join('.');
    expect(() => decryptSecret(strict, tampered)).toThrow();
  });
});

describe('webhook delivery SSRF protection', () => {
  it('blocks hosts that resolve to private addresses at delivery time', async () => {
    const ctx = await createTestServer({ WEBHOOK_WORKER: 'false' });
    try {
      const owner = await signUp(ctx.app, 'Owner');
      const project = await createProject(ctx.app, owner);
      // Bypass the creation check, as if DNS changed after the webhook was saved.
      await ctx.database.db.insert(webhooks).values({
        projectId: project.id,
        url: 'https://localhost:8443/hook',
        events: ['timeline.published'],
        secretEncrypted: encryptSecret(ctx.config, 'whsec_c2VjcmV0'),
      });
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/revisions`,
        headers: owner.auth,
        payload: {},
      });
      await new Promise((r) => setTimeout(r, 50));
      await ctx.app.ctx.webhooks.runOnce();
      const [delivery] = await ctx.database.db.select().from(webhookDeliveries);
      expect(delivery?.status).toBe('pending');
      expect(delivery?.lastError).toBe('The URL resolves to a private network address');
    } finally {
      await ctx.close();
    }
  });
});
