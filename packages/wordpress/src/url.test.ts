import { describe, it, expect } from 'vitest';
import {
  formatTags,
  jsonForScript,
  normalizeHeight,
  normalizeServerUrl,
  parseTags,
  parseTimelineInput,
} from './url.js';

const CONFIGURED = 'https://timelines.example.org';

describe('parseTimelineInput', () => {
  it('accepts page and embed links, with or without a pinned version', () => {
    expect(parseTimelineInput('https://other.example/timeline/space-race', CONFIGURED)).toEqual({
      ok: true,
      ref: { server: 'https://other.example', slug: 'space-race', version: 0 },
    });
    expect(
      parseTimelineInput('https://other.example/api/v1/embed/space-race/v/3', CONFIGURED),
    ).toEqual({
      ok: true,
      ref: { server: 'https://other.example', slug: 'space-race', version: 3 },
    });
    expect(parseTimelineInput('https://other.example/sub/dir/timeline/a_b-1/', '')).toEqual({
      ok: true,
      ref: { server: 'https://other.example/sub/dir', slug: 'a_b-1', version: 0 },
    });
  });

  it('stores links to the configured server, and bare slugs, without a server', () => {
    expect(parseTimelineInput(`${CONFIGURED}/timeline/moon/v/2`, CONFIGURED)).toEqual({
      ok: true,
      ref: { server: '', slug: 'moon', version: 2 },
    });
    expect(parseTimelineInput('HTTPS://Timelines.Example.org/timeline/moon', CONFIGURED)).toEqual({
      ok: true,
      ref: { server: '', slug: 'moon', version: 0 },
    });
    expect(parseTimelineInput('  moon-landing ', CONFIGURED)).toEqual({
      ok: true,
      ref: { server: '', slug: 'moon-landing', version: 0 },
    });
    // Without a configured server a bare slug means nothing.
    expect(parseTimelineInput('moon-landing', '')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('allows plain http only for the configured server', () => {
    expect(parseTimelineInput('http://localhost:3000/timeline/x', 'http://localhost:3000')).toEqual(
      { ok: true, ref: { server: '', slug: 'x', version: 0 } },
    );
    expect(parseTimelineInput('http://elsewhere.example/timeline/x', CONFIGURED)).toEqual({
      ok: false,
      reason: 'insecure',
    });
  });

  it('refuses share links and anything that is not a timeline link', () => {
    expect(
      parseTimelineInput('https://other.example/timeline/x?token=abc.def', CONFIGURED),
    ).toEqual({ ok: false, reason: 'share-link' });
    for (const bad of [
      '',
      'javascript:alert(1)//timeline/x',
      'https://other.example/blog/post',
      'https://other.example/timeline/',
      'https://other.example/timeline/has%20space',
      'https://other.example/timeline/a/b',
      'https://other.example/timeline/x/v/abc',
      'ftp://other.example/timeline/x',
      'https://user:pw@other.example/timeline/x',
      `https://other.example/timeline/${'a'.repeat(101)}`,
    ]) {
      expect(parseTimelineInput(bad, CONFIGURED), bad).toMatchObject({ ok: false });
    }
  });
});

describe('normalizeServerUrl', () => {
  it('normalises and rejects unsafe forms', () => {
    expect(normalizeServerUrl(' https://Example.org/chronicle/ ')).toBe(
      'https://example.org/chronicle',
    );
    expect(normalizeServerUrl('http://127.0.0.1:3999')).toBe('http://127.0.0.1:3999');
    expect(normalizeServerUrl('https://example.org/?x=1')).toBe('');
    expect(normalizeServerUrl('https://example.org/#x')).toBe('');
    expect(normalizeServerUrl('data:text/html,hi')).toBe('');
    expect(normalizeServerUrl('not a url')).toBe('');
  });
});

describe('display values', () => {
  it('normalises heights the renderer accepts', () => {
    expect(normalizeHeight('')).toBe('');
    expect(normalizeHeight('600')).toBe('600px');
    expect(normalizeHeight(' 80VH ')).toBe('80vh');
    expect(normalizeHeight('40rem')).toBe('40rem');
    expect(normalizeHeight('5px')).toBeNull();
    expect(normalizeHeight('100%')).toBeNull();
    expect(normalizeHeight('calc(1px)')).toBeNull();
  });

  it('parses and formats tag lists', () => {
    expect(parseTags(' moon, , space ,moon')).toEqual(['moon', 'space']);
    expect(formatTags(['a,b', ' c '])).toBe('a b,c');
    expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`).join(','))).toHaveLength(20);
  });

  it('escapes < so data cannot close its script element', () => {
    const json = jsonForScript({ title: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual({ title: '</script><script>alert(1)</script>' });
  });
});
