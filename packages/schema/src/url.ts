/**
 * URL safety rules shared by the schema (validation), the renderer (defence
 * in depth) and, later, the server and editor.
 *
 * Schemes are determined with the WHATWG URL parser rather than a regex, so
 * obfuscations browsers normalise away (`java\tscript:`, leading control
 * characters, mixed case) are classified exactly as a browser would.
 */

/** Base used to resolve relative paths; never fetched. */
const RESOLVE_BASE = 'https://chronicle.invalid/';

/** Media kinds that may use inline `data:` URLs of the matching MIME family. */
type DataKind = 'image' | 'video' | 'audio';

/**
 * Returns the URL's scheme (e.g. `"https:"`) after browser-style
 * normalisation, or `null` if it cannot be parsed. Relative paths resolve to
 * the base scheme (`"https:"`).
 */
export function getUrlScheme(url: string): string | null {
  try {
    return new URL(url, RESOLVE_BASE).protocol;
  } catch {
    return null;
  }
}

/**
 * Whether a media/thumbnail URL is safe to place in `src`.
 *
 * Allowed: `http(s):` (absolute, protocol-relative or relative paths),
 * `blob:`, and `data:` only for the given media kind's MIME family
 * (e.g. `data:image/png;…` for images).
 *
 * Rejected: `javascript:`, `vbscript:`, `file:`, `data:text/html`, and any
 * other scheme.
 */
export function isSafeMediaUrl(url: string, dataKind?: DataKind): boolean {
  const scheme = getUrlScheme(url);
  switch (scheme) {
    case 'http:':
    case 'https:':
    case 'blob:':
      return true;
    case 'data:': {
      if (!dataKind) return false;
      const mime = /^\s*data:([a-z]+)\//i.exec(url);
      return mime?.[1]?.toLowerCase() === dataKind;
    }
    default:
      return false;
  }
}
