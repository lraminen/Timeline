import Papa from 'papaparse';
import {
  compareDates,
  isSafeMediaUrl,
  type TimelineEra,
  type TimelineEvent,
  type TimelineMedia,
} from '@chronicle/schema';
import { newId } from './ids.js';
import { formatDateParts, validateParts, type DateParts } from './dates.js';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface CsvTable {
  headers: string[];
  rows: string[][];
}

/** Parses CSV text; the first non-empty row is the header row. */
export function parseCsv(text: string): CsvTable {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    skipEmptyLines: 'greedy',
  });
  const [head = [], ...rows] = result.data;
  const headers = head.map((h, i) => h.trim() || `Column ${String(i + 1)}`);
  const width = headers.length;
  return {
    headers,
    rows: rows.map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim())),
  };
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

export const CSV_FIELDS = [
  { key: 'title', label: 'Title', required: true },
  { key: 'start', label: 'Start date', required: true },
  { key: 'end', label: 'End date' },
  { key: 'displayDate', label: 'Display date label' },
  { key: 'approximate', label: 'Approximate (yes/no)' },
  { key: 'uncertain', label: 'Uncertain (yes/no)' },
  { key: 'body', label: 'Description' },
  { key: 'tags', label: 'Tags' },
  { key: 'era', label: 'Era' },
  { key: 'mediaUrl', label: 'Media URL' },
  { key: 'mediaType', label: 'Media type' },
  { key: 'mediaAlt', label: 'Media alt text' },
  { key: 'mediaCaption', label: 'Media caption' },
  { key: 'mediaCredit', label: 'Media credit' },
  { key: 'lat', label: 'Latitude' },
  { key: 'lng', label: 'Longitude' },
  { key: 'locationLabel', label: 'Place name' },
  { key: 'id', label: 'ID' },
] as const;

export type CsvFieldKey = (typeof CSV_FIELDS)[number]['key'];
/** Field → column index. */
export type ColumnMapping = Partial<Record<CsvFieldKey, number>>;

const SYNONYMS: Record<CsvFieldKey, string[]> = {
  title: ['title', 'headline', 'name', 'event', 'event title', 'event name'],
  start: ['start', 'start date', 'start_date', 'date', 'from', 'begin', 'year', 'when'],
  end: ['end', 'end date', 'end_date', 'to', 'until', 'finish'],
  displayDate: ['display date', 'display_date', 'date label', 'display'],
  approximate: ['approximate', 'approx', 'circa'],
  uncertain: ['uncertain', 'unsure'],
  body: ['body', 'description', 'text', 'details', 'summary', 'notes', 'content'],
  tags: ['tags', 'tag', 'categories', 'category', 'keywords', 'labels'],
  era: ['era', 'period', 'epoch', 'phase'],
  mediaUrl: ['media', 'media url', 'media_url', 'image', 'image url', 'url', 'video', 'link'],
  mediaType: ['media type', 'media_type', 'type'],
  mediaAlt: ['alt', 'alt text', 'media alt', 'media_alt', 'image alt'],
  mediaCaption: ['caption', 'media caption', 'media_caption'],
  mediaCredit: ['credit', 'media credit', 'media_credit', 'source', 'attribution'],
  lat: ['lat', 'latitude'],
  lng: ['lng', 'lon', 'long', 'longitude'],
  locationLabel: ['location', 'place', 'place name', 'location label', 'location_label'],
  id: ['id', 'unique_id', 'uid', 'event id'],
};

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();

/** Guesses a mapping from header names (each column used at most once). */
export function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<number>();
  const norm = headers.map(normalise);
  for (const { key } of CSV_FIELDS) {
    const candidates = SYNONYMS[key].map(normalise);
    const index = norm.findIndex((h, i) => !used.has(i) && candidates.includes(h));
    if (index !== -1) {
      mapping[key] = index;
      used.add(index);
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export type SlashOrder = 'dmy' | 'mdy';

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function monthFromName(name: string): number | undefined {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (n.length < 3) return undefined;
  const index = MONTHS.findIndex((m) => m.startsWith(n) || (n === 'sept' && m === 'september'));
  return index === -1 ? undefined : index + 1;
}

const ISO = /^(-?)(\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2})(?:[T\s].*)?)?)?$/;
const SLASH = /^(\d{1,2})[/.](\d{1,2})[/.](\d{1,6})$/;
const MONTH_FIRST = /^([A-Za-z.]+)\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{1,6})$/;
const DAY_FIRST = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z.]+),?\s+(\d{1,6})$/;
const ERA_SUFFIX = /\s*\b(B\.?C\.?E?\.?|BCE|BC|C\.?E\.?|CE|A\.?D\.?|AD)$/i;
const CIRCA_PREFIX = /^(?:c\.|ca\.|circa|~|approx\.?)\s*/i;

