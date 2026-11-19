/**
 * Timeline links, slugs and display values. Mirrors
 * plugin/includes/class-chronicle-timeline-urls.php and the renderer's
 * argument validation, so the editor accepts exactly what PHP renders.
 */

export interface TimelineRef {
  /** Server base URL; '' means the server configured in WordPress. */
  server: string;
  slug: string;
  /** Pinned version, or 0 for the latest published version. */
  version: number;
}

export type ParseResult =
  { ok: true; ref: TimelineRef } | { ok: false; reason: 'invalid' | 'share-link' | 'insecure' };

const SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const PATH = /^(.*?)\/(?:timeline|api\/v1\/embed)\/([^/]+)(?:\/v\/([0-9]{1,9}))?\/?$/;
const PATH_SEGMENTS = /^(\/[A-Za-z0-9._~-]+)+$/;

export function isValidSlug(value: string): boolean {
  return SLUG.test(value);
}

/** http(s) only; no credentials, query or fragment; no trailing slash. '' when invalid. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password || url.search || url.hash) return '';
  if (raw.includes('?') || raw.includes('#')) return '';
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== '' && !PATH_SEGMENTS.test(path)) return '';
  return `${url.protocol}//${url.host}${path}`;
}

export function sameServer(a: string, b: string): boolean {
  const left = normalizeServerUrl(a);
  return left !== '' && left === normalizeServerUrl(b);
}

/**
 * Accepts `/timeline/{slug}[/v/{n}]` and `/api/v1/embed/{slug}[/v/{n}]`
 * links (optionally below a path prefix), or a bare slug when a server is
 * configured. Links on the configured server are stored with `server: ''`.
 * Share links are refused: they expire.
 */
export function parseTimelineInput(input: string, configuredServer: string): ParseResult {
  const value = input.trim();
  if (configuredServer && isValidSlug(value)) {
    return { ok: true, ref: { server: '', slug: value, version: 0 } };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: 'invalid' };
  if (url.username || url.password) return { ok: false, reason: 'invalid' };
  if (url.searchParams.has('token')) return { ok: false, reason: 'share-link' };

  const match = PATH.exec(url.pathname);
  if (!match) return { ok: false, reason: 'invalid' };
  let slug: string;
  try {
    slug = decodeURIComponent(match[2] ?? '');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isValidSlug(slug)) return { ok: false, reason: 'invalid' };

  const server = normalizeServerUrl(`${url.protocol}//${url.host}${match[1] ?? ''}`);
  if (!server) return { ok: false, reason: 'invalid' };
  const version = match[3] ? Number(match[3]) : 0;

  if (configuredServer && sameServer(server, configuredServer)) {
    return { ok: true, ref: { server: '', slug, version } };
  }
  // Other servers are fetched through wp_safe_remote_get, over https only.
  if (url.protocol !== 'https:') return { ok: false, reason: 'insecure' };
  return { ok: true, ref: { server, slug, version } };
}

/** Comma-separated tags → unique, trimmed, at most 20 (as PHP renders them). */
export function parseTags(value: string): string[] {
  const tags = value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '' && t.length <= 60);
  return [...new Set(tags)].slice(0, 20);
}

export function formatTags(tags: readonly string[]): string {
  return parseTags(tags.map((t) => t.replace(/,/g, ' ')).join(',')).join(',');
}

/**
 * A CSS height the renderer accepts (`600`, `600px`, `80vh`, `40rem`…),
 * normalised; '' for "automatic"; null when invalid.
 */
export function normalizeHeight(value: string): string | null {
  let height = value.trim().toLowerCase();
  if (height === '') return '';
  if (/^\d{1,4}$/.test(height)) height += 'px';
  return /^\d{2,4}(px|vh|svh|dvh|rem|em)$/.test(height) ? height : null;
}

/** JSON for an inert `<script type="application/json">`: `<` can't close the element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
