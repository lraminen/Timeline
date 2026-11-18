import { z } from "zod";

/**
 * Schema for timeline dates supporting partial ISO formats and BCE dates.
 */
export const TimelineDateSchema = z
  .object({
    start: z
      .string()
      .describe(
        'Start date string. Supports partial ISO formats: "YYYY", "YYYY-MM", "YYYY-MM-DD", or full ISO 8601. Negative years represent BCE dates (e.g. "-0044" for 44 BCE).'
      ),
    end: z
      .string()
      .optional()
      .describe(
        "Optional end date string for date ranges. Same format rules as start."
      ),
    uncertain: z
      .boolean()
      .optional()
      .describe(
        "Marks the date as uncertain, typically rendered with a question mark or dashed styling."
      ),
    approximate: z
      .boolean()
      .optional()
      .describe(
        "Marks the date as approximate, typically rendered with a tilde (~) or fuzzy styling."
      ),
    displayOverride: z
      .string()
      .optional()
      .describe(
        'Optional human-readable label to show instead of the parsed date, e.g. "The Renaissance" or "circa 1500".'
      ),
  })
  .describe("A date or date range on the timeline, with optional modifiers.");

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
 * Extracts a numeric timestamp from a date string for comparison purposes.
 * Handles BCE (negative-year) dates that `Date.parse` cannot.
 */
function toComparableValue(dateStr: string): number {
  const normalised = parseTimelineDate(dateStr);

  // Handle negative (BCE) years manually.
  const negMatch = normalised.match(/^(-\d+)-(\d{2})-(\d{2})/);
  if (negMatch) {
    const year = parseInt(negMatch[1], 10);
    const month = parseInt(negMatch[2], 10);
    const day = parseInt(negMatch[3], 10);
    // Encode as a single comparable number: year * 10000 + month * 100 + day
    return year * 10000 + month * 100 + day;
  }

  // For positive years, try native parsing first.
  const ts = Date.parse(normalised);
  if (!Number.isNaN(ts)) {
    return ts;
  }

  // Fallback: manual extraction for positive years.
  const posMatch = normalised.match(/^(\d+)-(\d{2})-(\d{2})/);
  if (posMatch) {
    const year = parseInt(posMatch[1], 10);
    const month = parseInt(posMatch[2], 10);
    const day = parseInt(posMatch[3], 10);
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
