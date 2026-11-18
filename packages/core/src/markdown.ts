/**
 * Chronicle's Markdown subset — a DOM-free parser plus an HTML-string
 * renderer (for server-side rendering and static export). The browser
 * renderer (`renderer/markdown.ts`) consumes the same node tree, so the
 * safety rules below are defined exactly once.
 *
 * Supported blocks: paragraphs, `-`/`*`/`+` bullet lists, `1.` ordered lists,
 * `>` blockquotes, `#`–`######` headings (emitted as emphasised paragraphs,
 * since cards already have a title heading). Inline: `**bold**`, `*italic*` /
 * `_italic_`, `` `code` ``, `[links](url)`, hard breaks (two trailing spaces
 * or a backslash), backslash escapes.
 *
 * Security:
 * - Raw HTML in the source is never interpreted — it becomes text.
 * - Link hrefs are limited to http(s), mailto and relative URLs; anything
 *   else (e.g. `javascript:`) is rendered as plain text.
 * - The HTML renderer escapes every text node and attribute value.
 */

export type MdTag = 'p' | 'strong' | 'em' | 'code' | 'a' | 'ul' | 'ol' | 'li' | 'blockquote' | 'br';

export type MdNode =
  | { type: 'text'; value: string }
  | { type: 'element'; tag: MdTag; attrs?: Record<string, string>; children: MdNode[] };

const text = (value: string): MdNode => ({ type: 'text', value });
const el = (tag: MdTag, children: MdNode[] = [], attrs?: Record<string, string>): MdNode => ({
  type: 'element',
  tag,
  children,
  ...(attrs ? { attrs } : {}),
});

/** http(s), mailto, protocol-relative and relative URLs only. */
export function isSafeHref(href: string): boolean {
  try {
    const scheme = new URL(href, 'https://chronicle.invalid/').protocol;
    return scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] };

const UL_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] });
      i++;
      continue;
    }

    const listKind = UL_ITEM.test(line) ? 'ul' : OL_ITEM.test(line) ? 'ol' : null;
    if (listKind) {
      const re = listKind === 'ul' ? UL_ITEM : OL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) {
          items.push(m[1]);
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length > 0) {
          // Lazy continuation of the previous item.
          items[items.length - 1] += `\n${lines[i].trim()}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ kind: listKind, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]);
        if (!m) break;
        quoted.push(m[1]);
        i++;
      }
      blocks.push({ kind: 'quote', lines: quoted });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !HEADING.test(lines[i]) &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i]) &&
      !QUOTE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

function blockToNode(block: Block): MdNode {
  switch (block.kind) {
    case 'p':
      return el('p', inlineLines(block.lines));
    case 'heading':
      return el('p', [el('strong', parseInline(block.text))], { class: 'chronicle-md-heading' });
    case 'ul':
    case 'ol':
      return el(
        block.kind,
        block.items.map((item) => el('li', inlineLines(item.split('\n')))),
      );
    case 'quote':
      return el('blockquote', parseBlocks(block.lines.join('\n')).map(blockToNode));
  }
}

/** Joins lines with spaces, honouring Markdown hard breaks. */
function inlineLines(lines: string[]): MdNode[] {
  const out: MdNode[] = [];
  lines.forEach((raw, idx) => {
    const hardBreak = / {2,}$/.test(raw) || /\\$/.test(raw);
    out.push(...parseInline(raw.replace(/\\$/, '').trim()));
    if (idx < lines.length - 1) out.push(hardBreak ? el('br') : text(' '));
  });
  return mergeText(out);
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

/** Inline tokens, in priority order. */
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][\s\S]*?)\*|(?<![A-Za-z0-9])_([^_\s][\s\S]*?)_(?![A-Za-z0-9])|\\([\\`*_[\]()#+\-.!>])/;

function parseInline(source: string): MdNode[] {
  const out: MdNode[] = [];
  let rest = source;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(text(rest));
      break;
    }
    if (m.index > 0) out.push(text(rest.slice(0, m.index)));

    // Non-participating capture groups are `undefined` at runtime, even though
    // RegExpExecArray types them as `string`.
    const groups: (string | undefined)[] = Array.from(m);
    const [, , code, linkText, href, strong1, strong2, em1, em2, escaped] = groups;
    if (code !== undefined) {
      out.push(el('code', [text(code.trim())]));
    } else if (linkText !== undefined) {
      if (href && isSafeHref(href)) {
        out.push(
          el('a', parseInline(linkText), {
            href,
            rel: 'noopener noreferrer nofollow',
            target: '_blank',
          }),
        );
      } else {
        out.push(...parseInline(linkText));
      }
    } else if (strong1 !== undefined || strong2 !== undefined) {
      out.push(el('strong', parseInline(strong1 ?? strong2 ?? '')));
    } else if (em1 !== undefined || em2 !== undefined) {
      out.push(el('em', parseInline(em1 ?? em2 ?? '')));
    } else if (escaped !== undefined) {
      out.push(text(escaped));
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return mergeText(out);
}

/** Merges adjacent text nodes (keeps output identical to DOM normalisation). */
function mergeText(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const node of nodes) {
    const prev = out.at(-1);
    if (node.type === 'text' && prev?.type === 'text') {
      out[out.length - 1] = text(prev.value + node.value);
    } else if (node.type !== 'text' || node.value) {
      out.push(node);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parses Markdown into Chronicle's safe node tree. */
export function parseMarkdown(source: string): MdNode[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n')).map(blockToNode);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function nodeToHtml(node: MdNode): string {
  if (node.type === 'text') return escapeHtml(node.value);
  if (node.tag === 'br') return '<br>';
  const attrs = Object.entries(node.attrs ?? {})
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
  return `<${node.tag}${attrs}>${node.children.map(nodeToHtml).join('')}</${node.tag}>`;
}

/** Renders Markdown to an HTML string (all text and attributes escaped). */
export function markdownToHtml(source: string): string {
  return parseMarkdown(source).map(nodeToHtml).join('');
}

/** Plain-text rendering (for meta descriptions, JSON-LD, screen-reader labels). */
export function markdownToText(source: string): string {
  const flatten = (nodes: MdNode[]): string =>
    nodes
      .map((n) => {
        if (n.type === 'text') return n.value;
        if (n.tag === 'br') return '\n';
        // Container blocks put each child (list item, quoted block) on its own line.
        if (n.tag === 'ul' || n.tag === 'ol' || n.tag === 'blockquote') {
          return n.children.map((c) => flatten([c])).join('\n');
        }
        return flatten(n.children);
      })
      .join('');
  return parseMarkdown(source)
    .map((n) => flatten([n]))
    .join('\n\n')
    .trim();
}
