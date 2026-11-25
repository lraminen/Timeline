import { z } from 'zod';

/** Days in a month (1–12), using the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number, bce = false): number {
  const astronomical = bce ? 1 - year : year;
  const isLeap = (astronomical % 4 === 0 && astronomical % 100 !== 0) || astronomical % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

const PARTIAL_DATE = /^(-?)(\d{1,6})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const FULL_ISO_DATETIME =
  /^(-?)(\d{1,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Validates that a timeline date string uses a supported format (`YYYY`, `YYYY-MM`,
 * `YYYY-MM-DD`, or full ISO-8601 datetime) and represents a valid Gregorian calendar date.
 */
export function isValidTimelineDateString(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;

  const partial = PARTIAL_DATE.exec(trimmed);
  if (partial) {
    const bce = partial[1] === '-';
    const year = Number(partial[2]);
    const monthStr = partial[3] as string | undefined;
    const dayStr = partial[4] as string | undefined;
    if (!Number.isInteger(year) || year < 1 || year > 999_999) return false;
    if (monthStr) {
      const month = Number(monthStr);
      if (month < 1 || month > 12) return false;
      if (dayStr) {
        const day = Number(dayStr);
        if (day < 1 || day > daysInMonth(year, month, bce)) return false;
      }
    }
    return true;
  }

  const dt = FULL_ISO_DATETIME.exec(trimmed);
  if (dt) {
    const bce = dt[1] === '-';
    const year = Number(dt[2]);
    const month = Number(dt[3]);
    const day = Number(dt[4]);
    const hour = Number(dt[5]);
    const minute = Number(dt[6]);
    const secondStr = dt[7] as string | undefined;
    const second = secondStr ? Number(secondStr) : 0;
    if (!Number.isInteger(year) || year < 1 || year > 999_999) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > daysInMonth(year, month, bce)) return false;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Schema for timeline dates supporting partial ISO formats and BCE dates.
 */
export const TimelineDateSchema = z
  .object({
    start: z
      .string()
      .describe(
        'Start date string. Supports partial ISO formats: "YYYY", "YYYY-MM", "YYYY-MM-DD", or full ISO 8601. Negative years represent BCE dates (e.g. "-0044" for 44 BCE).',
      ),
    end: z
      .string()
      .optional()
      .describe('Optional end date string for date ranges. Same format rules as start.'),
    uncertain: z
      .boolean()
      .optional()
      .describe(
        'Marks the date as uncertain, typically rendered with a question mark or dashed styling.',
      ),
    approximate: z
      .boolean()
      .optional()
      .describe(
        'Marks the date as approximate, typically rendered with a tilde (~) or fuzzy styling.',
      ),
    displayOverride: z
      .string()
      .optional()
      .describe(
        'Optional human-readable label to show instead of the parsed date, e.g. "The Renaissance" or "circa 1500".',
      ),
  })
  .superRefine((date, ctx) => {
    if (!isValidTimelineDateString(date.start)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['start'],
        message: 'Invalid calendar date string',
      });
    }
    if (date.end !== undefined && !isValidTimelineDateString(date.end)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'Invalid calendar end date string',
      });
    }
  })
  .describe('A date or date range on the timeline, with optional modifiers.');

/** Inferred TypeScript type for a timeline date. */
export type TimelineDate = z.infer<typeof TimelineDateSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Regex patterns for supported date formats. */
const YEAR_ONLY = /^-?\d{1,6}$/;
const YEAR_MONTH = /^-?\d{1,6}-\d{2}$/;
const YEAR_MONTH_DAY = /^-?\d{1,6}-\d{2}-\d{2}$/;

/**
 * Normalises various date-string formats into a consistent ISO-8601 string.
 *
 * Supported inputs:
 * - `"YYYY"`        → `"YYYY-01-01"`
 * - `"YYYY-MM"`     → `"YYYY-MM-01"`
 * - `"YYYY-MM-DD"`  → passed through
 * - Full ISO 8601   → passed through
 * - Negative years  → preserved (e.g. `"-0044"` → `"-0044-01-01"`)
 *
 * @param dateStr The raw date string to normalise.
 * @returns A normalised ISO-8601 date string.
 */
export function parseTimelineDate(dateStr: string): string {
  const trimmed = dateStr.trim();

  if (YEAR_ONLY.test(trimmed)) {
    return `${trimmed}-01-01`;
  }

  if (YEAR_MONTH.test(trimmed)) {
    return `${trimmed}-01`;
  }

  if (YEAR_MONTH_DAY.test(trimmed)) {
    return trimmed;
  }

  // Full ISO-8601 or other — return as-is.
  return trimmed;
}

/**
 * Extracts a numeric value from a date string for chronological comparison.
 *
 * Uses a uniform integer scale for ALL dates (BCE and CE alike):
 *   `year * 10000 + month * 100 + day`
 *
 * This avoids mixing `Date.parse()` epoch-milliseconds (which are negative
 * before 1970) with the manual scale used for BCE dates — the root cause of
 * the original sorting bug where 44 BCE sorted *after* 1000 CE.
 */
function toComparableValue(dateStr: string): number {
  const normalised = parseTimelineDate(dateStr);

  // Match both negative (BCE) and positive years.
  const match = /^(-?\d+)-(\d{2})-(\d{2})/.exec(normalised);
  if (match) {
    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    return year * 10000 + month * 100 + day;
  }

  return 0;
}

/**
 * Compares two {@link TimelineDate} objects for chronological sorting.
 *
 * @returns A negative number if `a` is earlier, positive if `b` is earlier, 0 if equal.
 */
export function compareDates(a: TimelineDate, b: TimelineDate): number {
  return toComparableValue(a.start) - toComparableValue(b.start);
}
