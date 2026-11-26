import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { AiProvider } from '@chronicle/ai';
import type { Config } from './config.js';
import type { Database, Db } from './db/client.js';
import { ApiError, unauthorized } from './http.js';
import { isApiKeyFormat, verifyAccessToken, verifyApiKey } from './auth/sessions.js';
import {
  createStorage,
  noopInvalidator,
  type CdnInvalidator,
  type Storage,
} from './media/storage.js';
import { ClamdScanner, noopScanner, type Scanner } from './media/scanner.js';
import { buildAiProviderFromConfig } from './services/ai.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { revisionRoutes } from './routes/revisions.js';
import { collaboratorRoutes } from './routes/collaborators.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { mediaRoutes } from './routes/media.js';
import { publicRoutes } from './routes/public.js';
import { pageRoutes } from './routes/pages.js';
import { aiRoutes } from './routes/ai.js';
import { collabRoutes } from './routes/collab.js';
import { commentRoutes } from './routes/comments.js';
import { webhookRoutes } from './routes/webhooks.js';
import { exportRoutes } from './routes/export.js';
import { CollabService } from './services/collab.js';
import { WebhookService } from './services/webhooks.js';

export interface AuthContext {
  userId: string;
  via: 'session' | 'api_key';
  apiKeyId?: string;
}

export interface AppContext {
  config: Config;
  db: Db;
  storage: Storage;
  scanner: Scanner;
  cdn: CdnInvalidator;
  aiProvider: AiProvider | null;
  /** Injectable for tests; used by the media proxy and AI URL fetch. */
  fetch: typeof fetch;
  /** Real-time collaboration rooms; every draft change goes through here. */
  collab: CollabService;
  webhooks: WebhookService;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface AppOptions {
  config: Config;
  database: Database;
  storage?: Storage;
  scanner?: Scanner;
  cdn?: CdnInvalidator;
  aiProvider?: AiProvider | null;
  fetch?: typeof fetch;
  /** Injectable for tests: how webhook requests are sent (default: SSRF-safe fetch). */
  webhookFetch?: typeof fetch;
  logger?: boolean;
}

/** Returns the authenticated user or throws 401. */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

const PUBLIC_CORS_PREFIXES = ['/api/v1/embed/', '/api/v1/media-proxy', '/media/'];

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, database } = options;
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    // Timelines may embed small media as data URLs.
    bodyLimit: 20 * 1024 * 1024,
    logger:
      options.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
            ],
          },
  });

  const fetchFn = options.fetch ?? fetch;
  const webhookService = new WebhookService(database.db, config, app.log, options.webhookFetch);
  const collabService = new CollabService({
    db: database.db,
    maxDocBytes: config.COLLAB_MAX_DOC_MB * 1024 * 1024,
    draftSaveMs: config.COLLAB_DRAFT_SAVE_MS,
    pollMs: config.COLLAB_POLL_MS ?? (database.driver === 'postgres' ? 1000 : 0),
    compactEvery: config.COLLAB_COMPACT_EVERY,
    log: app.log,
    onDraftSaved: (projectId, saved) => {
      webhookService.draftUpdated(projectId, saved);
    },
  });
  app.decorate('ctx', {
    config,
    db: database.db,
    storage: options.storage ?? createStorage(config),
    scanner:
      options.scanner ??
      (config.CLAMAV_ADDRESS ? ClamdScanner.fromAddress(config.CLAMAV_ADDRESS) : noopScanner),
    cdn: options.cdn ?? noopInvalidator,
    aiProvider:
      options.aiProvider !== undefined
        ? options.aiProvider
        : buildAiProviderFromConfig(config, fetchFn),
    fetch: fetchFn,
    collab: collabService,
    webhooks: webhookService,
  } satisfies AppContext);
  // Save open collaborative documents and stop the webhook worker on shutdown.
  app.addHook('onClose', async () => {
    await collabService.close();
    await webhookService.stop();
  });
  app.decorateRequest('auth', null);

  // --- Security headers. API/JSON default: nothing may load or frame it.
  // Page and media routes set their own CSP / CORP.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    strictTransportSecurity: config.isProduction,
  });

  // --- CORS: the editor's origins (with credentials) for the API; embed
  // origins (no credentials) for public data and media.
  const editorOrigins = new Set(config.CORS_ORIGINS);
  const embedAny = config.EMBED_ORIGINS.includes('*');
  const embedOrigins = new Set(config.EMBED_ORIGINS);
  await app.register(cors, {
    delegator: (req, cb) => {
      const origin = req.headers.origin;
      const url = req.url;
      if (PUBLIC_CORS_PREFIXES.some((p) => url.startsWith(p))) {
        cb(null, {
          origin: embedAny ? '*' : origin && embedOrigins.has(origin) ? origin : false,
          credentials: false,
          methods: ['GET', 'HEAD'],
        });
        return;
      }
      cb(null, {
        origin: origin && editorOrigins.has(origin) ? origin : false,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'X-API-Key'],
        exposedHeaders: ['ETag'],
        maxAge: 600,
      });
    },
  });

  await app.register(cookie);
  await app.register(websocket, {
    // Room for one frame carrying a whole document; the room enforces the exact limit.
    options: { maxPayload: Math.ceil(config.COLLAB_MAX_DOC_MB * 1024 * 1024 * 1.1) + 65_536 },
  });
  await app.register(multipart, {
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 },
  });

  // --- Authentication (before rate limiting, so limits can be per user).
  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];
    const credential =
      typeof apiKeyHeader === 'string'
        ? apiKeyHeader
        : header?.startsWith('Bearer ')
          ? header.slice(7).trim()
          : null;
    if (!credential) return;

    if (isApiKeyFormat(credential)) {
      const key = await verifyApiKey(app.ctx.db, credential);
      if (!key) throw unauthorized('Invalid or revoked API key');
      request.auth = { userId: key.userId, via: 'api_key', apiKeyId: key.keyId };
      return;
    }
    const userId = await verifyAccessToken(config, credential);
    // A present-but-invalid credential is an error, never silently anonymous.
    if (!userId) throw unauthorized('Invalid or expired access token');
    request.auth = { userId, via: 'session' };
  });

  await app.register(rateLimit, {
    hook: 'preHandler',
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.auth?.userId ?? request.ip,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: { code: 'rate_limited', message: `Too many requests; retry in ${context.after}` },
    }),
  });

  // --- Errors: one JSON shape; internals are logged, never returned.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'bad_request', message: 'Invalid request', details: error.issues },
      });
    }
    const status = error.statusCode ?? 500;
    if (status === 429) return reply.status(429).send(error);
    if (status < 500) {
      const code =
        status === 413
          ? 'payload_too_large'
          : status === 415
            ? 'unsupported_media_type'
            : 'bad_request';
      return reply.status(status).send({ error: { code, message: error.message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  app.get('/healthz', async () => {
    await app.ctx.db.execute('select 1');
    return { status: 'ok', database: database.driver };
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(projectRoutes);
      await api.register(revisionRoutes);
      await api.register(collaboratorRoutes);
      await api.register(apiKeyRoutes);
      await api.register(mediaRoutes);
      await api.register(publicRoutes);
      await api.register(aiRoutes);
      await api.register(collabRoutes);
      await api.register(commentRoutes);
      await api.register(webhookRoutes);
      await api.register(exportRoutes);
    },
    { prefix: '/api/v1' },
  );
  await app.register(pageRoutes);

  if (config.WEBHOOK_WORKER) webhookService.start();
  return app;
}
