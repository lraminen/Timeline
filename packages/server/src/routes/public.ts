import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { ApiError, badRequest, parse } from '../http.js';
import { loadPublished, type PublishedTimeline } from '../services/published.js';
import { renderEventList } from '../pages/render.js';

const SlugParams = z.object({ slug: z.string().min(1).max(100) });
const VersionParams = SlugParams.extend({ version: z.coerce.number().int().positive() });
const EmbedQuery = z.object({
  token: z.string().max(200).optional(),
  /** `fallback` adds the server-rendered no-JS event list (`fallbackHtml`). */
  include: z.enum(['fallback']).optional(),
});

const PROXY_MAX_BYTES = 15 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 10_000;

interface SendOptions {
  pinned: boolean;
  publicUrl: string;
  fallback: boolean;
}

/** Entity tag of one representation (with or without the fallback HTML). */
function entityTag(published: PublishedTimeline, fallback: boolean): string {
  return `"v${String(published.version)}${fallback ? '-f' : ''}"`;
}

function sendTimeline(reply: FastifyReply, published: PublishedTimeline, options: SendOptions) {
  const { pinned, publicUrl, fallback } = options;
  const cache = !published.isPublic
    ? 'private, no-store'
    : pinned
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60, stale-while-revalidate=600';
  void reply
    .header('cache-control', cache)
    .header('etag', entityTag(published, fallback))
    .header('cross-origin-resource-policy', 'cross-origin');
  return {
    version: published.version,
    publishedAt: published.publishedAt.toISOString(),
    pageUrl: `${publicUrl}/timeline/${encodeURIComponent(published.project.slug)}${
      pinned ? `/v/${String(published.version)}` : ''
    }`,
    timeline: published.timeline,
    ...(fallback ? { fallbackHtml: renderEventList(published.timeline, publicUrl) } : {}),
  };
}

export const publicRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const proxyHosts = new Set(config.MEDIA_PROXY_HOSTS.map((h) => h.toLowerCase()));

  /** Latest published version — what <chronicle-timeline src="…"> loads. */
  app.get('/embed/:slug', async (request, reply) => {
    const { slug } = parse(SlugParams, request.params, 'path');
    const { token, include } = parse(EmbedQuery, request.query, 'query');
    const fallback = include === 'fallback';
    const published = await loadPublished(db, config, slug, { token });
    if (request.headers['if-none-match'] === entityTag(published, fallback) && published.isPublic) {
      return reply.status(304).send();
    }
    return sendTimeline(reply, published, { pinned: false, publicUrl: config.publicUrl, fallback });
  });

  /** A specific version; immutable, so cached forever when public. */
  app.get('/embed/:slug/v/:version', async (request, reply) => {
    const { slug, version } = parse(VersionParams, request.params, 'path');
    const { token, include } = parse(EmbedQuery, request.query, 'query');
    const published = await loadPublished(db, config, slug, { version, token });
    return sendTimeline(reply, published, {
      pinned: true,
      publicUrl: config.publicUrl,
      fallback: include === 'fallback',
    });
  });

  /**
   * Media proxy for allowlisted hosts: lets timelines show third-party images
   * without exposing readers' IP addresses to those hosts, and avoids mixed
   * content. Only https, only exact allowlisted hostnames, no redirects, image
   * types only (no SVG), size- and time-limited.
   */
  app.get('/media-proxy', async (request, reply) => {
    const { url } = parse(z.object({ url: z.string().url().max(2048) }), request.query, 'query');
    const target = new URL(url);
    if (target.protocol !== 'https:' || !proxyHosts.has(target.hostname.toLowerCase())) {
      throw new ApiError(403, 'host_not_allowed', 'That host is not on the media proxy allowlist');
    }

    let upstream: Response;
    try {
      upstream = await app.ctx.fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
      });
    } catch {
      throw new ApiError(502, 'upstream_failed', 'Could not fetch the image');
    }
    if (upstream.status !== 200 || !upstream.body) {
      throw new ApiError(502, 'upstream_failed', `Upstream responded ${String(upstream.status)}`);
    }
    const type =
      (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(type)) {
      throw badRequest('Upstream did not return a supported image');
    }
    const length = Number(upstream.headers.get('content-length') ?? '0');
    if (length > PROXY_MAX_BYTES)
      throw new ApiError(413, 'payload_too_large', 'Image is too large to proxy');

    // Enforce the size cap on the stream too (Content-Length may be absent or wrong).
    let seen = 0;
    const limited = Readable.fromWeb(upstream.body).filter((chunk: Buffer) => {
      seen += chunk.length;
      if (seen > PROXY_MAX_BYTES) throw new Error('proxied image exceeds size limit');
      return true;
    });

    return reply
      .header('content-type', type)
      .header('cache-control', 'public, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(limited);
  });
};
