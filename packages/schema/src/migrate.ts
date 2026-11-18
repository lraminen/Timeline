import type { Timeline } from './timeline.js';
import type { TimelineEvent } from './event.js';
import type { TimelineMedia } from './media.js';
import type { TimelineDate } from './date.js';

// ---------------------------------------------------------------------------
// TimelineJS v3 input shapes (intentionally loose — we accept `unknown`)
// ---------------------------------------------------------------------------

interface TimelineJSDate {
  year?: number | string;
  month?: number | string;
  day?: number | string;
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
}

interface TimelineJSEvent {
  start_date?: TimelineJSDate;
  end_date?: TimelineJSDate;
  text?: TimelineJSText;
  media?: TimelineJSMedia;
  group?: string;
  unique_id?: string;
}

interface TimelineJSPayload {
  title?: TimelineJSEvent;
  events?: TimelineJSEvent[];
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
function formatYear(year: number | string): string {
  const raw = String(year).trim();
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const padded = digits.padStart(4, '0');
  return negative ? `-${padded}` : padded;
}

/**
 * Converts a TimelineJS date object `{ year, month, day }` into a partial-ISO
 * string understood by {@link TimelineDateSchema}.
 */
function convertDate(d: TimelineJSDate | undefined): string | undefined {
  if (d?.year === undefined) return undefined;

  const year = formatYear(d.year);

  if (d.month === undefined) return year;
  const month = String(d.month).padStart(2, '0');

  if (d.day === undefined) return `${year}-${month}`;
  const day = String(d.day).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * Converts a TimelineJS media object to a Chronicle {@link TimelineMedia}.
 * Returns `undefined` when the input has no usable URL.
 */
function convertMedia(m: TimelineJSMedia | undefined): TimelineMedia | undefined {
  if (!m?.url) return undefined;

  return {
    type: guessMediaType(m.url),
    url: m.url,
    caption: m.caption || undefined,
    credit: m.credit || undefined,
    thumbnail: m.thumbnail || undefined,
  };
}

/** Best-effort media type detection based on URL patterns. */
function guessMediaType(url: string): 'image' | 'video' | 'audio' | 'oembed' | 'map' {
  const lower = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/.test(lower)) return 'image';
  if (/\.(mp4|webm|ogv|mov)(\?|$)/.test(lower)) return 'video';
  if (/\.(mp3|ogg|wav|flac|aac)(\?|$)/.test(lower)) return 'audio';
  if (/google\.com\/maps|maps\.google|openstreetmap/.test(lower)) return 'map';
  // Default to oembed for YouTube, Vimeo, etc.
  return 'oembed';
}

/**
 * Converts a single TimelineJS event into a Chronicle {@link TimelineEvent}.
 */
function convertEvent(evt: TimelineJSEvent): TimelineEvent | undefined {
  const startStr = convertDate(evt.start_date);
  if (!startStr) return undefined; // cannot create an event without a date

  const title = evt.text?.headline ?? 'Untitled';

  const date: TimelineDate = {
    start: startStr,
    end: convertDate(evt.end_date) ?? undefined,
  };

  const media: TimelineMedia[] = [];
  const converted = convertMedia(evt.media);
  if (converted) media.push(converted);

  const event: TimelineEvent = {
    id: evt.unique_id ?? nextId(),
    date,
    title,
    body: evt.text?.text ?? undefined,
    media,
    tags: [],
    group: evt.group ?? undefined,
  };

  return event;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrates a TimelineJS v3 JSON payload into the Chronicle {@link Timeline}
 * format.
 *
 * @param data - Raw TimelineJS JSON (typically parsed from a JSON file).
 * @returns A Chronicle timeline object.
 * @throws If the input is not an object.
 */
export function migrateFromTimelineJS(data: unknown): Timeline {
  if (typeof data !== 'object' || data === null) {
    throw new Error('migrateFromTimelineJS expects a non-null object.');
  }

  const payload = data as TimelineJSPayload;

  // Build events list from the `events` array.
  const events: TimelineEvent[] = [];

  if (Array.isArray(payload.events)) {
    for (const raw of payload.events) {
      const evt = convertEvent(raw);
      if (evt) events.push(evt);
    }
  }

  // Derive a title from the title slide if present.
  const titleText = payload.title?.text?.headline ?? 'Imported Timeline';

  return {
    schemaVersion: '1.0.0',
    id: 'imported-timelinejs',
    title: titleText,
    description: payload.title?.text?.text ?? undefined,
    events,
    eras: [],
    settings: {
      layout: 'vertical',
      theme: 'light',
      locale: 'en',
    },
  };
}
