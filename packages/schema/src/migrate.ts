import type { Timeline } from './timeline.js';
import type { TimelineEvent } from './event.js';
import type { TimelineEra } from './era.js';
import type { TimelineMedia } from './media.js';
import type { TimelineDate } from './date.js';
import { isSafeMediaUrl } from './url.js';

// ---------------------------------------------------------------------------
// TimelineJS v3 input shapes (intentionally loose — we accept `unknown`)
// ---------------------------------------------------------------------------

interface TimelineJSDate {
  year?: number | string;
  month?: number | string;
  day?: number | string;
  display_date?: string;
}

interface TimelineJSText {
  headline?: string;
  text?: string;
}

interface TimelineJSMedia {
  url?: string;
  caption?: string;
  credit?: string;
  thumbnail?: string;
  alt?: string;
}

interface TimelineJSEvent {
  start_date?: TimelineJSDate;
  end_date?: TimelineJSDate;
  display_date?: string;
  text?: TimelineJSText;
  media?: TimelineJSMedia;
  group?: string;
  unique_id?: string;
  background?: unknown;
  autolink?: unknown;
}

interface TimelineJSEra {
  start_date?: TimelineJSDate;
  end_date?: TimelineJSDate;
  text?: TimelineJSText;
}

interface TimelineJSPayload {
  title?: TimelineJSEvent;
  events?: TimelineJSEvent[];
  eras?: TimelineJSEra[];
  scale?: string;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface MigrationWarning {
  /** Location in the source payload, e.g. `events[3].media.url`. */
  path: string;
  message: string;
  /** `info`: converted with changes. `warning`: data was dropped. */
  severity: 'info' | 'warning';
}

export interface MigrationReport {
  timeline: Timeline;
  warnings: MigrationWarning[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * RFC 4122 v4 UUID using the Web Crypto global, so this module runs in both
 * Node (>=19) and browsers. `randomUUID` is only exposed in secure contexts,
 * hence the `getRandomValues` fallback for plain-http pages.
 */
function nextId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pads a TimelineJS year to at least four digits, keeping a leading minus
 * for BCE years. `String(-44).padStart(4, "0")` would produce `"0-44"`.
 */
function formatYear(year: number | string): string | undefined {
  const raw = String(year).trim();
  if (!/^-?\d+$/.test(raw)) return undefined;
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(4, '0');
  return negative ? `-${padded}` : padded;
}

/**
 * Converts a TimelineJS date object `{ year, month, day }` into a partial-ISO
 * string understood by `TimelineDateSchema`.
 */
function convertDate(d: TimelineJSDate | undefined): string | undefined {
  if (d?.year === undefined) return undefined;

  const year = formatYear(d.year);
  if (!year) return undefined;

  if (d.month === undefined || d.month === '') return year;
  const month = String(d.month).padStart(2, '0');

  if (d.day === undefined || d.day === '') return `${year}-${month}`;
  const day = String(d.day).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** Best-effort media type detection based on URL patterns. */
function guessMediaType(url: string): TimelineMedia['type'] {
  const lower = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|webm|ogv|mov)(\?|$)/.test(lower)) return 'video';
  if (/\.(mp3|ogg|wav|flac|aac)(\?|$)/.test(lower)) return 'audio';
  if (/google\.com\/maps|maps\.google|openstreetmap/.test(lower)) return 'map';
  // Default to oembed for YouTube, Vimeo, etc.
  return 'oembed';
}

const HTML_TAG = /<\/?[a-z][^>]*>/i;

/**
 * Converts the small HTML subset TimelineJS authors typically use into
 * Markdown. The output is rendered by Chronicle's safe Markdown renderer, so
 * this is a formatting conversion, not a sanitiser; unknown tags are dropped.
 */
export function htmlToMarkdown(html: string): string {
  const decode = (s: string): string =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&');

  const md = html
    .replace(/\r\n?/g, '\n')
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '**$3**')
    .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, '*$3*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(
      /<a\s[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, _q: string, href: string, text: string) => `[${text}](${href})`,
    )
    .replace(/<[^>]+>/g, '');

