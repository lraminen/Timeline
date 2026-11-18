import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { ApiError, parse } from '../http.js';
import { loadPublished } from '../services/published.js';
import { renderNotFoundPage, renderTimelinePage, type PageAssets } from '../pages/render.js';
import { PAGE_CSS } from '../pages/styles.js';
import { mediaServeRoutes } from './media.js';

const require = createRequire(import.meta.url);

interface Asset {
  path: string;
  body: Buffer;
  type: string;
}

/** Content-hashed asset paths, so they can be cached forever. */
function hashedAsset(name: string, ext: string, body: Buffer, type: string): Asset {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return { path: `/assets/${name}.${hash}.${ext}`, body, type };
}

/** Allowed embed providers — mirrors @chronicle/core's oEmbed allowlist. */
const FRAME_SOURCES = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.google.com',
];

export const pageRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  await app.register(mediaServeRoutes);

  const script = hashedAsset(
    'chronicle-timeline',
    'js',
    readFileSync(require.resolve('@chronicle/web-component/cdn/iife')),
    'text/javascript; charset=utf-8',
  );
  const stylesheet = hashedAsset(
    'timeline-page',
    'css',
    Buffer.from(PAGE_CSS),
    'text/css; charset=utf-8',
  );
  const assets: PageAssets = { script: script.path, stylesheet: stylesheet.path };

  for (const asset of [script, stylesheet]) {
    app.get(asset.path, (_request, reply) => {
      void reply
        .header('content-type', asset.type)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('cross-origin-resource-policy', 'cross-origin')
        .send(asset.body);
    });
  }

  /**
   * Stable, unhashed URL for third-party embeds
   * (`<script src="…/embed.js">`); cached briefly so upgrades roll out.
   */
  app.get('/embed.js', (_request, reply) => {
    void reply
      .header('content-type', script.type)
      .header('cache-control', 'public, max-age=3600, stale-while-revalidate=86400')
      .header('cross-origin-resource-policy', 'cross-origin')
      .header('access-control-allow-origin', '*')
      .send(script.body);
  });

  const frameAncestors = config.EMBED_ORIGINS.includes('*')
    ? '*'
    : config.EMBED_ORIGINS.join(' ') || "'none'";
  const pageCsp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: data: blob:",
    `frame-src ${FRAME_SOURCES.join(' ')}`,
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; ');

  const sendHtml = (reply: FastifyReply, status: number, html: string, cache: string) =>
    reply
      .status(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', pageCsp)
      .header('cache-control', cache)
      .send(html);

  const render = async (reply: FastifyReply, params: unknown, query: unknown, pinned: boolean) => {
    const { slug, version } = parse(
      z.object({
        slug: z.string().min(1).max(100),
        version: z.coerce.number().int().positive().optional(),
      }),
      params,
      'path',
    );
    const { token } = parse(z.object({ token: z.string().max(200).optional() }), query, 'query');
    try {
      const published = await loadPublished(db, config, slug, { version, token });
      const canonical = `${config.publicUrl}/timeline/${published.project.slug}${pinned ? `/v/${String(published.version)}` : ''}`;
      const html = renderTimelinePage({
        timeline: published.timeline,
        canonicalUrl: canonical,
        publicUrl: config.publicUrl,
        version: published.version,
        publishedAt: published.publishedAt,
        assets,
        indexable: published.isPublic,
      });
      const cache = !published.isPublic
        ? 'private, no-store'
        : pinned
          ? 'public, max-age=86400'
          : 'public, max-age=60, stale-while-revalidate=600';
      // `await` keeps a rejected send inside this try block.
      return await sendHtml(reply, 200, html, cache);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 404) {
        return sendHtml(reply, 404, renderNotFoundPage(assets), 'no-store');
      }
      throw err;
    }
  };

  // Pages set their own CSP and framing policy (embedders may iframe them).
  const pageRoute = { helmet: { contentSecurityPolicy: false, frameguard: false } } as const;
  app.get('/timeline/:slug', pageRoute, (request, reply) =>
    render(reply, request.params, request.query, false),
  );
  app.get('/timeline/:slug/v/:version', pageRoute, (request, reply) =>
    render(reply, request.params, request.query, true),
  );
};
