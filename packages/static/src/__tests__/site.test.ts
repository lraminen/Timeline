import { describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { validateTimeline } from '@chronicle/schema';
import {
  buildStaticSite,
  siteFolderName,
  StaticExportError,
  STATIC_CSP,
  zipStaticSite,
  type MediaFetcher,
} from '../index.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pngDataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`;

const timeline = () => ({
  schemaVersion: '1.0.0',
  id: 'tl',
  title: 'Space Race',
  description: 'From *Sputnik* to Apollo',
  settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  eras: [],
  events: [
    {
      id: 'sputnik',
      date: { start: '1957-10-04' },
      title: 'Sputnik 1',
      body: 'First **satellite**.',
      media: [{ type: 'image', url: pngDataUrl, alt: 'Sputnik' }],
      tags: ['ussr'],
    },
    {
      id: 'apollo',
      date: { start: '1969-07-20' },
      title: 'Apollo 11',
      media: [
        { type: 'image', url: 'https://images.example/apollo.jpg', alt: 'Moon' },
        { type: 'image', url: 'https://images.example/apollo.jpg', alt: 'Same photo again' },
        { type: 'oembed', url: 'https://www.youtube.com/watch?v=abc' },
      ],
      tags: [],
    },
  ],
});

const SCRIPT = '/* chronicle-timeline bundle */';
const text = (bytes: Uint8Array | undefined) => (bytes ? strFromU8(bytes) : '');

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('buildStaticSite', () => {
  it('writes a self-contained site with a manifest of checksums', async () => {
    const site = await buildStaticSite(timeline(), {
      script: SCRIPT,
      exportedAt: new Date('2026-11-26T10:00:00Z'),
      version: 3,
      source: 'https://chronicle.example/timeline/space-race',
      generator: 'Test',
    });
    const paths = [...site.files.keys()].sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'README.txt',
        'assets/chronicle-timeline.js',
        'assets/chronicle.css',
        'index.html',
        'manifest.json',
        'timeline.json',
      ]),
    );
    expect(text(site.files.get('assets/chronicle-timeline.js'))).toBe(SCRIPT);

    const manifest = JSON.parse(text(site.files.get('manifest.json'))) as {
      format: number;
      version: number;
      timeline: { title: string; events: number };
      files: { path: string; bytes: number; sha256: string }[];
    };
    expect(manifest).toMatchObject({
      format: 1,
      version: 3,
      timeline: { title: 'Space Race', events: 2 },
    });
    // Every file except the manifest is listed with a correct checksum.
    expect(manifest.files.map((f) => f.path).sort()).toEqual(
      paths.filter((p) => p !== 'manifest.json'),
    );
    for (const f of manifest.files) {
      const bytes = site.files.get(f.path);
      expect(bytes?.byteLength).toBe(f.bytes);
      if (bytes) expect(await sha256(bytes)).toBe(f.sha256);
    }
    expect(text(site.files.get('README.txt'))).toContain('published version 3');
  });

  it('renders a page that needs no server, no network and no inline script', async () => {
    const site = await buildStaticSite(timeline(), { script: SCRIPT });
    const html = text(site.files.get('index.html'));
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP.replace(/'/g, '&#39;')}">`,
    );
    expect(html).toContain('<script src="assets/chronicle-timeline.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="assets/chronicle.css">');
    expect(html).not.toContain('rel="canonical"');
    // Only data scripts inline (JSON for the component and schema.org).
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.every((attrs) => /type="application\/(ld\+)?json"/.test(attrs ?? ''))).toBe(
      true,
    );
    // The no-JS fallback has the events in date order.
    expect(html.indexOf('Sputnik 1')).toBeLessThan(html.indexOf('Apollo 11'));
    expect(html).toContain('<strong>satellite</strong>');
    expect(html).toContain('Archived copy exported');
  });

  it('escapes hostile content', async () => {
    const t = timeline();
    t.title = '</script><script>alert(1)</script>';
    t.events[0] = {
      ...t.events[0],
      body: '<img src=x onerror=alert(1)> [x](javascript:alert(1))',
    } as (typeof t.events)[0];
    const site = await buildStaticSite(t, { script: SCRIPT });
    const html = text(site.files.get('index.html'));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toContain('href="javascript:');
  });

  it('copies media into media/, de-duplicated, and rewrites the document', async () => {
    const fetchMedia = vi.fn<MediaFetcher>(() =>
      Promise.resolve({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 1]), mimeType: 'image/jpeg' }),
    );
    const site = await buildStaticSite(timeline(), { script: SCRIPT, fetchMedia });
    expect(fetchMedia).toHaveBeenCalledOnce();
    const media = [...site.files.keys()].filter((p) => p.startsWith('media/'));
    expect(media).toHaveLength(2);
    expect(media.some((p) => p.endsWith('.png'))).toBe(true);
    expect(media.some((p) => p.endsWith('.jpg'))).toBe(true);

    const doc = JSON.parse(text(site.files.get('timeline.json'))) as ReturnType<typeof timeline>;
    expect(validateTimeline(doc).success).toBe(true);
    expect(doc.events[0]?.media[0]?.url).toMatch(/^media\/[0-9a-f]{32}\.png$/);
    expect(doc.events[1]?.media[0]?.url).toBe(doc.events[1]?.media[1]?.url);
    // Embeds are kept as links to the provider.
    expect(doc.events[1]?.media[2]?.url).toBe('https://www.youtube.com/watch?v=abc');
    const html = text(site.files.get('index.html'));
    expect(html).toMatch(/<img src="media\/[0-9a-f]{32}\.(png|jpg)"/);
    expect(site.media.map((m) => m.status)).toEqual(['included', 'included']);
  });

  it('refuses unsafe or unexpected media and reports why', async () => {
    const t = timeline();
    t.events[1] = {
      ...t.events[1],
      media: [
        { type: 'image', url: 'https://images.example/logo.svg' },
        { type: 'video', url: 'https://images.example/not-a-video.jpg' },
        { type: 'image', url: 'https://images.example/huge.png' },
        { type: 'image', url: 'https://images.example/missing.png' },
      ],
    } as (typeof t.events)[1];
    const fetchMedia: MediaFetcher = (url) => {
      if (url.endsWith('.svg')) {
        return Promise.resolve({ bytes: new Uint8Array([1]), mimeType: 'image/svg+xml' });
      }
      if (url.includes('not-a-video')) {
        return Promise.resolve({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg' });
      }
      if (url.includes('huge')) {
        return Promise.resolve({ bytes: new Uint8Array(2048), mimeType: 'image/png' });
      }
      return Promise.reject(new Error('HTTP 404'));
    };
    const site = await buildStaticSite(t, { script: SCRIPT, fetchMedia, maxMediaBytes: 1024 });
    const byUrl = new Map(site.media.map((m) => [m.url, m]));
    expect(byUrl.get('https://images.example/logo.svg')?.reason).toMatch(/image\/svg\+xml/);
    expect(byUrl.get('https://images.example/not-a-video.jpg')?.reason).toMatch(/video format/);
    expect(byUrl.get('https://images.example/huge.png')?.reason).toMatch(/larger than/);
    expect(byUrl.get('https://images.example/missing.png')).toMatchObject({
      status: 'failed',
      reason: 'HTTP 404',
    });
    // Failed items keep their original URLs.
    const doc = JSON.parse(text(site.files.get('timeline.json'))) as ReturnType<typeof timeline>;
    expect(doc.events[1]?.media.map((m) => m.url)).toEqual([
      'https://images.example/logo.svg',
      'https://images.example/not-a-video.jpg',
      'https://images.example/huge.png',
      'https://images.example/missing.png',
    ]);
  });

  it('can leave media where it is', async () => {
    const site = await buildStaticSite(timeline(), { script: SCRIPT, includeMedia: false });
    expect([...site.files.keys()].some((p) => p.startsWith('media/'))).toBe(false);
    expect(site.media.every((m) => m.status === 'kept')).toBe(true);
  });

  it('rejects documents that are not valid timelines', async () => {
    const bad = { ...timeline(), events: [{ id: 'x', title: '', date: { start: 'soon' } }] };
    const err = await buildStaticSite(bad, { script: SCRIPT }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaticExportError);
    expect((err as StaticExportError).issues.length).toBeGreaterThan(0);
  });
});

describe('zipStaticSite', () => {
  it('zips everything under one folder', async () => {
    const site = await buildStaticSite(timeline(), { script: SCRIPT });
    const zip = zipStaticSite(site, 'space-race');
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual(
      [...site.files.keys()].map((p) => `space-race/${p}`).sort(),
    );
    expect(strFromU8(entries['space-race/index.html'] ?? new Uint8Array())).toContain(
      '<chronicle-timeline',
    );
  });

  it('derives folder names from titles', () => {
    expect(siteFolderName('Révolution française: 1789–1799')).toBe(
      'revolution-francaise-1789-1799',
    );
    expect(siteFolderName('!!!')).toBe('timeline');
  });
});