export interface ParsedDate {
  value: string;
  approximate: boolean;
}

/**
 * Parses a human date into a Chronicle partial-ISO string. Understands ISO
 * (`1969`, `1969-07`, `1969-07-20`, `-0044`), slash/dot dates in the given
 * order, English month names (`July 20, 1969`, `20 July 1969`, `July 1969`),
 * `BC`/`BCE`/`AD`/`CE` suffixes and `c.`/`circa`/`~` prefixes.
 */
export function parseDateValue(raw: string, slashOrder: SlashOrder = 'mdy'): ParsedDate | null {
  let text = raw.trim();
  if (!text) return null;

  let approximate = false;
  if (CIRCA_PREFIX.test(text)) {
    approximate = true;
    text = text.replace(CIRCA_PREFIX, '');
  }

  let bce = false;
  const era = ERA_SUFFIX.exec(text);
  if (era) {
    bce = /^B/i.test(era[1]);
    text = text.slice(0, era.index).trim();
  }

  let parts: DateParts | null = null;
  let m: RegExpExecArray | null;
  if ((m = ISO.exec(text))) {
    const negative = m[1] === '-';
    parts = {
      year: Number(m[2]),
      bce: bce || negative,
      month: m[3] ? Number(m[3]) : undefined,
      day: m[4] ? Number(m[4]) : undefined,
    };
  } else if ((m = SLASH.exec(text))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const [day, month] = slashOrder === 'dmy' ? [a, b] : [b, a];
    parts = { year: Number(m[3]), bce, month, day };
  } else if ((m = MONTH_FIRST.exec(text))) {
    const month = monthFromName(m[1]);
    if (month) parts = { year: Number(m[3]), bce, month, day: m[2] ? Number(m[2]) : undefined };
  } else if ((m = DAY_FIRST.exec(text))) {
    const month = monthFromName(m[2]);
    if (month) parts = { year: Number(m[3]), bce, month, day: Number(m[1]) };
  }

  if (!parts || validateParts(parts)) return null;
  return { value: formatDateParts(parts), approximate };
}

export interface SlashDetection {
  /** Whether any values use slash/dot dates at all. */
  present: boolean;
  order: SlashOrder;
  /** True when no value disambiguates (e.g. only 03/04/2020-style dates). */
  ambiguous: boolean;
}

/** Infers day/month order from values like `25/12/2020` (must be DMY). */
export function detectSlashOrder(values: string[]): SlashDetection {
  let dmy = 0;
  let mdy = 0;
  let present = false;
  for (const v of values) {
    const m = SLASH.exec(v.trim().replace(ERA_SUFFIX, '').replace(CIRCA_PREFIX, ''));
    if (!m) continue;
    present = true;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy > 0 && mdy === 0) return { present, order: 'dmy', ambiguous: false };
  if (mdy > 0 && dmy === 0) return { present, order: 'mdy', ambiguous: false };
  return { present, order: 'mdy', ambiguous: present };
}

// ---------------------------------------------------------------------------
// Rows → events
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'x', '✓']);

