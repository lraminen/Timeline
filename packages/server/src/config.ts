import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    /** Externally visible origin, used in links, OG tags and CORS. */
    PUBLIC_URL: z.string().url().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    TRUST_PROXY: bool.default('false'),

    /** postgres://… — when unset, an embedded PGlite database is used. */
    DATABASE_URL: z.string().optional(),
    /** Directory for the embedded PGlite database; unset = in-memory. */
    DATA_DIR: z.string().optional(),

    /** HMAC key for access tokens and share links. ≥ 32 chars in production. */
    JWT_SECRET: z.string().optional(),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(15 * 60),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    /** Origins allowed to call the API with credentials (e.g. the editor). */
    CORS_ORIGINS: csv.default(''),
    /** Origins allowed to embed public timelines; `*` = anywhere. */
    EMBED_ORIGINS: csv.default('*'),

    STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
    STORAGE_DIR: z.string().default('./storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool.default('false'),
    /** Public base URL for media (CDN). Unset = served by this server. */
    MEDIA_PUBLIC_URL: z.string().url().optional(),
    MAX_UPLOAD_MB: z.coerce.number().positive().default(25),

    /** clamd TCP address (host:port) for upload scanning; unset = no scanning. */
    CLAMAV_ADDRESS: z.string().optional(),
    /** Hostnames the media proxy may fetch from. */
    MEDIA_PROXY_HOSTS: csv.default('upload.wikimedia.org,images.unsplash.com'),

    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),

    /** Pluggable AI provider for Phase 5 assistive workflows. */
    AI_PROVIDER: z.enum(['none', 'openai', 'gemini', 'anthropic', 'ollama']).default('none'),
    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(100),
    AI_DAILY_TOKEN_LIMIT: z.coerce.number().int().positive().default(500_000),
    AI_MAX_CONCURRENT_PER_USER: z.coerce.number().int().positive().default(2),
    AI_MAX_DOCUMENT_KB: z.coerce.number().int().positive().default(1024),
    AI_ALLOW_URL_FETCH: bool.default('false'),

    /** Real-time collaboration (Phase 6). Largest collaborative document, in MB. */
    COLLAB_MAX_DOC_MB: z.coerce.number().positive().default(20),
    COLLAB_MAX_CONNECTIONS_PER_USER: z.coerce.number().int().positive().default(20),
    COLLAB_MAX_CONNECTIONS_PER_PROJECT: z.coerce.number().int().positive().default(100),
    COLLAB_MAX_MESSAGES_PER_SECOND: z.coerce.number().int().positive().default(200),
    /** Delay between the last live edit and saving the JSON draft. */
    COLLAB_DRAFT_SAVE_MS: z.coerce.number().int().nonnegative().default(1000),
    /**
     * How often to pick up edits made through other server instances.
     * Defaults to 1000 with PostgreSQL and 0 (off) with the embedded
     * database, which only one process can open.
     */
    COLLAB_POLL_MS: z.coerce.number().int().nonnegative().optional(),
    /** Fold the update log into the stored snapshot after this many rows. */
    COLLAB_COMPACT_EVERY: z.coerce.number().int().positive().default(200),

    /** Outgoing webhooks. Allows http:// and private/loopback addresses (development only). */
    WEBHOOK_ALLOW_PRIVATE_URLS: bool.default('false'),
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(12).default(8),
    /** At most one `draft.updated` delivery per project per this many seconds. */
    WEBHOOK_DRAFT_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(60),
    /** Run the delivery worker in this process (turn off on API-only instances). */
    WEBHOOK_WORKER: bool.default('true'),
    WEBHOOK_POLL_MS: z.coerce.number().int().positive().default(5000),
  })
  .superRefine((env, ctx) => {
    if (
      (env.AI_PROVIDER === 'openai' ||
        env.AI_PROVIDER === 'gemini' ||
        env.AI_PROVIDER === 'anthropic') &&
      !env.AI_API_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AI_API_KEY'],
        message: `is required when AI_PROVIDER=${env.AI_PROVIDER}`,
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        ctx.addIssue({
          code: 'custom',
          path: ['JWT_SECRET'],
          message: 'must be set to at least 32 random characters in production',
        });
      }
      if (!env.PUBLIC_URL) {
        ctx.addIssue({
          code: 'custom',
          path: ['PUBLIC_URL'],
          message: 'is required in production',
        });
      }
      if (env.WEBHOOK_ALLOW_PRIVATE_URLS) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEBHOOK_ALLOW_PRIVATE_URLS'],
          message: 'must not be enabled in production (it lets webhooks reach internal services)',
        });
      }
    }
    if (env.STORAGE_DRIVER === 's3' && !env.S3_BUCKET) {
      ctx.addIssue({
        code: 'custom',
        path: ['S3_BUCKET'],
        message: 'is required when STORAGE_DRIVER=s3',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface Config extends Env {
  jwtSecret: Uint8Array;
  publicUrl: string;
  isProduction: boolean;
}

/** A fixed development secret; production refuses to start without a real one. */
const DEV_SECRET = 'chronicle-development-secret-not-for-production-use';

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    ...e,
    jwtSecret: new TextEncoder().encode(e.JWT_SECRET ?? DEV_SECRET),
    publicUrl: (e.PUBLIC_URL ?? `http://${e.HOST}:${String(e.PORT)}`).replace(/\/$/, ''),
    isProduction: e.NODE_ENV === 'production',
  };
}
