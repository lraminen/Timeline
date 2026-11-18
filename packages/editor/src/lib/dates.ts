/**
 * Partial-date helpers for the editor. Chronicle dates are partial ISO
 * strings: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, with a leading `-` for BCE
 * (`-0044` is 44 BCE; there is no year 0).
 */

export interface DateParts {
  /** Positive year number as written (44 for 44 BCE). */
  year: number;
  bce: boolean;
  /** 1–12, or undefined for year-only dates. */
  month?: number;
  /** 1–31, or undefined. Only valid when `month` is set. */
  day?: number;
}

const PARTIAL = /^(-?)(\d{1,6})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** Splits a partial ISO date into parts; `null` if malformed or out of range. */
export function parseDateParts(value: string): DateParts | null {
  const m = PARTIAL.exec(value.trim());
  if (!m) return null;
  const year = Number(m[2]);
  const month = m[3] ? Number(m[3]) : undefined;
  const day = m[4] ? Number(m[4]) : undefined;
  const parts: DateParts = { year, bce: m[1] === '-', month, day };
  return validateParts(parts) ? null : parts;
}

/** Formats parts back to a partial ISO string (year padded to 4 digits). */
export function formatDateParts(parts: DateParts): string {
  const year = `${parts.bce ? '-' : ''}${String(parts.year).padStart(4, '0')}`;
  if (parts.month === undefined) return year;
  const month = String(parts.month).padStart(2, '0');
  if (parts.day === undefined) return `${year}-${month}`;
  return `${year}-${month}-${String(parts.day).padStart(2, '0')}`;
}

/** Days in a month, using the proleptic Gregorian calendar. */
export function daysInMonth(year: number, month: number, bce = false): number {
  // Historical BCE year N is astronomical year 1 - N.
  const astronomical = bce ? 1 - year : year;
  const isLeap = (astronomical % 4 === 0 && astronomical % 100 !== 0) || astronomical % 400 === 0;
  return [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

/** Returns a human-readable problem with the parts, or `null` if valid. */
export function validateParts(parts: DateParts): string | null {
  if (!Number.isInteger(parts.year) || parts.year < 1) return 'Year must be 1 or later';
  if (parts.year > 999_999) return 'Year is too large';
  if (parts.month !== undefined && (parts.month < 1 || parts.month > 12)) {
    return 'Month must be between 1 and 12';
  }
  if (parts.day !== undefined) {
    if (parts.month === undefined) return 'A day needs a month';
    const max = daysInMonth(parts.year, parts.month, parts.bce);
    if (parts.day < 1 || parts.day > max) return `Day must be between 1 and ${String(max)}`;
  }
  return null;
}

/** Explains why a stored date string is invalid, or `null` if it is valid. */
export function dateProblem(value: string | undefined): string | null {
  if (!value?.trim()) return 'Date is required';
  const m = PARTIAL.exec(value.trim());
  if (!m) return 'Use YYYY, YYYY-MM or YYYY-MM-DD';
  return validateParts({
    year: Number(m[2]),
    bce: m[1] === '-',
    month: m[3] ? Number(m[3]) : undefined,
    day: m[4] ? Number(m[4]) : undefined,
  });
}

/** Today's date as `YYYY-MM-DD` (local time). */
export function today(): string {
  const d = new Date();
  return formatDateParts({
    year: d.getFullYear(),
    bce: false,
    month: d.getMonth() + 1,
    day: d.getDate(),
  });
}
