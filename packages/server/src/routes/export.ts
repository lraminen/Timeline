import type { FastifyPluginAsync } from 'fastify';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  buildStaticSite,
  siteFolderName,
  StaticExportError,
  zipStaticSite,
  type FetchedMedia,
  type MediaFetcher,
} from '@chronicle/static';
import { projects, revisions } from '../db/schema.js';
import { badRequest, notFound, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole } from '../services/access.js';
import { audit } from '../services/audit.js';
import { assertSafeKey } from '../media/storage.js';
import { mediaUrl } from './media.js';

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const Query = z.object({ version: z.coerce.number().int().positive().optional() });

async function readLimited(stream: AsyncIterable<Uint8Array>, max: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > max) throw new Error('File too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Static site export of a project (draft, or a published version) as a zip:
 * the same self-contained site the CLI makes, for archiving or for hosting
 * anywhere. See @chronicle/static.
 */
export const exportRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, storage, collab } = app.ctx;
  const require = createRequire(import.meta.url);
  const script = readFileSync(require.resolve('@chronicle/web-component/cdn/iife'), 'utf8');
  const proxyHosts = new Set(config.MEDIA_PROXY_HOSTS.map((h) => h.toLowerCase()));

  /**
   * Copies this project's uploads straight from storage, and images from the
   * media-proxy allowlist over https. Nothing else is fetched by the server.
   */
  const fetcher = (projectId: string): MediaFetcher => {
    const ownPrefix = mediaUrl(config, `projects/${projectId}/`);
    return async (raw): Promise<FetchedMedia | null> => {
      const url = new URL(raw, `${config.publicUrl}/`).toString();
      if (url.startsWith(ownPrefix)) {
        // Only this project's own uploads: the key keeps the project prefix.
        const rest = url.slice(ownPrefix.length).split(/[?#]/)[0] ?? '';
        const key = `projects/${projectId}/${rest}`;
        try {
          assertSafeKey(key);
        } catch {
          return null;
        }
        const object = await storage.get(key);
        if (!object) throw new Error('Not found in storage');
        return {
          bytes: await readLimited(object.body, MAX_MEDIA_BYTES),
          mimeType: object.contentType,
        };
      }
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !proxyHosts.has(parsed.hostname.toLowerCase())) {
        throw new Error('Not copied: only this server’s uploads and allowlisted hosts are copied');
      }
      const res = await app.ctx.fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'Chronicle (static site export)' },
      });
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      if (!res.body) throw new Error('Empty response');
      return {
        bytes: await readLimited(res.body, MAX_MEDIA_BYTES),
        mimeType: res.headers.get('content-type') ?? '',
      };
    };
  };

  app.get('/projects/:id/export.zip', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'viewer');
    const { version } = parse(Query, request.query, 'query');

    let data: unknown;
    let title: string;
    if (version) {
      const [row] = await db
        .select({ timeline: revisions.timelineData })
        .from(revisions)
        .where(and(eq(revisions.projectId, id), eq(revisions.version, version)))
        .limit(1);
      if (!row) throw notFound('Revision');
      data = row.timeline;
      title = row.timeline.title;
    } else {
      // The draft as collaborators see it now.
      await collab.flush(id);
      const [row] = await db
        .select({ draft: projects.draft })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (!row) throw notFound('Project');
      data = row.draft;
      title = row.draft.title;
    }

    let site: Awaited<ReturnType<typeof buildStaticSite>>;
    try {
      site = await buildStaticSite(data, {
        script,
        fetchMedia: fetcher(id),
        version,
        source: `${config.publicUrl}/api/v1/projects/${id}`,
        generator: 'Chronicle server',
      });
    } catch (err) {
      if (err instanceof StaticExportError) throw badRequest(err.message, err.issues);
      throw err;
    }
    const folder = siteFolderName(title) + (version ? `-v${String(version)}` : '');
    const zip = zipStaticSite(site, folder);
    await audit(
      db,
      {
        action: 'project.export',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: {
          version: version ?? null,
          bytes: zip.byteLength,
          media: site.media.filter((m) => m.status === 'included').length,
        },
      },
      request.log,
    );
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${folder}.zip"`)
      .header('cache-control', 'no-store')
      .send(Buffer.from(zip));
  });
};
