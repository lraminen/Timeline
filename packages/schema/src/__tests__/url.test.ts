import { describe, it, expect } from 'vitest';
import { getUrlScheme, isSafeMediaUrl } from '../url.js';
import { validateTimeline } from '../validate.js';

describe('getUrlScheme', () => {
  it('resolves relative and protocol-relative paths to https', () => {
    expect(getUrlScheme('images/a.png')).toBe('https:');
    expect(getUrlScheme('/images/a.png')).toBe('https:');
    expect(getUrlScheme('//cdn.example.com/a.png')).toBe('https:');
  });

  it('normalises obfuscated schemes the way browsers do', () => {
    expect(getUrlScheme('JAVASCRIPT:alert(1)')).toBe('javascript:');
    expect(getUrlScheme('java\tscript:alert(1)')).toBe('javascript:');
    expect(getUrlScheme('\u0001 javascript:alert(1)')).toBe('javascript:');
  });
});

describe('isSafeMediaUrl', () => {
  it.each([
    'https://example.com/a.jpg',
    'http://example.com/a.jpg',
    'relative/a.jpg',
    '../a.jpg',
    '//cdn.example.com/a.jpg',
    'blob:https://example.com/0f1e',
  ])('allows %s', (url) => {
    expect(isSafeMediaUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'java\nscript:alert(1)',
    ' JavaScript:alert(1)',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
  ])('rejects %j', (url) => {
    expect(isSafeMediaUrl(url, 'image')).toBe(false);
  });

  it('allows data: URLs only for the matching media kind', () => {
    expect(isSafeMediaUrl('data:image/png;base64,AAAA', 'image')).toBe(true);
    expect(isSafeMediaUrl('data:image/png;base64,AAAA', 'video')).toBe(false);
    expect(isSafeMediaUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isSafeMediaUrl('data:audio/mpeg;base64,AAAA', 'audio')).toBe(true);
  });
});

describe('TimelineMediaSchema URL validation', () => {
  const timelineWith = (media: unknown) => ({
    id: 'tl',
    title: 'T',
    events: [{ id: 'e1', date: { start: '2000' }, title: 'E', media: [media] }],
  });

  it('rejects javascript: in an oembed url', () => {
    const result = validateTimeline(timelineWith({ type: 'oembed', url: 'javascript:alert(1)' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.issues[0]?.path).toEqual(['events', 0, 'media', 0, 'url']);
    }
  });

  it('rejects an unsafe thumbnail', () => {
    const result = validateTimeline(
      timelineWith({ type: 'image', url: 'a.png', thumbnail: 'javascript:alert(1)' }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts relative image paths and data:image URLs', () => {
    expect(validateTimeline(timelineWith({ type: 'image', url: 'img/a.png' })).success).toBe(true);
    expect(
      validateTimeline(timelineWith({ type: 'image', url: 'data:image/png;base64,AAAA' })).success,
    ).toBe(true);
  });
});
