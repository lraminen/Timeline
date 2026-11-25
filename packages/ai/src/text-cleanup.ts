/**
 * Linear O(n) whitespace normalization avoiding catastrophic or quadratic regex
 * backtracking on large runs of spaces or tabs without newlines.
 */
export function collapseWhitespace(
  raw: string,
  options: { collapseHorizontal?: boolean; trimLineStart?: boolean } = {},
): string {
  const { collapseHorizontal = false, trimLineStart = false } = options;
  const len = raw.length;
  const out: string[] = [];
  let pendingSpaces = 0;
  let newlineRun = 0;
  let atLineStart = true;

  for (let i = 0; i < len; i++) {
    const ch = raw[i];
    if (ch === '\r') {
      if (raw[i + 1] === '\n') i += 1;
      pendingSpaces = 0;
      if (newlineRun < 2) {
        out.push('\n');
        newlineRun += 1;
      }
      atLineStart = true;
      continue;
    }
    if (ch === '\n') {
      pendingSpaces = 0;
      if (newlineRun < 2) {
        out.push('\n');
        newlineRun += 1;
      }
      atLineStart = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (trimLineStart && atLineStart) continue;
      if (collapseHorizontal) {
        pendingSpaces = 1;
      } else {
        pendingSpaces += 1;
        // Preserve tabs vs spaces faithfully if not collapsing horizontally.
        if (ch === '\t') {
          if (pendingSpaces > 1) out.push(' '.repeat(pendingSpaces - 1));
          out.push('\t');
          pendingSpaces = 0;
        }
      }
      continue;
    }

    if (pendingSpaces > 0) {
      out.push(collapseHorizontal ? ' ' : ' '.repeat(pendingSpaces));
      pendingSpaces = 0;
    }
    newlineRun = 0;
    atLineStart = false;
    out.push(ch ?? '');
  }

  return out.join('').trim();
}

const SKIP_CONTENT_TAGS = new Set(['head', 'title', 'script', 'style', 'noscript']);
const BLOCK_END_TAGS = new Set([
  'p',
  'div',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'blockquote',
  'section',
  'article',
]);

function decodeNamedOrNumericEntity(entityBody: string): string | null {
  const lower = entityBody.toLowerCase();
  switch (lower) {
    case 'nbsp':
      return ' ';
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case '#39':
    case 'apos':
      return "'";
  }
  if (lower.startsWith('#x')) {
    const code = Number.parseInt(lower.slice(2), 16);
    if (Number.isFinite(code) && code > 0 && code < 0x110000) {
      return String.fromCodePoint(code);
    }
    return ' ';
  }
  if (lower.startsWith('#')) {
    const code = Number(lower.slice(1));
    if (Number.isFinite(code) && code > 0 && code < 0x110000) {
      return String.fromCodePoint(code);
    }
    return ' ';
  }
  return null;
}

/**
 * Extracts `<title>` text from HTML in linear O(n) time without regex backtracking.
 */
export function extractHtmlTitle(html: string): string | undefined {
  const lower = html.toLowerCase();
  const openIdx = lower.indexOf('<title');
  if (openIdx === -1) return undefined;
  const openGt = html.indexOf('>', openIdx + 6);
  if (openGt === -1) return undefined;
  const closeIdx = lower.indexOf('</title', openGt + 1);
  if (closeIdx === -1) return undefined;
  const raw = html.slice(openGt + 1, closeIdx);
  const cleaned = collapseWhitespace(raw, { collapseHorizontal: true, trimLineStart: true });
  return cleaned || undefined;
}

