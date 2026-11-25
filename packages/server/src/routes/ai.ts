import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import {
  AiProviderError,
  detectDeterministicConflicts,
  detectTimelineConflicts,
  emptyUsage,
  extractEventsFromDocument,
  mergeUsage,
  normalizeNaturalDate,
  normalizeNaturalDateDeterministic,
  suggestEventSummary,
  suggestImageAltText,
  type AiProvider,
  type AiUsage,
} from '@chronicle/ai';
import {
  DocumentParserBusyError,
  extractTextFromBuffer,
  fetchDocumentFromUrl,
  readResponseBytesWithLimit,
} from '@chronicle/ai/documents';
import { requireAuth } from '../app.js';
import { ApiError, badRequest, parse } from '../http.js';
import { assertSafeKey } from '../media/storage.js';
import { requireProjectRole } from '../services/access.js';
import {
  getAiStatusSummary,
  requireAiProvider,
  reserveAiUsage,
  settleAiUsage,
  type AiOperation,
} from '../services/ai.js';
import { audit } from '../services/audit.js';
import { validateDocument } from '../services/documents.js';

const ExtractJsonBody = z.object({
  text: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  documentTitle: z.string().trim().max(200).optional(),
  projectId: z.string().uuid().optional(),
});

const SummarizeBody = z.object({
  eventId: z.string().max(200).optional(),
  projectId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(50_000),
  maxLength: z.number().int().min(80).max(600).optional(),
});

const AltTextBody = z.object({
  projectId: z.string().uuid().optional(),
  imageUrl: z.string().min(1).max(2048).optional(),
  imageDataUrl: z.string().min(1).max(7_000_000).optional(),
  eventTitle: z.string().trim().max(300).optional(),
  caption: z.string().trim().max(500).optional(),
});

const NormalizeDateBody = z.object({
  projectId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(200),
  useLlm: z.boolean().default(true),
});

const DetectConflictsBody = z.object({
  projectId: z.string().uuid().optional(),
  timeline: z.unknown(),
  includeSemantic: z.boolean().default(true),
});

const ALLOWED_VISION_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_VISION_IMAGE_BYTES = 5 * 1024 * 1024;

