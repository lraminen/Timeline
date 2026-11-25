import { and, gte, sql } from 'drizzle-orm';
import { createAiProvider, type AiProvider, type AiUsage } from '@chronicle/ai';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { aiUsage } from '../db/schema.js';
import { ApiError } from '../http.js';

export type AiOperation =
  | 'extract'
  | 'summarize'
  | 'alt_text'
  | 'normalize_date'
  | 'detect_conflicts';

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
    .where(and(sql`${aiUsage.userId} = ${userId}`, gte(aiUsage.createdAt, since)));

  return {
    requests: row?.requests ?? 0,
    tokens: row?.tokens ?? 0,
    costMicros: row?.costMicros ?? 0,
  };
}

export async function checkAiQuota(db: Db, config: Config, userId: string): Promise<void> {
  const today = await getTodayUsage(db, userId);
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
}

export async function recordAiUsage(
  db: Db,
  entry: {
    userId: string;
    projectId?: string | null;
    operation: AiOperation;
    provider: string;
    model: string;
    usage: AiUsage;
  },
): Promise<void> {
  await db.insert(aiUsage).values({
    userId: entry.userId,
    projectId: entry.projectId ?? null,
    operation: entry.operation,
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.usage.inputTokens,
    outputTokens: entry.usage.outputTokens,
    estimatedCostMicros: entry.usage.estimatedCostMicros,
  });
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
    },
  };
}
