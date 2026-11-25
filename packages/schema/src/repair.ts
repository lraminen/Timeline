import { isValidTimelineDateString } from './date.js';
import type { MigrationWarning } from './migrate.js';

/**
 * Migrates date strings written before calendar validation was added to
 * `TimelineDateSchema` (Phase 5). Older releases accepted any string, so stored
 * timelines can hold forms the schema now rejects. Without this step a single
 * such date stops the web component rendering the whole timeline and makes the
 * server refuse to save it.
 */

export interface RepairedDateString {
  /** The canonical date string. */
  value: string;
  /** True when part of the date (day, month or time of day) had to be dropped. */
  reducedPrecision: boolean;
  /** What was changed, for migration reports. */
  changes: string[];
}

// Year-first dates with `-`, `/` or `.` separators, optionally followed by a time of
// day after `T` or a space. Each group is bounded, so matching is linear.
const LEGACY_DATE =
  /^([+-]?)(\d{1,6})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2})(\.\d{1,9})?)?\s?(Z|[+-]\d{2}:?\d{2})?)?$/i;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/**
 * Converts a date string from an older release into the canonical form, or
 * returns `null` when it is not a recognisable year-first date.
 *
 * - Surrounding whitespace and a leading `+` are removed.
 * - Short years, months and days are zero-padded (`1969-7-20` → `1969-07-20`).
 * - `/` and `.` separators become `-`, and a space before the time becomes `T`.
 * - Year 0 becomes `-0001` (1 BCE). Chronicle counts BCE years historically, with no year 0.
 * - An impossible day (`1969-02-31`) is dropped, leaving the month. An impossible
 *   month is dropped, leaving the year. An impossible time of day is dropped.
 */
export function repairLegacyDateString(raw: string): RepairedDateString | null {
  if (isValidTimelineDateString(raw) && raw === raw.trim()) {
    return { value: raw, reducedPrecision: false, changes: [] };
  }
  const match = LEGACY_DATE.exec(raw.trim());
  if (!match) return null;
  // Optional groups are undefined when they did not take part in the match.
  const m = match as unknown as (string | undefined)[];

  const changes: string[] = [];
  let reducedPrecision = false;
  let bce = m[1] === '-';
  let year = Number(m[2] ?? 0);
  if (year === 0) {
    year = 1;
    bce = true;
    changes.push('year 0 read as 1 BCE');
  }
  let month = m[3] === undefined ? undefined : Number(m[3]);
  let day = m[4] === undefined ? undefined : Number(m[4]);
  const hasTime = m[5] !== undefined;

  let value = `${bce ? '-' : ''}${pad(year, 4)}`;

  if (month !== undefined && (month < 1 || month > 12)) {
    changes.push(`impossible month ${m[3] ?? ''} dropped`);
    reducedPrecision = true;
    month = undefined;
    day = undefined;
  }
  if (month !== undefined) {
    value += `-${pad(month, 2)}`;
    if (day !== undefined) {
      const candidate = `${value}-${pad(day, 2)}`;
      if (isValidTimelineDateString(candidate)) {
        value = candidate;
      } else {
        changes.push(`impossible day ${m[4] ?? ''} dropped`);
        reducedPrecision = true;
        day = undefined;
      }
    }
  }

  if (hasTime) {
    if (day === undefined) {
      changes.push('time of day dropped because the date has no day');
      reducedPrecision = true;
    } else {
      const seconds = m[7] === undefined ? '' : `:${pad(Number(m[7]), 2)}${m[8] ?? ''}`;
      const zone = m[9] ? m[9].toUpperCase() : '';
      const candidate = `${value}T${pad(Number(m[5]), 2)}:${pad(Number(m[6]), 2)}${seconds}${zone}`;
      if (isValidTimelineDateString(candidate)) {
        value = candidate;
      } else {
        changes.push('impossible time of day dropped');
        reducedPrecision = true;
      }
    }
  }

  if (!isValidTimelineDateString(value)) return null;
  if (value !== raw && changes.length === 0) changes.push('reformatted');
  return { value, reducedPrecision, changes };
}

export interface DateRepairReport<T> {
  /** The timeline with every repairable date migrated. The input is never mutated. */
  timeline: T;
  /** True when at least one date was changed. */
  changed: boolean;
  /** Dates that could not be recognised and were left unchanged; they still fail validation. */
  unrecognised: number;
  warnings: MigrationWarning[];
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;

interface RepairContext {
  warnings: MigrationWarning[];
  unrecognised: number;
}

function repairField(
  owner: Json,
  key: 'start' | 'end',
  path: string,
  ctx: RepairContext,
): { value: Json; reducedPrecision: boolean; original?: string } {
  const raw = owner[key];
  if (typeof raw !== 'string') return { value: owner, reducedPrecision: false };
  const fixed = repairLegacyDateString(raw);
  if (!fixed) {
    ctx.unrecognised += 1;
    ctx.warnings.push({
      path: `${path}.${key}`,
      message: `"${raw}" is not a recognised date and was left unchanged; correct it in the editor`,
      severity: 'warning',
    });
    return { value: owner, reducedPrecision: false };
  }
  if (fixed.value === raw) return { value: owner, reducedPrecision: false };
  ctx.warnings.push({
    path: `${path}.${key}`,
    message: `"${raw}" migrated to "${fixed.value}" (${fixed.changes.join('; ')})`,
    severity: fixed.reducedPrecision ? 'warning' : 'info',
  });
  return {
    value: { ...owner, [key]: fixed.value },
    reducedPrecision: fixed.reducedPrecision,
    original: raw,
  };
}

function repairEventDate(date: Json, path: string, ctx: RepairContext): Json {
  const start = repairField(date, 'start', path, ctx);
  const end = repairField(start.value, 'end', path, ctx);
  let next = end.value;
  if (start.reducedPrecision || end.reducedPrecision) {
    // Keep what the author wrote on screen, and flag the now less precise date.
    const shown = [start.original ?? date.start, end.original ?? date.end]
      .filter((v): v is string => typeof v === 'string')
      .join(' – ');
    next = {
      ...next,
      uncertain: true,
      ...(typeof next.displayOverride === 'string' && next.displayOverride
        ? {}
        : { displayOverride: shown }),
    };
  }
  return next;
}

/**
 * Migrates every event and era date in a timeline written by an older release.
 * Dates that cannot be recognised are left as they are and reported, so
 * validation still points the author at them. The input is never mutated.
 */
export function repairTimelineDates<T>(data: T): DateRepairReport<T> {
  const ctx: RepairContext = { warnings: [], unrecognised: 0 };
  if (!isObject(data)) return { timeline: data, changed: false, ...ctx };

  const state = { changed: false };
  const out: Json = { ...data };

  if (Array.isArray(data.events)) {
    out.events = data.events.map((evt: unknown, i) => {
      if (!isObject(evt) || !isObject(evt.date)) return evt;
      const date = repairEventDate(evt.date, `events[${String(i)}].date`, ctx);
      if (date === evt.date) return evt;
      state.changed = true;
      return { ...evt, date };
    });
  }

  if (Array.isArray(data.eras)) {
    out.eras = data.eras.map((era: unknown, i) => {
      if (!isObject(era)) return era;
      const path = `eras[${String(i)}]`;
      const next = repairField(repairField(era, 'start', path, ctx).value, 'end', path, ctx).value;
      if (next === era) return era;
      state.changed = true;
      return next;
    });
  }

  return { timeline: (state.changed ? out : data) as T, changed: state.changed, ...ctx };
}