async function streamToBuffer(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw badRequest('Image exceeds maximum allowed size');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function mapAiError(err: unknown, log: FastifyBaseLogger): unknown {
  if (err instanceof ApiError) return err;
  if (err instanceof AiProviderError) {
    log.warn({ provider: err.provider, status: err.status, detail: err.detail }, err.message);
    const statusCode = err.status === 504 ? 504 : 502;
    return new ApiError(statusCode, 'ai_provider_error', err.message);
  }
  return err;
}

/** Maps a document parse or fetch failure to a client-facing API error. */
function sourceLoadError(err: unknown, kind: 'file' | 'text' | 'url'): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof DocumentParserBusyError) {
    return new ApiError(503, 'parser_busy', err.message);
  }
  if (kind === 'url') {
    const cause = (err as { cause?: { code?: string } } | null)?.cause;
    if (cause?.code === 'ESSRFBLOCKED') {
      return badRequest('URL resolves to a disallowed or unresolvable address');
    }
    return badRequest(err instanceof Error ? err.message : 'Failed to fetch URL');
  }
  return badRequest(err instanceof Error ? err.message : 'Could not read uploaded document');
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, storage, aiProvider } = app.ctx;

  async function withReservedAi<T>(
    params: {
      userId: string;
      projectId?: string;
      operation: AiOperation;
      provider: AiProvider;
      log: FastifyBaseLogger;
    },
    run: (trackUsage: (usage: AiUsage) => void) => Promise<{ result: T; usage?: AiUsage }>,
  ): Promise<T> {
    const reservationId = await reserveAiUsage(db, config, {
      userId: params.userId,
      projectId: params.projectId,
      operation: params.operation,
      provider: params.provider.name,
      model: params.provider.model,
    });

    let accumulated = emptyUsage();
    let finalUsage: AiUsage | undefined;
    let succeeded = false;

    try {
      const { result, usage } = await run((chunkUsage) => {
        accumulated = mergeUsage(accumulated, chunkUsage);
      });
      finalUsage = usage ?? accumulated;
      succeeded = true;
      return result;
    } catch (err) {
      throw mapAiError(err, params.log);
    } finally {
      await settleAiUsage(db, reservationId, {
        status: succeeded ? 'completed' : 'failed',
        provider: params.provider.name,
        model: params.provider.model,
        usage: finalUsage ?? accumulated,
      }).catch((settleErr: unknown) => {
        params.log.error({ err: settleErr, reservationId }, 'Failed to settle AI usage row');
      });
    }
  }

  app.get('/ai/status', async (request) => {
    const { userId } = requireAuth(request);
    return getAiStatusSummary(db, config, userId, aiProvider);
  });

  app.post('/ai/extract', async (request) => {
    const { userId } = requireAuth(request);
    const provider = requireAiProvider(aiProvider);

    const maxBytes = config.AI_MAX_DOCUMENT_KB * 1024;
    let documentTitle: string | undefined;
    let projectId: string | undefined;
    /**
     * Parsing and URL fetching are deferred until a quota reservation is held, so the
     * daily quota and the per-user in-flight cap also bound parser CPU, memory and fetches.
     */
    let loadSource: () => Promise<{ text: string; title?: string }>;
    let sourceKind: 'file' | 'text' | 'url';

    if (request.isMultipart()) {
      const part = await request.file();
      if (!part) throw badRequest('No document file received');
      const fields = part.fields as Record<string, { value?: string } | undefined>;
      const rawProjectId = fields.projectId?.value;
      const rawTitle = fields.documentTitle?.value;
      if (rawProjectId) {
        projectId = parse(z.string().uuid(), rawProjectId, 'projectId');
        await requireProjectRole(db, projectId, userId, 'editor');
      }
      if (rawTitle?.trim()) documentTitle = rawTitle.trim().slice(0, 200);

      const buf = await part.toBuffer();
      if (buf.length > maxBytes) {
        throw new ApiError(
          413,
          'payload_too_large',
          `Document exceeds ${String(config.AI_MAX_DOCUMENT_KB)} KB limit`,
        );
      }
      const { filename, mimetype } = part;
      sourceKind = 'file';
      loadSource = () => extractTextFromBuffer(buf, { filename, mimeType: mimetype });
    } else {
      const body = parse(ExtractJsonBody, request.body);
      if (body.projectId) {
        projectId = body.projectId;
        await requireProjectRole(db, projectId, userId, 'editor');
      }
      documentTitle = body.documentTitle;

      if (body.text) {
        if (Buffer.byteLength(body.text, 'utf8') > maxBytes) {
          throw new ApiError(
            413,
            'payload_too_large',
            `Text exceeds ${String(config.AI_MAX_DOCUMENT_KB)} KB limit`,
          );
        }
        const pasted = body.text;
        sourceKind = 'text';
        loadSource = () => Promise.resolve({ text: pasted });
      } else if (body.url) {
        if (!config.AI_ALLOW_URL_FETCH) {
          throw badRequest('Fetching URLs for AI extraction is disabled on this server');
        }
        const url = body.url;
        sourceKind = 'url';
        loadSource = () =>
          fetchDocumentFromUrl(url, {
            fetch: app.ctx.fetch === fetch ? undefined : app.ctx.fetch,
            maxBytes,
          });
      } else {
        throw badRequest('Provide either "text", "url", or upload a document file');
      }
    }

    const result = await withReservedAi(
      { userId, projectId, operation: 'extract', provider, log: request.log },
      async (trackUsage) => {
        const loaded = await loadSource().catch((err: unknown) => {
          throw sourceLoadError(err, sourceKind);
        });
        documentTitle ??= loaded.title;
        const text = loaded.text;
        if (!text.trim()) {
          throw badRequest('The document contains no extractable text');
        }
        const extracted = await extractEventsFromDocument(text, provider, {
          documentTitle,
          onChunkUsage: trackUsage,
        });
        return { result: extracted, usage: extracted.usage };
      },
    );

    await audit(
      db,
      {
        action: 'ai.extract',
        actorId: userId,
        projectId: projectId ?? null,
        ip: request.ip,
        metadata: {
          eventsExtracted: result.events.length,
          droppedEvents: result.droppedEvents ?? 0,
          totalChunks: result.totalChunks,
          tokens: result.usage.totalTokens,
        },
      },
      request.log,
    );
    return result;
  });

  app.post('/ai/summarize', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(SummarizeBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'editor');
    }
    const provider = requireAiProvider(aiProvider);

    const result = await withReservedAi(
      { userId, projectId: body.projectId, operation: 'summarize', provider, log: request.log },
      async () => {
        const res = await suggestEventSummary(
          {
            eventId: body.eventId,
            title: body.title,
            body: body.body,
            maxLength: body.maxLength,
          },
          provider,
        );
        return { result: res, usage: res.usage };
      },
    );

    await audit(
      db,
      {
        action: 'ai.summarize',
        actorId: userId,
        projectId: body.projectId ?? null,
        ip: request.ip,
        metadata: { tokens: result.usage.totalTokens },
      },
      request.log,
    );
    return result;
  });

  app.post('/ai/alt-text', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(AltTextBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'editor');
    }
    const provider = requireAiProvider(aiProvider);

    let buf: Buffer;
    if (body.imageDataUrl) {
      const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(
        body.imageDataUrl.trim(),
      );
      if (!m?.[1]) {
        throw badRequest('imageDataUrl must be a base64-encoded image data URL');
      }
      buf = Buffer.from(m[1], 'base64');
      if (buf.length === 0 || buf.length > MAX_VISION_IMAGE_BYTES) {
        throw badRequest('Image exceeds 5 MB limit');
      }
    } else if (body.imageUrl) {
      // Support locally stored media keys (`/media/projects/...` or `${publicUrl}/media/...`)
      const mediaPrefix = `${config.publicUrl}/media/`;
      const localKey = body.imageUrl.startsWith('/media/')
        ? body.imageUrl.slice('/media/'.length)
        : body.imageUrl.startsWith(mediaPrefix)
          ? body.imageUrl.slice(mediaPrefix.length)
          : null;

      if (localKey) {
        try {
          assertSafeKey(localKey);
        } catch {
          throw badRequest('Invalid local media URL');
        }
        const obj = await storage.get(localKey);
        if (!obj) throw badRequest('Referenced media file not found');
        buf = await streamToBuffer(obj.body, MAX_VISION_IMAGE_BYTES);
      } else {
        let parsed: URL;
        try {
          parsed = new URL(body.imageUrl);
        } catch {
          throw badRequest('Invalid imageUrl');
        }
        if (parsed.protocol !== 'https:') {
          throw badRequest('External imageUrl must use https://');
        }
        const allow = new Set(config.MEDIA_PROXY_HOSTS.map((h) => h.toLowerCase()));
        if (!allow.has(parsed.hostname.toLowerCase())) {
          throw badRequest(
            'External image host is not in MEDIA_PROXY_HOSTS; upload the image instead.',
          );
        }
        const res = await app.ctx.fetch(parsed.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          throw badRequest('Redirects are not allowed when fetching images');
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw badRequest(`Could not fetch image (HTTP ${String(res.status)})`);
        }
        try {
          buf = await readResponseBytesWithLimit(res, MAX_VISION_IMAGE_BYTES);
        } catch {
          throw badRequest('Image exceeds 5 MB limit');
        }
      }
    } else {
      throw badRequest('Provide imageUrl or imageDataUrl');
    }

    const detected = await fileTypeFromBuffer(buf);
    if (!detected || !ALLOWED_VISION_MIMES.has(detected.mime)) {
      throw badRequest('Image format not supported for AI alt-text generation');
    }
    const mimeType = detected.mime;
    const imageBase64 = buf.toString('base64');

    const result = await withReservedAi(
      { userId, projectId: body.projectId, operation: 'alt_text', provider, log: request.log },
      async () => {
        const res = await suggestImageAltText(
          {
            imageBase64,
            mimeType,
            eventTitle: body.eventTitle,
            caption: body.caption,
          },
          provider,
        );
        return { result: res, usage: res.usage };
      },
    );

    await audit(
      db,
      {
        action: 'ai.alt_text',
        actorId: userId,
        projectId: body.projectId ?? null,
        ip: request.ip,
        metadata: { tokens: result.usage.totalTokens },
      },
      request.log,
    );
    return result;
  });

  app.post('/ai/normalize-date', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(NormalizeDateBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'editor');
    }

    const det = normalizeNaturalDateDeterministic(body.text);
    if (det.date && det.confidence >= 0.8) {
      return det;
    }

    if (!body.useLlm || !aiProvider) {
      return det;
    }

    const result = await withReservedAi(
      {
        userId,
        projectId: body.projectId,
        operation: 'normalize_date',
        provider: aiProvider,
        log: request.log,
      },
      async () => {
        const res = await normalizeNaturalDate(body.text, aiProvider);
        return { result: res, usage: res.usage };
      },
    );

    if (result.usage) {
      await audit(
        db,
        {
          action: 'ai.normalize_date',
          actorId: userId,
          projectId: body.projectId ?? null,
          ip: request.ip,
          metadata: { tokens: result.usage.totalTokens },
        },
        request.log,
      );
    }
    return result;
  });

  app.post('/ai/detect-conflicts', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(DetectConflictsBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'viewer');
    }
    const timeline = validateDocument(body.timeline);

    if (!body.includeSemantic || !aiProvider) {
      return {
        conflicts: detectDeterministicConflicts(timeline),
        aiGenerated: false,
      };
    }

    const result = await withReservedAi(
      {
        userId,
        projectId: body.projectId,
        operation: 'detect_conflicts',
        provider: aiProvider,
        log: request.log,
      },
      async () => {
        const res = await detectTimelineConflicts(timeline, aiProvider);
        return { result: res, usage: res.usage };
      },
    );

    if (result.usage) {
      await audit(
        db,
        {
          action: 'ai.detect_conflicts',
          actorId: userId,
          projectId: body.projectId ?? null,
          ip: request.ip,
          metadata: {
            conflictCount: result.conflicts.length,
            tokens: result.usage.totalTokens,
          },
        },
        request.log,
      );
    }
    return result;
  });
};
