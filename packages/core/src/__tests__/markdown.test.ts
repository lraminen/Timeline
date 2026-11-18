// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../renderer/markdown.js';

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
