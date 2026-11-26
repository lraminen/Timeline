import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { embedUrlFor, run, type Io } from '../run.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const timeline = (media: { type: string; url: string; alt?: string }[] = []) => ({
  schemaVersion: '1.0.0',
  id: 't',
  title: 'Moon Landings',
  settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  eras: [],
  events: [
    { id: 'a11', title: 'Apollo 11', date: { start: '1969-07-20' }, media, tags: [] },
    { id: 'a12', title: 'Apollo 12', date: { start: '1969-11-19' }, media: [], tags: [] },
  ],
});

let dir: string;
let out: string[];
let err: string[];

function io(fetchImpl: typeof fetch = vi.fn()): Io {
  return {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    cwd: dir,
    env: {},
    fetch: fetchImpl,
  };
}

const write = (name: string, value: unknown) => {
  writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'chronicle-cli-'));
  out = [];
  err = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('chronicle', () => {
  it('prints help and rejects unknown commands', async () => {
    expect(await run([], io())).toBe(0);
    expect(out.join('')).toContain('chronicle export <source>');
    expect(await run(['frobnicate'], io())).toBe(2);
    expect(err.join('')).toContain('Unknown command');
    expect(await run(['export', '--bogus'], io())).toBe(2);
  });

  it('validates timelines', async () => {
    write('good.json', timeline());
    write('bad.json', {
      ...timeline(),
      events: [{ id: 'x', title: '', date: { start: 'later' } }],
    });
    write('tljs.json', { events: [{ start_date: { year: 1969 }, text: { headline: 'A' } }] });
    write('broken.json', '{ nope');
    expect(await run(['validate', 'good.json'], io())).toBe(0);
    expect(out.join('')).toContain('valid Chronicle timeline “Moon Landings” with 2 events');
    expect(await run(['validate', 'bad.json'], io())).toBe(1);
    expect(err.join('')).toMatch(/events\.0\.title/);
    expect(await run(['validate', 'tljs.json'], io())).toBe(1);
    expect(err.join('')).toContain('chronicle migrate');
    expect(await run(['validate', 'broken.json'], io())).toBe(1);
    expect(await run(['validate', 'missing.json'], io())).toBe(1);
  });

  it('converts TimelineJS files', async () => {
    write('tljs.json', {
      title: { text: { headline: 'Space' } },
      events: [{ start_date: { year: 1969, month: 7, day: 20 }, text: { headline: 'Apollo 11' } }],
    });
    expect(await run(['migrate', 'tljs.json'], io())).toBe(0);
    const converted = JSON.parse(out.join('')) as {
      events: { title: string; date: { start: string } }[];
    };
    expect(converted.events[0]).toMatchObject({
      title: 'Apollo 11',
      date: { start: '1969-07-20' },
    });
    expect(await run(['migrate', 'tljs.json', '-o', 'out.json'], io())).toBe(0);
    expect(existsSync(path.join(dir, 'out.json'))).toBe(true);
  });

  it('exports a local file to a folder, copying media from beside it', async () => {
    mkdirSync(path.join(dir, 'images'));
    writeFileSync(path.join(dir, 'images', 'moon.png'), PNG);
    writeFileSync(path.join(path.dirname(dir), 'secret.png'), PNG);
    write(
      'moon.json',
      timeline([
        { type: 'image', url: 'images/moon.png', alt: 'Moon' },
        { type: 'image', url: '../secret.png', alt: 'Outside' },
      ]),
    );
    expect(await run(['export', 'moon.json'], io())).toBe(0);
    const site = path.join(dir, 'moon-landings');
    const html = readFileSync(path.join(site, 'index.html'), 'utf8');
    expect(html).toContain('<chronicle-timeline');
    expect(readFileSync(path.join(site, 'assets', 'chronicle-timeline.js'), 'utf8')).toContain(
      'chronicle-timeline',
    );
    const doc = JSON.parse(readFileSync(path.join(site, 'timeline.json'), 'utf8')) as ReturnType<
      typeof timeline
    >;
    expect(doc.events[0]?.media[0]?.url).toMatch(/^media\/[0-9a-f]+\.png$/);
    // Files outside the timeline's folder are never read.
    expect(doc.events[0]?.media[1]?.url).toBe('../secret.png');
    expect(err.join('')).toContain('outside the timeline’s folder');
    expect(out.join('')).toContain('1 media files');

    // A second export refuses to overwrite, unless forced.
    expect(await run(['export', 'moon.json'], io())).toBe(1);
    expect(err.join('')).toContain('not empty');
    expect(await run(['export', 'moon.json', '--force'], io())).toBe(0);
    rmSync(path.join(path.dirname(dir), 'secret.png'));
  });

  it('exports to a zip', async () => {
    write('moon.json', timeline());
    expect(await run(['export', 'moon.json', '-o', 'archive.zip'], io())).toBe(0);
    const entries = unzipSync(readFileSync(path.join(dir, 'archive.zip')));
    expect(Object.keys(entries)).toContain('archive/index.html');
    expect(strFromU8(entries['archive/manifest.json'] ?? new Uint8Array())).toContain(
      '"generator": "Chronicle CLI',
    );
  });

  it('exports a published timeline from its page address', async () => {
    expect(embedUrlFor('https://chronicle.example/timeline/moon-x1/v/3')).toBe(
      'https://chronicle.example/api/v1/embed/moon-x1/v/3',
    );
    const fetchImpl = vi.fn((url: string) => {
      if (url.includes('/api/v1/embed/')) {
        return Promise.resolve(
          Response.json({
            version: 3,
            pageUrl: 'https://chronicle.example/timeline/moon-x1/v/3',
            timeline: timeline([{ type: 'image', url: '/media/p/abc/display.webp', alt: 'x' }]),
          }),
        );
      }
      return Promise.resolve(new Response(PNG, { headers: { 'content-type': 'image/webp' } }));
    }) as unknown as typeof fetch;
    expect(
      await run(
        ['export', 'https://chronicle.example/timeline/moon-x1/v/3', '-o', 'site'],
        io(fetchImpl),
      ),
    ).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://chronicle.example/media/p/abc/display.webp',
      expect.anything(),
    );
    const manifest = JSON.parse(readFileSync(path.join(dir, 'site', 'manifest.json'), 'utf8')) as {
      version: number;
      source: string;
    };
    expect(manifest).toMatchObject({
      version: 3,
      source: 'https://chronicle.example/timeline/moon-x1/v/3',
    });
  });

  it('exports a project draft with an API key', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ timeline: timeline() })));
    expect(await run(['export', '--server', 'https://c.example', '--project', 'p1'], io())).toBe(2);
    expect(err.join('')).toContain('needs --api-key');
    const ok = await run(
      [
        'export',
        '--server',
        'https://c.example/',
        '--project',
        'p1',
        '--api-key',
        'chr_k',
        '-o',
        'd',
      ],
      io(fetchImpl),
    );
    expect(ok).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith('https://c.example/api/v1/projects/p1/draft', {
      headers: { accept: 'application/json', 'x-api-key': 'chr_k' },
    });
  });

  it('reports server errors clearly', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: { message: 'Timeline not found' } }, { status: 404 })),
    );
    expect(
      await run(
        ['export', 'https://c.example/timeline/nope'],
        io(fetchImpl as unknown as typeof fetch),
      ),
    ).toBe(1);
    expect(err.join('')).toContain('HTTP 404: Timeline not found');
  });
});
