import { and, eq, gte, sql } from 'drizzle-orm';
import { createAiProvider, emptyUsage, type AiProvider, type AiUsage } from '@chronicle/ai';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { aiUsage } from '../db/schema.js';
import { ApiError } from '../http.js';

export type AiOperation =
  'extract' | 'summarize' | 'alt_text' | 'normalize_date' | 'detect_conflicts';

/**
 * A `pending` row older than this no longer counts as in flight (its request is
 * assumed to have died without settling). It must outlast the slowest request:
 * a worst-case extraction is a 15 s URL fetch, a 10 s parse (plus any queue wait)
 * and 12 chunks × 30 s provider timeout, about 6.5 minutes. 15 minutes leaves room.
 */
const STALE_PENDING_MS = 15 * 60 * 1000;
const userReservationChains = new Map<string, Promise<unknown>>();

/**
 * Serialises reservations for one user inside this process, so concurrent
 * requests queue in memory instead of each holding a pooled connection while
 * they wait for the database lock. The advisory lock in `reserveAiUsage` is what
 * makes reservations safe across several server instances.
 */
function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = userReservationChains.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  userReservationChains.set(userId, tail);
  void tail.finally(() => {
    if (userReservationChains.get(userId) === tail) {
      userReservationChains.delete(userId);
    }
  });
  return next;
}

export function buildAiProviderFromConfig(
  config: Config,
  fetchFn: typeof fetch = fetch,
): AiProvider | null {
  if (config.AI_PROVIDER === 'none') return null;
  return createAiProvider({
    provider: config.AI_PROVIDER,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    baseUrl: config.AI_BASE_URL,
    fetch: fetchFn,
  });
}

export function requireAiProvider(provider: AiProvider | null): AiProvider {
  if (!provider) {
    throw new ApiError(
      503,
      'ai_not_configured',
      'AI features are not enabled on this server (set AI_PROVIDER and credentials).',
    );
  }
  return provider;
}

function utcDayStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function getTodayUsage(
  db: Db,
  userId: string,
): Promise<{ requests: number; tokens: number; costMicros: number }> {
  const since = utcDayStart();
  const [row] = await db
    .select({
      requests: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::int`,
      costMicros: sql<number>`coalesce(sum(${aiUsage.estimatedCostMicros}), 0)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.userId, userId), gte(aiUsage.createdAt, since)));

  return {
    requests: row?.requests ?? 0,
    tokens: row?.tokens ?? 0,
    costMicros: row?.costMicros ?? 0,
  };
}

/**
 * Checks in-flight concurrency and the daily request/token quotas for a user,
 * then inserts a `pending` reservation row up front so concurrent bursts cannot
 * bypass the limits. The check and insert run in one transaction holding a
 * per-user Postgres advisory lock, so they are atomic across server instances.
 */
export function reserveAiUsage(
  db: Db,
  config: Config,
  entry: {
    userId: string;
    projectId?: string | null;
    operation: AiOperation;
    provider: string;
    model: string;
  },
): Promise<string> {
  return withUserLock(entry.userId, () =>
    db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ai_usage:${entry.userId}`}))`);
      const staleCutoff = new Date(Date.now() - STALE_PENDING_MS);
      const [pendingRow] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.userId, entry.userId),
            eq(aiUsage.status, 'pending'),
            gte(aiUsage.createdAt, staleCutoff),
          ),
        );
      const inFlight = pendingRow?.count ?? 0;
      if (inFlight >= config.AI_MAX_CONCURRENT_PER_USER) {
        throw new ApiError(
          429,
          'ai_concurrent_limit',
          `Too many concurrent AI requests (${String(config.AI_MAX_CONCURRENT_PER_USER)} max in flight).`,
        );
      }

      const today = await getTodayUsage(tx, entry.userId);
      if (today.requests >= config.AI_DAILY_REQUEST_LIMIT) {
        throw new ApiError(
          429,
          'ai_quota_exceeded',
          `Daily AI request limit (${String(config.AI_DAILY_REQUEST_LIMIT)}) reached.`,
        );
      }
      if (today.tokens >= config.AI_DAILY_TOKEN_LIMIT) {
        throw new ApiError(
          429,
          'ai_quota_exceeded',
          `Daily AI token budget (${String(config.AI_DAILY_TOKEN_LIMIT)}) reached.`,
        );
      }

      const [inserted] = await tx
        .insert(aiUsage)
        .values({
          userId: entry.userId,
          projectId: entry.projectId ?? null,
          operation: entry.operation,
          provider: entry.provider,
          model: entry.model,
          status: 'pending',
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicros: 0,
        })
        .returning({ id: aiUsage.id });

      if (!inserted) {
        throw new Error('Failed to insert AI usage reservation row');
      }
      return inserted.id;
    }),
  );
}

export async function settleAiUsage(
  db: Db,
  reservationId: string,
  settlement: {
    status: 'completed' | 'failed';
    provider?: string;
    model?: string;
    usage?: AiUsage;
  },
): Promise<void> {
  const usage = settlement.usage ?? emptyUsage();
  await db
    .update(aiUsage)
    .set({
      status: settlement.status,
      ...(settlement.provider ? { provider: settlement.provider } : {}),
      ...(settlement.model ? { model: settlement.model } : {}),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostMicros: usage.estimatedCostMicros,
    })
    .where(eq(aiUsage.id, reservationId));
}

export async function getAiStatusSummary(
  db: Db,
  config: Config,
  userId: string,
  provider: AiProvider | null,
) {
  const today = await getTodayUsage(db, userId);
  return {
    configured: provider !== null,
    provider: provider?.name ?? null,
    model: provider?.model ?? null,
    supportsVision: provider?.supportsVision ?? false,
    usageToday: {
      requests: today.requests,
      tokens: today.tokens,
      estimatedCostUsd: Number((today.costMicros / 1_000_000).toFixed(6)),
    },
    limits: {
      dailyRequests: config.AI_DAILY_REQUEST_LIMIT,
      dailyTokens: config.AI_DAILY_TOKEN_LIMIT,
      maxConcurrent: config.AI_MAX_CONCURRENT_PER_USER,
    },
  };
}