/** Strips HTML tags, head, title, scripts, styles, and entities into readable plain text in O(n) time. */
export function parseHtmlToText(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    const ch = html[i];
    if (ch === '<') {
      if (html.startsWith('<!--', i)) {
        const commentEnd = html.indexOf('-->', i + 4);
        if (commentEnd === -1) break;
        parts.push(' ');
        i = commentEnd + 3;
        continue;
      }

      const gt = html.indexOf('>', i + 1);
      if (gt === -1) break;

      const rawTag = lower.slice(i + 1, gt).trim();
      const isClose = rawTag.startsWith('/');
      const nameStart = isClose ? 1 : 0;
      let nameEnd = nameStart;
      while (
        nameEnd < rawTag.length &&
        rawTag[nameEnd] !== ' ' &&
        rawTag[nameEnd] !== '\t' &&
        rawTag[nameEnd] !== '\n' &&
        rawTag[nameEnd] !== '\r' &&
        rawTag[nameEnd] !== '/'
      ) {
        nameEnd += 1;
      }
      const tagName = rawTag.slice(nameStart, nameEnd);

      if (!isClose && SKIP_CONTENT_TAGS.has(tagName)) {
        if (!rawTag.endsWith('/')) {
          const closeIdx = lower.indexOf(`</${tagName}`, gt + 1);
          if (closeIdx === -1) break;
          const closeGt = html.indexOf('>', closeIdx + 2 + tagName.length);
          i = closeGt === -1 ? len : closeGt + 1;
        } else {
          i = gt + 1;
        }
        parts.push(' ');
        continue;
      }

      if (!isClose && tagName === 'br') {
        parts.push('\n');
      } else if (isClose && BLOCK_END_TAGS.has(tagName)) {
        parts.push('\n\n');
      } else {
        parts.push(' ');
      }
      i = gt + 1;
      continue;
    }

    if (ch === '&') {
      const semi = html.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 12) {
        const decoded = decodeNamedOrNumericEntity(html.slice(i + 1, semi));
        if (decoded !== null) {
          parts.push(decoded);
          i = semi + 1;
          continue;
        }
      }
      parts.push('&');
      i += 1;
      continue;
    }

    const nextTag = html.indexOf('<', i);
    const nextAmp = html.indexOf('&', i);
    let next = len;
    if (nextTag !== -1 && nextTag < next) next = nextTag;
    if (nextAmp !== -1 && nextAmp < next) next = nextAmp;
    parts.push(html.slice(i, next));
    i = next;
  }

  return collapseWhitespace(parts.join(''), { collapseHorizontal: true, trimLineStart: true });
}

/**
 * Extracts readable text from DOCX `word/document.xml` in O(n) linear time
 * without regex backtracking on malformed tags or whitespace runs.
 */
export function extractDocxTextFromXml(xml: string): string {
  const parts: string[] = [];
  const len = xml.length;
  let i = 0;

  while (i < len) {
    const ch = xml[i];
    if (ch === '<') {
      const gt = xml.indexOf('>', i + 1);
      if (gt === -1) break;
      const tag = xml.slice(i + 1, gt).trim();
      if (tag === '/w:p') {
        parts.push('\n\n');
      } else if (tag === 'w:tab/' || tag === 'w:tab') {
        parts.push('\t');
      } else if (tag === 'w:br/' || tag === 'w:br' || tag.startsWith('w:br ')) {
        parts.push('\n');
      }
      i = gt + 1;
      continue;
    }

    if (ch === '&') {
      const semi = xml.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 12) {
        const decoded = decodeNamedOrNumericEntity(xml.slice(i + 1, semi));
        if (decoded !== null) {
          parts.push(decoded);
          i = semi + 1;
          continue;
        }
      }
      parts.push('&');
      i += 1;
      continue;
    }

    const nextTag = xml.indexOf('<', i);
    const nextAmp = xml.indexOf('&', i);
    let next = len;
    if (nextTag !== -1 && nextTag < next) next = nextTag;
    if (nextAmp !== -1 && nextAmp < next) next = nextAmp;
    parts.push(xml.slice(i, next));
    i = next;
  }

  return collapseWhitespace(parts.join(''), { collapseHorizontal: false, trimLineStart: false });
}