export function guessMediaType(url: string): TimelineMedia['type'] {
  const lower = url.toLowerCase();
  if (/\.(jpe?g|png|gif|webp|svg|avif)(\?|#|$)/.test(lower) || lower.startsWith('data:image/'))
    return 'image';
  if (/\.(mp4|webm|ogv|mov)(\?|#|$)/.test(lower)) return 'video';
  if (/\.(mp3|ogg|wav|flac|aac|m4a)(\?|#|$)/.test(lower)) return 'audio';
  if (/google\.[a-z.]+\/maps|openstreetmap\.org/.test(lower)) return 'map';
  return 'oembed';
}

const MEDIA_TYPES = new Set<TimelineMedia['type']>(['image', 'video', 'audio', 'oembed', 'map']);

export interface RowError {
  /** 1-based line in the CSV file (header is line 1). */
  line: number;
  message: string;
  /** Whether the row was skipped entirely (vs. a field being dropped). */
  skipped: boolean;
}

export interface CsvConversion {
  events: TimelineEvent[];
  /** Eras created for era names not found in the document. */
  newEras: TimelineEra[];
  errors: RowError[];
}

/**
 * Converts mapped CSV rows into events. Rows without a title or a parseable
 * start date are skipped; invalid optional fields are dropped with an error.
 */
export function rowsToEvents(
  table: CsvTable,
  mapping: ColumnMapping,
  options: { slashOrder: SlashOrder; existingEras: TimelineEra[]; existingIds?: Set<string> },
): CsvConversion {
  const events: TimelineEvent[] = [];
  const errors: RowError[] = [];
  const usedIds = new Set(options.existingIds ?? []);
  const eraByKey = new Map<string, TimelineEra>();
  for (const era of options.existingEras) {
    eraByKey.set(era.id.toLowerCase(), era);
    eraByKey.set(era.title.toLowerCase(), era);
  }
  const newEras = new Map<string, { era: TimelineEra; dates: string[] }>();

  table.rows.forEach((row, i) => {
    const line = i + 2;
    const get = (key: CsvFieldKey): string => {
      const col = mapping[key];
      const value = col === undefined ? '' : (row[col] ?? '').trim();
      // Undo the formula-injection guard added by exportCsv ('=…, '-…).
      return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
    };
    const fail = (message: string, skipped = false): void => {
      errors.push({ line, message, skipped });
    };

    const title = get('title');
    if (!title) {
      fail('Missing title — row skipped', true);
      return;
    }
    const startRaw = get('start');
    const start = parseDateValue(startRaw, options.slashOrder);
    if (!start) {
      fail(
        startRaw
          ? `Unrecognised start date “${startRaw}” — row skipped`
          : 'Missing start date — row skipped',
        true,
      );
      return;
    }

    const event: TimelineEvent = {
      id: '',
      date: { start: start.value },
      title,
      media: [],
      tags: [],
    };

    const endRaw = get('end');
    if (endRaw) {
      const end = parseDateValue(endRaw, options.slashOrder);
      if (!end) fail(`Unrecognised end date “${endRaw}” — ignored`);
      else if (compareDates({ start: end.value }, { start: start.value }) < 0)
        fail('End date is before start date — ignored');
      else event.date.end = end.value;
    }
    if (start.approximate || TRUTHY.has(get('approximate').toLowerCase()))
      event.date.approximate = true;
    if (TRUTHY.has(get('uncertain').toLowerCase())) event.date.uncertain = true;
    const display = get('displayDate');
    if (display) event.date.displayOverride = display;

    const body = get('body');
    if (body) event.body = body;

    const tags = get('tags');
    if (tags)
      event.tags = [
        ...new Set(
          tags
            .split(/[,;|]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ];

    const eraName = get('era');
    if (eraName) {
      const key = eraName.toLowerCase();
      let era = eraByKey.get(key);
      if (!era) {
        const created = newEras.get(key) ?? {
          era: { id: newId(), title: eraName, start: '', end: '' },
          dates: [],
        };
        newEras.set(key, created);
        created.dates.push(start.value, event.date.end ?? start.value);
        era = created.era;
      }
      event.era = era.id;
    }

    const url = get('mediaUrl');
    if (url) {
      const typeRaw = get('mediaType').toLowerCase() as TimelineMedia['type'];
      const type = MEDIA_TYPES.has(typeRaw) ? typeRaw : guessMediaType(url);
      const dataKind = type === 'image' || type === 'video' || type === 'audio' ? type : undefined;
      if (!isSafeMediaUrl(url, dataKind)) {
        fail('Media URL uses an unsupported scheme — media dropped');
      } else {
        const media: TimelineMedia = { type, url };
        const alt = get('mediaAlt');
        const caption = get('mediaCaption');
        const credit = get('mediaCredit');
        if (alt) media.alt = alt;
        if (caption) media.caption = caption;
        if (credit) media.credit = credit;
        event.media = [media];
      }
    }

    const latRaw = get('lat');
    const lngRaw = get('lng');
    if (latRaw || lngRaw) {
      const lat = Number(latRaw);
      const lng = Number(lngRaw);
      if (
        !latRaw ||
        !lngRaw ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      ) {
        fail('Invalid latitude/longitude — location dropped');
      } else {
        event.location = { lat, lng };
        const label = get('locationLabel');
        if (label) event.location.label = label;
      }
    } else if (get('locationLabel')) {
      fail('Place name without coordinates — location dropped');
    }

    const id = get('id');
    if (id && !usedIds.has(id)) {
      event.id = id;
    } else {
      if (id) fail(`Duplicate id “${id}” — a new id was generated`);
      event.id = newId();
    }
    usedIds.add(event.id);

    events.push(event);
  });

  // New eras span the dates of the events assigned to them.
  const eras = [...newEras.values()].map(({ era, dates }) => {
    const sorted = [...dates].sort((a, b) => compareDates({ start: a }, { start: b }));
    return { ...era, start: sorted[0], end: sorted.at(-1) ?? sorted[0] };
  });

  return { events, newEras: eras, errors };
}

/**
 * Converts a Google Sheets edit/share URL into its CSV export URL. The sheet
 * must be shared publicly ("Anyone with the link") for the export to work.
 * Other URLs are returned unchanged.
 */
export function toCsvUrl(url: string): string {
  const m = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(url.trim());
  if (!m || /\/pub\?|output=csv|format=csv/.test(url)) return url.trim();
  const gid = /[#&?]gid=(\d+)/.exec(url)?.[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}
