import { strToU8, zipSync, type Zippable } from 'fflate';
import {
  repairTimelineDates,
  validateTimeline,
  type Timeline,
  type TimelineMedia,
} from '@chronicle/schema';
import { renderTimelinePage } from './page.js';
import { PAGE_CSS } from './styles.js';

/**
 * Static site export: one timeline as a folder of plain files that works
 * opened straight from disk (`file://`), from any static host, and without a
 * network connection — built to stay readable for decades.
 *
 * ```
 * index.html                  server-rendered, readable without JavaScript
 * timeline.json               the Chronicle document (open format, re-importable)
 * assets/chronicle-timeline.js the interactive <chronicle-timeline> (classic script)
 * assets/chronicle.css
 * media/<sha256>.<ext>        copies of images, video and audio
 * manifest.json               what is in the export, with SHA-256 checksums
 * README.txt
 * ```
 *
 * The page has no inline script and carries a strict CSP. Media is copied
 * only for known image/video/audio types (never SVG or HTML, which can carry
 * script); anything else keeps its original URL and is listed in the report.
 */

export const STATIC_EXPORT_FORMAT = 1;

export interface FetchedMedia {
  bytes: Uint8Array;
  /** The response Content-Type (parameters are ignored). */
  mimeType: string;
}

/** Fetches a media URL for inclusion; `null` (or a throw) keeps the original URL. */
export type MediaFetcher = (url: string) => Promise<FetchedMedia | null>;

export interface StaticSiteOptions {
  /** Source of the `<chronicle-timeline>` IIFE bundle (`@chronicle/web-component/cdn/iife`). */
  script: string;
  /** How to download remote media. Without it, only inline `data:` media is copied. */
  fetchMedia?: MediaFetcher;
  /** Copy media into the export (default true). */
  includeMedia?: boolean;
  /** Largest single media file to copy (default 25 MB). */
  maxMediaBytes?: number;
  /** Stop copying media after this many bytes in total (default 500 MB). */
  maxTotalMediaBytes?: number;
  /** Published version number, if exporting a published revision. */
  version?: number;
  /** Where the timeline came from (recorded in the manifest and README). */
  source?: string;
  exportedAt?: Date;
  /** Name of the tool that made the export, e.g. `Chronicle CLI 0.1.0`. */
  generator?: string;
}

export interface MediaReportEntry {
  url: string;
  status: 'included' | 'kept' | 'failed';
  /** Path inside the export, when included. */
  path?: string;
  reason?: string;
}

export interface StaticSite {
  /** Relative path → contents. */
  files: Map<string, Uint8Array>;
  /** The exported document (media URLs rewritten to the copies). */
  timeline: Timeline;
  media: MediaReportEntry[];
}

export class StaticExportError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'StaticExportError';
  }
}

/** Media types copied into exports, with their file extensions. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
};

const FRAME_SOURCES = [
  'https://www.youtube-nocookie.com',
  'https://player.vimeo.com',
  'https://www.google.com',
];

/** CSP for the exported page (a <meta> tag: static hosts and file:// send no headers). */
export const STATIC_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  `frame-src ${FRAME_SOURCES.join(' ')}`,
  "connect-src 'none'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

type Family = 'image' | 'video' | 'audio';

const baseMime = (mime: string) => mime.split(';')[0]?.trim().toLowerCase() ?? '';

