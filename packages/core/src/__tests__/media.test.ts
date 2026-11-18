import { describe, it, expect } from 'vitest';
import { getOEmbedUrl } from '../media.js';

describe('getOEmbedUrl', () => {
  it.each([
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    ['https://youtu.be/dQw4w9WgXcQ?t=10', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    [
      'https://m.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://vimeo.com/channels/staffpicks/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://www.google.com/maps/embed?pb=!1m18', 'https://www.google.com/maps/embed?pb=!1m18'],
  ])('maps %s', (input, expected) => {
    expect(getOEmbedUrl(input)).toBe(expected);
  });

  it.each([
    // Previously returned verbatim because the check was a substring match.
    'javascript:alert(1)//google.com/maps/embed',
    'javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ',
    // Look-alike hosts.
    'https://google.com.evil.example/maps/embed',
    'https://evil-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://evil.example/?u=youtube.com/watch?v=dQw4w9WgXcQ',
    // Unknown providers are never embedded.
    'https://example.com/video',
    'relative/path',
    'data:text/html,<script>alert(1)</script>',
  ])('refuses %j', (input) => {
    expect(getOEmbedUrl(input)).toBeNull();
  });

  it('rejects malformed YouTube ids', () => {
    expect(getOEmbedUrl('https://www.youtube.com/watch?v=short')).toBeNull();
  });
});
