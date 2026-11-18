import { getUrlScheme, isSafeMediaUrl, type TimelineMedia } from '@chronicle/schema';

export type MediaDisplayType = 'image' | 'video' | 'audio' | 'iframe' | 'map';

export { isSafeMediaUrl };

/**
 * `sandbox` tokens for embedded players. `allow-same-origin` here refers to
 * the *embed's* own origin (YouTube/Vimeo/Google), which players need for
 * their own cookies/storage; it grants no access to the host page because the
 * frame is always cross-origin (only allowlisted https hosts are embedded).
 */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';

/**
 * Resolves the presentation display type for a given TimelineMedia asset.
 */
export function resolveMediaType(media: TimelineMedia): MediaDisplayType {
  if (media.type === 'oembed') {
    return 'iframe';
  }
  return media.type;
}

/**
 * Checks if a given media URL is an absolute http(s) URL (as opposed to a
 * relative path, blob or data URL).
 */
export function isExternalUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Parses an absolute http(s) URL, or returns null. */
function parseHttpUrl(url: string): URL | null {
  const scheme = getUrlScheme(url);
  if (scheme !== 'https:' && scheme !== 'http:') return null;
  if (!isExternalUrl(url) && !url.trim().startsWith('//')) return null;
  try {
    return new URL(url.trim(), 'https://chronicle.invalid/');
  } catch {
    return null;
  }
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Converts a known provider URL (YouTube, Vimeo, Google Maps embeds) into an
 * embeddable https iframe URL. Returns `null` for anything else — callers
 * must never fall back to iframing an arbitrary URL.
 *
 * Provider detection is by parsed hostname, not substring, and the returned
 * URL is always constructed from a fixed https origin.
 */
export function getOEmbedUrl(url: string): string | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  // YouTube
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  let ytId: string | null = null;
  if (hostIs(host, 'youtu.be')) {
    ytId = path.slice(1).split('/')[0] ?? null;
  } else if (hostIs(host, 'youtube.com') || hostIs(host, 'youtube-nocookie.com')) {
    ytId =
      parsed.searchParams.get('v') ??
      /^\/(?:embed|v|shorts|live)\/([^/?#]+)/.exec(path)?.[1] ??
      null;
  }
  if (ytId && YT_ID.test(ytId)) {
    return `https://www.youtube-nocookie.com/embed/${ytId}`;
  }

  // Vimeo: the video id is the last purely numeric path segment.
  if (hostIs(host, 'vimeo.com')) {
    const id = path
      .split('/')
      .filter((s) => /^\d+$/.test(s))
      .at(-1);
    if (id) return `https://player.vimeo.com/video/${id}`;
  }

  // Google Maps embed URLs (already in embed form).
  if ((host === 'www.google.com' || host === 'google.com') && path.startsWith('/maps/embed')) {
    return `https://www.google.com${path}${parsed.search}`;
  }

  return null;
}

/**
 * Default CSS aspect ratio per media display type.
 */
export function getMediaAspectRatio(type: MediaDisplayType): string {
  switch (type) {
    case 'video':
    case 'iframe':
      return '16 / 9';
    case 'map':
      return '4 / 3';
    case 'audio':
      return 'auto';
    case 'image':
    default:
      return '16 / 9';
  }
}
