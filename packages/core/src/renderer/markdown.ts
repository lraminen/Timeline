import { h } from './dom.js';

/**
 * Renders the Markdown subset Chronicle event bodies use into DOM nodes.
 *
 * Supported blocks: paragraphs, `-`/`*`/`+` bullet lists, `1.` ordered lists,
 * `>` blockquotes, `#`–`######` headings (rendered as emphasised paragraphs,
 * since cards already have a title heading). Inline: `**bold**`, `*italic*` /
 * `_italic_`, `` `code` ``, `[links](url)`, hard breaks (two trailing spaces
 * or a backslash).
 *
 * Security: output is built exclusively with `createElement`/text nodes —
 * never `innerHTML` — so raw HTML in the source is shown as text. Link hrefs
 * are restricted to http(s), mailto and relative URLs; anything else
 * (e.g. `javascript:`) is rendered as plain text.
 */
export function renderMarkdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const block of parseBlocks(source.replace(/\r\n?/g, '\n'))) {
    frag.appendChild(renderBlock(block));
  }
  return frag;
}

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

function renderBlock(block: Block): HTMLElement {
  switch (block.kind) {
    case 'p':
      return appendInlineLines(h('p'), block.lines);
    case 'heading': {
      const p = h('p', { class: 'chronicle-md-heading' });
      p.appendChild(appendInline(h('strong'), block.text));
      return p;
    }
    case 'ul':
    case 'ol': {
      const list = h(block.kind);
      for (const item of block.items)
        list.appendChild(appendInlineLines(h('li'), item.split('\n')));
      return list;
    }
    case 'quote': {
      const quote = h('blockquote');
      for (const b of parseBlocks(block.lines.join('\n'))) quote.appendChild(renderBlock(b));
      return quote;
    }
  }
}

/** Joins lines with spaces, honouring Markdown hard breaks. */
function appendInlineLines(el: HTMLElement, lines: string[]): HTMLElement {
  lines.forEach((raw, idx) => {
    const hardBreak = / {2,}$/.test(raw) || /\\$/.test(raw);
    const text = raw.replace(/\\$/, '').trim();
    appendInline(el, text);
    if (idx < lines.length - 1) {
      el.appendChild(hardBreak ? h('br') : document.createTextNode(' '));
    }
  });
  return el;
}

/** Inline tokens, in priority order. */
const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\s][\s\S]*?)\*|(?<![A-Za-z0-9])_([^_\s][\s\S]*?)_(?![A-Za-z0-9])|\\([\\`*_[\]()#+\-.!>])/;

function appendInline(el: HTMLElement, text: string): HTMLElement {
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      el.appendChild(document.createTextNode(rest));
      break;
    }
    if (m.index > 0) el.appendChild(document.createTextNode(rest.slice(0, m.index)));

    // Non-participating capture groups are `undefined` at runtime, even though
    // RegExpExecArray types them as `string`.
    const groups: (string | undefined)[] = Array.from(m);
    const whole = m[0];
    const [, , code, linkText, href, strong1, strong2, em1, em2, escaped] = groups;
    if (code !== undefined) {
      el.appendChild(h('code', {}, code.trim()));
    } else if (linkText !== undefined) {
      if (href && isSafeHref(href)) {
        const a = h('a', { href, rel: 'noopener noreferrer nofollow', target: '_blank' });
        el.appendChild(appendInline(a, linkText));
      } else {
        appendInline(el, linkText);
      }
    } else if (strong1 !== undefined || strong2 !== undefined) {
      el.appendChild(appendInline(h('strong'), strong1 ?? strong2 ?? ''));
    } else if (em1 !== undefined || em2 !== undefined) {
      el.appendChild(appendInline(h('em'), em1 ?? em2 ?? ''));
    } else if (escaped !== undefined) {
      el.appendChild(document.createTextNode(escaped));
    }
    rest = rest.slice(m.index + whole.length);
  }
  return el;
}

/** http(s), mailto, protocol-relative and relative URLs only. */
export function isSafeHref(href: string): boolean {
  try {
    const scheme = new URL(href, 'https://chronicle.invalid/').protocol;
    return scheme === 'https:' || scheme === 'http:' || scheme === 'mailto:';
  } catch {
    return false;
  }
}
