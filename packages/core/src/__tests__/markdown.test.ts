// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../renderer/markdown.js';
import { markdownToHtml, markdownToText } from '../markdown.js';

function html(md: string): string {
  const div = document.createElement('div');
  div.appendChild(renderMarkdown(md));
  return div.innerHTML;
}

describe('renderMarkdown', () => {
  it('renders paragraphs and soft/hard breaks', () => {
    expect(html('one\ntwo\n\nthree')).toBe('<p>one two</p><p>three</p>');
    expect(html('one  \ntwo')).toBe('<p>one<br>two</p>');
  });

  it('renders inline emphasis, code and links', () => {
    expect(html('**b** *i* _j_ `c`')).toBe(
      '<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code></p>',
    );
    expect(html('[NASA](https://nasa.gov)')).toBe(
      '<p><a href="https://nasa.gov" rel="noopener noreferrer nofollow" target="_blank">NASA</a></p>',
    );
  });

  it('does not treat snake_case as emphasis', () => {
    expect(html('snake_case_name')).toBe('<p>snake_case_name</p>');
  });

  it('renders lists and blockquotes', () => {
    expect(html('- a\n- **b**')).toBe('<ul><li>a</li><li><strong>b</strong></li></ul>');
    expect(html('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(html('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
  });

  it('renders headings as emphasised paragraphs (cards already have a heading)', () => {
    expect(html('## Sub')).toBe('<p class="chronicle-md-heading"><strong>Sub</strong></p>');
  });

  it('shows raw HTML as text, never as markup', () => {
    const out = html('<img src=x onerror=alert(1)><script>alert(1)</script>');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;img');
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JAVASCRIPT:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox)',
  ])('renders unsafe link %j as plain text', (md) => {
    const out = html(md);
    expect(out).not.toContain('<a');
    expect(out).not.toMatch(/href/);
  });

  it('allows relative and mailto links', () => {
    expect(html('[a](/about)')).toContain('href="/about"');
    expect(html('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
  });

  it('handles escaped characters', () => {
    expect(html('\\*not em\\*')).toBe('<p>*not em*</p>');
  });
});

describe('markdownToHtml (server-side rendering)', () => {
  const corpus = [
    'one\ntwo\n\nthree',
    'one  \ntwo',
    '**b** *i* _j_ `c` [NASA](https://nasa.gov)',
    '- a\n- **b**\n\n1. x\n2. y',
    '> quoted **bold**\n> more',
    '## Heading',
    'Tom & Jerry say "hi" <3',
    '<img src=x onerror=alert(1)><script>alert(1)</script>',
    '[x](javascript:alert(1)) [y](https://e.x/?a=1&b="2")',
    '\\*not em\\*',
  ];

  it.each(corpus)('matches the DOM renderer structurally for %j', (md) => {
    const fromDom = html(md);
    const parsed = document.createElement('div');
    parsed.innerHTML = markdownToHtml(md);
    expect(parsed.innerHTML).toBe(fromDom);
  });

  it('escapes text and attributes', () => {
    const out = markdownToHtml('<b>"x"</b> [l](https://e.x/?q="><script>)');
    expect(out).not.toMatch(/<b>|<script/);
    expect(out).toContain('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('produces plain text for meta descriptions', () => {
    expect(markdownToText('Hello **world**\n\n- [a](https://x.y)\n- b')).toBe(
      'Hello world\n\na\nb',
    );
  });
});