function decodeDataUrl(url: string): FetchedMedia | null {
  const m = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  const [, mime = '', , base64, data = ''] = m;
  try {
    if (base64) {
      const binary = atob(data.replace(/\s+/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { bytes, mimeType: mime };
    }
    return { bytes: strToU8(decodeURIComponent(data)), mimeType: mime };
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isFetchable = (url: string) => {
  try {
    const parsed = new URL(url, 'https://chronicle.invalid/');
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

function readme(timeline: Timeline, options: StaticSiteOptions, exportedAt: Date): string {
  return `${timeline.title}
${'='.repeat(Math.min(timeline.title.length, 72))}

An archived copy of a Chronicle timeline, exported ${exportedAt.toISOString().slice(0, 10)}${
    options.version !== undefined ? ` (published version ${String(options.version)})` : ''
  }.
${options.source ? `Source: ${options.source}\n` : ''}
How to view it
--------------
Open index.html in any web browser. No internet connection or server is
needed: the page works when opened straight from this folder. To publish it,
upload the whole folder to any static web host.

What is inside
--------------
index.html     The timeline. Its events are plain HTML, so the content stays
               readable even without JavaScript.
timeline.json  The timeline data in the open Chronicle format
               (schemaVersion ${timeline.schemaVersion}). It can be imported into the Chronicle
               editor or read by any program that reads JSON.
assets/        The interactive timeline viewer and its stylesheet.
media/         Copies of the images, video and audio used by the events.
manifest.json  A list of every file with its SHA-256 checksum, so you can
               check that the archive is complete and unchanged.

Embedded videos (YouTube, Vimeo) and maps are not copied; they still need an
internet connection.
`;
}

/** Builds the files of a static site for `input` (validated first). */
export async function buildStaticSite(
  input: unknown,
  options: StaticSiteOptions,
): Promise<StaticSite> {
  const checked = validateTimeline(repairTimelineDates(input).timeline);
  if (!checked.success) {
    throw new StaticExportError(
      'The timeline does not match the Chronicle schema',
      checked.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  const timeline = structuredClone(checked.data);
  const exportedAt = options.exportedAt ?? new Date();
  const files = new Map<string, Uint8Array>();
  const report: MediaReportEntry[] = [];
  const done = new Map<string, MediaReportEntry>();
  const maxFile = options.maxMediaBytes ?? 25 * 1024 * 1024;
  const maxTotal = options.maxTotalMediaBytes ?? 500 * 1024 * 1024;
  let total = 0;

  /** Copies one URL into media/ (once per URL); returns the URL to use. */
  const localise = async (url: string, family: Family): Promise<string> => {
    const known = done.get(url);
    if (known) return known.path ?? url;
    const entry: MediaReportEntry = { url, status: 'kept' };
    done.set(url, entry);
    report.push(entry);

    let fetched: FetchedMedia | null = null;
    if (options.includeMedia === false) {
      entry.reason = 'Media copying is turned off';
      return url;
    }
    if (url.trim().toLowerCase().startsWith('data:')) {
      fetched = decodeDataUrl(url.trim());
      if (!fetched) {
        entry.status = 'failed';
        entry.reason = 'Unreadable data URL';
        return url;
      }
    } else if (!options.fetchMedia) {
      entry.reason = 'Not downloaded (no network access during export)';
      return url;
    } else if (!isFetchable(url)) {
      entry.reason = 'Not an http(s) URL';
      return url;
    } else {
      try {
        fetched = await options.fetchMedia(url);
      } catch (err) {
        fetched = null;
        entry.reason = err instanceof Error ? err.message : String(err);
      }
      if (!fetched) {
        entry.status = 'failed';
        entry.reason ??= 'Could not be downloaded';
        return url;
      }
    }

    const mime = baseMime(fetched.mimeType);
    const ext = EXTENSIONS[mime];
    if (!ext || !mime.startsWith(`${family}/`)) {
      entry.status = 'failed';
      entry.reason = `Not copied: ${mime || 'unknown type'} is not a supported ${family} format`;
      return url;
    }
    if (fetched.bytes.byteLength > maxFile) {
      entry.status = 'failed';
      entry.reason = `Not copied: larger than ${String(Math.round(maxFile / 1048576))} MB`;
      return url;
    }
    if (total + fetched.bytes.byteLength > maxTotal) {
      entry.status = 'failed';
      entry.reason = 'Not copied: the export reached its total media size limit';
      return url;
    }
    total += fetched.bytes.byteLength;
    const path = `media/${(await sha256Hex(fetched.bytes)).slice(0, 32)}.${ext}`;
    files.set(path, fetched.bytes);
    entry.status = 'included';
    entry.path = path;
    delete entry.reason;
    return path;
  };

  for (const evt of timeline.events) {
    const media: TimelineMedia[] = [];
    for (const item of evt.media) {
      const next = { ...item };
      if (item.type === 'image' || item.type === 'video' || item.type === 'audio') {
        next.url = await localise(item.url, item.type);
      }
      if (item.thumbnail) next.thumbnail = await localise(item.thumbnail, 'image');
      media.push(next);
    }
    evt.media = media;
  }

  const date = exportedAt.toISOString().slice(0, 10);
  const html = renderTimelinePage({
    timeline,
    assets: { script: 'assets/chronicle-timeline.js', stylesheet: 'assets/chronicle.css' },
    indexable: true,
    csp: STATIC_CSP,
    version: options.version,
    footer: `Archived copy exported ${date}${
      options.version !== undefined ? ` · version ${String(options.version)}` : ''
    } · made with Chronicle`,
  });

  files.set('index.html', strToU8(html));
  files.set('timeline.json', strToU8(`${JSON.stringify(timeline, null, 2)}\n`));
  files.set('assets/chronicle-timeline.js', strToU8(options.script));
  files.set('assets/chronicle.css', strToU8(PAGE_CSS));
  files.set('README.txt', strToU8(readme(timeline, options, exportedAt)));

  const listed = await Promise.all(
    [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(async ([path, bytes]) => ({
        path,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      })),
  );
  const manifest = {
    format: STATIC_EXPORT_FORMAT,
    generator: options.generator ?? 'Chronicle',
    exportedAt: exportedAt.toISOString(),
    ...(options.source ? { source: options.source } : {}),
    ...(options.version !== undefined ? { version: options.version } : {}),
    timeline: {
      title: timeline.title,
      schemaVersion: timeline.schemaVersion,
      events: timeline.events.length,
    },
    files: listed,
    media: report,
  };
  files.set('manifest.json', strToU8(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, timeline, media: report };
}

/** A folder name derived from the title (`space-race`). */
export function siteFolderName(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'timeline'
  );
}

/**
 * Zips a site. Files go under `folder/` so unzipping makes one directory.
 * Media is stored without recompression (it is already compressed).
 */
export function zipStaticSite(
  site: Pick<StaticSite, 'files'>,
  folder?: string,
  modified: Date = new Date(),
): Uint8Array {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const entries: Zippable = {};
  for (const [path, bytes] of site.files) {
    entries[`${prefix}${path}`] = [bytes, { level: path.startsWith('media/') ? 0 : 6 }];
  }
  return zipSync(entries, { mtime: modified });
}
