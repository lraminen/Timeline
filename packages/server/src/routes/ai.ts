import type { FastifyPluginAsync } from 'fastify';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import {
  AiProviderError,
  detectDeterministicConflicts,
  detectTimelineConflicts,
  extractEventsFromDocument,
  normalizeNaturalDate,
  normalizeNaturalDateDeterministic,
  suggestEventSummary,
  suggestImageAltText,
} from '@chronicle/ai';
import { extractTextFromBuffer, fetchDocumentFromUrl } from '@chronicle/ai/documents';
import { requireAuth } from '../app.js';
import { ApiError, badRequest, parse } from '../http.js';
import { assertSafeKey } from '../media/storage.js';
import { requireProjectRole } from '../services/access.js';
import {
  checkAiQuota,
  getAiStatusSummary,
  recordAiUsage,
  requireAiProvider,
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
  imageDataUrl: z.string().min(1).max(6_000_000).optional(),
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

function handleAiError(err: unknown): never {
  if (err instanceof ApiError) throw err;
  if (err instanceof AiProviderError) {
    throw new ApiError(502, 'ai_provider_error', err.message);
  }
  throw err;
}

export const aiRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, storage, aiProvider } = app.ctx;

  app.get('/ai/status', async (request) => {
    const { userId } = requireAuth(request);
    return getAiStatusSummary(db, config, userId, aiProvider);
  });

  app.post('/ai/extract', async (request) => {
    const { userId } = requireAuth(request);
    const provider = requireAiProvider(aiProvider);
    await checkAiQuota(db, config, userId);

    const maxBytes = config.AI_MAX_DOCUMENT_KB * 1024;
    let text = '';
    let documentTitle: string | undefined;
    let projectId: string | undefined;

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
      try {
        const extracted = extractTextFromBuffer(buf, {
          filename: part.filename,
          mimeType: part.mimetype,
        });
        text = extracted.text;
        documentTitle ??= extracted.title;
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : 'Could not read uploaded document');
      }
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
        text = body.text;
      } else if (body.url) {
        if (!config.AI_ALLOW_URL_FETCH) {
          throw badRequest('Fetching URLs for AI extraction is disabled on this server');
        }
        try {
          const fetched = await fetchDocumentFromUrl(body.url, {
            fetch: app.ctx.fetch,
            maxBytes,
          });
          text = fetched.text;
          documentTitle ??= fetched.title;
        } catch (err) {
          throw badRequest(err instanceof Error ? err.message : 'Failed to fetch URL');
        }
      } else {
        throw badRequest('Provide either "text", "url", or upload a document file');
      }
    }

    if (!text.trim()) {
      throw badRequest('The document contains no extractable text');
    }

    try {
      const result = await extractEventsFromDocument(text, provider, { documentTitle });
      await recordAiUsage(db, {
        userId,
        projectId,
        operation: 'extract',
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      });
      await audit(
        db,
        {
          action: 'ai.extract',
          actorId: userId,
          projectId: projectId ?? null,
          ip: request.ip,
          metadata: {
            eventsExtracted: result.events.length,
            totalChunks: result.totalChunks,
            tokens: result.usage.totalTokens,
          },
        },
        request.log,
      );
      return result;
    } catch (err) {
      handleAiError(err);
    }
  });

  app.post('/ai/summarize', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(SummarizeBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'editor');
    }
    const provider = requireAiProvider(aiProvider);
    await checkAiQuota(db, config, userId);

    try {
      const result = await suggestEventSummary(
        {
          eventId: body.eventId,
          title: body.title,
          body: body.body,
          maxLength: body.maxLength,
        },
        provider,
      );
      await recordAiUsage(db, {
        userId,
        projectId: body.projectId,
        operation: 'summarize',
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      });
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
    } catch (err) {
      handleAiError(err);
    }
  });

  app.post('/ai/alt-text', async (request) => {
    const { userId } = requireAuth(request);
    const body = parse(AltTextBody, request.body);
    if (body.projectId) {
      await requireProjectRole(db, body.projectId, userId, 'editor');
    }
    const provider = requireAiProvider(aiProvider);
    await checkAiQuota(db, config, userId);

    let imageBase64: string;
    let mimeType: string;

    if (body.imageDataUrl) {
      const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(
        body.imageDataUrl.trim(),
      );
      if (!m?.[1] || !m[2]) {
        throw badRequest('imageDataUrl must be a base64-encoded PNG, JPEG, WebP, or GIF image');
      }
      mimeType = m[1].toLowerCase();
      imageBase64 = m[2];
    } else if (body.imageUrl) {
      const maxImageBytes = 5 * 1024 * 1024;
      let buf: Buffer;

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
        buf = await streamToBuffer(obj.body, maxImageBytes);
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
        if (!res.ok) throw badRequest(`Could not fetch image (HTTP ${String(res.status)})`);
        const arr = await res.arrayBuffer();
        if (arr.byteLength > maxImageBytes) throw badRequest('Image exceeds 5 MB limit');
        buf = Buffer.from(arr);
      }

      const detected = await fileTypeFromBuffer(buf);
      if (!detected || !ALLOWED_VISION_MIMES.has(detected.mime)) {
        throw badRequest('Image format not supported for AI alt-text generation');
      }
      mimeType = detected.mime;
      imageBase64 = buf.toString('base64');
    } else {
      throw badRequest('Provide imageUrl or imageDataUrl');
    }

    try {
      const result = await suggestImageAltText(
        {
          imageBase64,
          mimeType,
          eventTitle: body.eventTitle,
          caption: body.caption,
        },
        provider,
      );
      await recordAiUsage(db, {
        userId,
        projectId: body.projectId,
        operation: 'alt_text',
        provider: result.provider,
        model: result.model,
        usage: result.usage,
      });
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
    } catch (err) {
      handleAiError(err);
    }
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

    await checkAiQuota(db, config, userId);
    try {
      const result = await normalizeNaturalDate(body.text, aiProvider);
      if (result.usage) {
        await recordAiUsage(db, {
          userId,
          projectId: body.projectId,
          operation: 'normalize_date',
          provider: aiProvider.name,
          model: aiProvider.model,
          usage: result.usage,
        });
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
    } catch (err) {
      handleAiError(err);
    }
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

    await checkAiQuota(db, config, userId);
    try {
      const result = await detectTimelineConflicts(timeline, aiProvider);
      if (result.usage) {
        await recordAiUsage(db, {
          userId,
          projectId: body.projectId,
          operation: 'detect_conflicts',
          provider: aiProvider.name,
          model: aiProvider.model,
          usage: result.usage,
        });
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
    } catch (err) {
      handleAiError(err);
    }
  });
};