  return decode(md)
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, (m) => (m.length >= 2 ? '  ' : '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertText(
  text: string | undefined,
  path: string,
  warnings: MigrationWarning[],
): string | undefined {
  if (!text?.trim()) return undefined;
  if (!HTML_TAG.test(text)) return text;
  warnings.push({ path, message: 'HTML formatting converted to Markdown', severity: 'info' });
  return htmlToMarkdown(text);
}

/** Headlines are plain text in Chronicle; strip any markup. */
function plainText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const stripped = htmlToMarkdown(text).replace(/[*`]/g, '').trim();
  return stripped || undefined;
}

function convertMedia(
  m: TimelineJSMedia | undefined,
  path: string,
  warnings: MigrationWarning[],
): TimelineMedia | undefined {
  if (!m?.url) return undefined;
  const type = guessMediaType(m.url);
  const dataKind = type === 'image' || type === 'video' || type === 'audio' ? type : undefined;

  if (!isSafeMediaUrl(m.url, dataKind)) {
    warnings.push({
      path: `${path}.url`,
      message: 'Media dropped: unsupported or unsafe URL scheme',
      severity: 'warning',
    });
    return undefined;
  }

  let thumbnail = m.thumbnail || undefined;
  if (thumbnail && !isSafeMediaUrl(thumbnail, 'image')) {
    warnings.push({
      path: `${path}.thumbnail`,
      message: 'Thumbnail dropped: unsupported or unsafe URL scheme',
      severity: 'warning',
    });
    thumbnail = undefined;
  }

  return {
    type,
    url: m.url,
    alt: m.alt || undefined,
    caption: plainText(m.caption),
    credit: plainText(m.credit),
    thumbnail,
  };
}

function convertEvent(
  evt: TimelineJSEvent,
  path: string,
  usedIds: Set<string>,
  warnings: MigrationWarning[],
): TimelineEvent | undefined {
  const start = convertDate(evt.start_date);
  if (!start) {
    warnings.push({
      path: `${path}.start_date`,
      message: 'Event skipped: missing or non-numeric start date',
      severity: 'warning',
    });
    return undefined;
  }

  const date: TimelineDate = { start, end: convertDate(evt.end_date) };
  if (evt.end_date && !date.end) {
    warnings.push({
      path: `${path}.end_date`,
      message: 'End date ignored: non-numeric year',
      severity: 'warning',
    });
  }
  const display = evt.display_date ?? evt.start_date?.display_date;
  if (display) date.displayOverride = display;

  const media: TimelineMedia[] = [];
  const converted = convertMedia(evt.media, `${path}.media`, warnings);
  if (converted) media.push(converted);

  let id = evt.unique_id;
  if (!id || usedIds.has(id)) {
    if (id) {
      warnings.push({
        path: `${path}.unique_id`,
        message: `Duplicate id "${id}" replaced with a new id`,
        severity: 'info',
      });
    }
    id = nextId();
  }
  usedIds.add(id);

  if (evt.background !== undefined) {
    warnings.push({
      path: `${path}.background`,
      message: 'Slide background is not supported and was dropped',
      severity: 'warning',
    });
  }

  return {
    id,
    date,
    title: plainText(evt.text?.headline) ?? 'Untitled',
    body: convertText(evt.text?.text, `${path}.text.text`, warnings),
    media,
    tags: [],
    group: evt.group ?? undefined,
  };
}

function convertEra(
  era: TimelineJSEra,
  path: string,
  warnings: MigrationWarning[],
): TimelineEra | undefined {
  const start = convertDate(era.start_date);
  const end = convertDate(era.end_date);
  if (!start || !end) {
    warnings.push({
      path,
      message: 'Era skipped: missing or non-numeric start/end date',
      severity: 'warning',
    });
    return undefined;
  }
  return { id: nextId(), title: plainText(era.text?.headline) ?? 'Era', start, end };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrates a TimelineJS v3 JSON payload into the Chronicle format and
 * reports everything that could not be carried over unchanged.
 *
 * @throws If the input is not an object.
 */
export function migrateFromTimelineJSWithReport(data: unknown): MigrationReport {
  if (typeof data !== 'object' || data === null) {
    throw new Error('migrateFromTimelineJS expects a non-null object.');
  }

  const payload = data as TimelineJSPayload;
  const warnings: MigrationWarning[] = [];
  const usedIds = new Set<string>();

  const events: TimelineEvent[] = [];
  if (Array.isArray(payload.events)) {
    payload.events.forEach((raw, i) => {
      const evt = convertEvent(raw, `events[${String(i)}]`, usedIds, warnings);
      if (evt) events.push(evt);
    });
  }

  const eras: TimelineEra[] = [];
  if (Array.isArray(payload.eras)) {
    payload.eras.forEach((raw, i) => {
      const era = convertEra(raw, `eras[${String(i)}]`, warnings);
      if (era) eras.push(era);
    });
  }

  if (payload.scale && payload.scale !== 'human') {
    warnings.push({
      path: 'scale',
      message: `Scale "${payload.scale}" is not supported; dates are treated as calendar dates`,
      severity: 'warning',
    });
  }
  if (payload.title?.media?.url) {
    warnings.push({
      path: 'title.media',
      message: 'Title slide media is not supported and was dropped',
      severity: 'warning',
    });
  }

  const timeline: Timeline = {
    schemaVersion: '1.0.0',
    id: 'imported-timelinejs',
    title: plainText(payload.title?.text?.headline) ?? 'Imported Timeline',
    description: convertText(payload.title?.text?.text, 'title.text.text', warnings),
    events,
    eras,
    settings: {
      layout: 'vertical',
      theme: 'light',
      locale: 'en',
    },
  };

  return { timeline, warnings };
}

/**
 * Migrates a TimelineJS v3 JSON payload into the Chronicle {@link Timeline}
 * format. Use {@link migrateFromTimelineJSWithReport} to also learn what was
 * dropped or changed.
 *
 * @throws If the input is not an object.
 */
export function migrateFromTimelineJS(data: unknown): Timeline {
  return migrateFromTimelineJSWithReport(data).timeline;
}
