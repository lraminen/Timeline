import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config.js';
import { media, type MediaVariant } from '../db/schema.js';
import { ApiError, badRequest, notFound, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole } from '../services/access.js';
import { audit } from '../services/audit.js';
import { processUpload } from '../media/process.js';
import { assertSafeKey } from '../media/storage.js';

export function mediaUrl(config: Config, key: string): string {
  const base = config.MEDIA_PUBLIC_URL?.replace(/\/$/, '') ?? `${config.publicUrl}/media`;
  return `${base}/${key}`;
}

const Params = z.object({ id: z.string().uuid(), mediaId: z.string().uuid() });

type MediaRow = typeof media.$inferSelect;

function present(config: Config, row: MediaRow) {
  const variants = Object.fromEntries(
    Object.entries(row.metadata.variants).map(([name, v]: [string, MediaVariant]) => [
      name,
      {
        url: mediaUrl(config, v.key),
        mimeType: v.mimeType,
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
      },
    ]),
  );
  return {
    id: row.id,
    filename: row.filename,
    kind: row.metadata.kind,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.metadata.width,
    height: row.metadata.height,
    /** Primary URL to put in a timeline's media `url`. */
    url: mediaUrl(config, row.storageKey),
    variants,
    createdAt: row.createdAt.toISOString(),
  };
}

export const mediaRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, storage, scanner, cdn } = app.ctx;

  app.get('/projects/:id/media', async (request) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const rows = await db
      .select()
      .from(media)
      .where(eq(media.projectId, id))
      .orderBy(desc(media.createdAt));
    return { media: rows.map((r) => present(config, r)) };
  });

  app.post('/projects/:id/media', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'editor');

    if (!request.isMultipart())
      throw badRequest('Send the file as multipart/form-data in a field named "file"');
    const part = await request.file();
    if (!part) throw badRequest('No file received');
    // Buffers the upload (bounded by MAX_UPLOAD_MB); throws 413 if larger.
    const data = await part.toBuffer();
    const filename = part.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'upload';

    const scan = await scanner.scan(data).catch((err: unknown) => {
      request.log.error({ err }, 'malware scan failed');
      throw new ApiError(
        503,
        'scan_unavailable',
        'Upload scanning is unavailable; try again later',
      );
    });
    if (!scan.clean) {
      await audit(
        db,
        {
          action: 'media.rejected',
          actorId: userId,
          projectId: id,
          ip: request.ip,
          metadata: { filename, signature: scan.signature },
        },
        request.log,
      );
      throw new ApiError(422, 'malware_detected', 'This file was rejected by the malware scanner');
    }

    const processed = await processUpload(data);
    const mediaId = randomUUID();
    const prefix = `projects/${id}/media/${mediaId}`;
    const variants: Record<string, MediaVariant> = {};
    for (const file of processed.files) {
      const key = `${prefix}/${file.name}`;
      assertSafeKey(key);
      await storage.put(key, file.data, file.variant.mimeType);
      variants[
        file.name.replace(/\.(\w+)$/, (_m, ext: string) => (ext === 'avif' ? '_avif' : ''))
      ] = { ...file.variant, key };
    }

    const primary = processed.files.find((f) => f.name === processed.primary);
    const [row] = await db
      .insert(media)
      .values({
        id: mediaId,
        projectId: id,
        uploaderId: userId,
        filename,
        storageKey: `${prefix}/${processed.primary}`,
        mimeType: processed.mimeType,
        sizeBytes: primary?.data.length ?? data.length,
        metadata: { ...processed.metadata, variants },
      })
      .returning();
    if (!row) throw new Error('Media insert returned no row');
    await audit(
      db,
      {
        action: 'media.upload',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { mediaId, filename, mimeType: processed.mimeType },
      },
      request.log,
    );
    return reply.status(201).send(present(config, row));
  });

  app.delete('/projects/:id/media/:mediaId', async (request, reply) => {
    const { id, mediaId } = parse(Params, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'editor');
    const [row] = await db
      .delete(media)
      .where(and(eq(media.id, mediaId), eq(media.projectId, id)))
      .returning();
    if (!row) throw notFound('Media');
    const keys = Object.values(row.metadata.variants).map((v) => v.key);
    await storage.delete(keys);
    await cdn.invalidate(keys);
    await audit(
      db,
      {
        action: 'media.delete',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { mediaId },
      },
      request.log,
    );
    return reply.status(204).send();
  });
};

/**
 * Serves stored media (when no external CDN is configured). Keys contain
 * random UUIDs and are never reused, so responses are cached forever.
 *
 * Note: media URLs are capability URLs — anyone holding one can fetch the
 * file, including media of private timelines.
 */
export const mediaServeRoutes: FastifyPluginAsync = async (app) => {
  const { storage } = app.ctx;

  app.get('/media/*', async (request, reply) => {
    const key = (request.params as { '*': string })['*'];
    try {
      assertSafeKey(key);
    } catch {
      throw notFound('File');
    }
    const object = await storage.get(key);
    if (!object) throw notFound('File');
    void reply
      .header('content-type', object.contentType)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'cross-origin');
    if (object.size !== undefined) void reply.header('content-length', object.size);
    return reply.send(object.body);
  });
};
