import { useEffect, useId, useState } from 'react';
import { formatDate } from '@chronicle/core';
import { daysInMonth, formatDateParts, parseDateParts, type DateParts } from '../../lib/dates.js';

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, i, 1)),
  ),
);

/**
 * Partial-date input: Year + CE/BCE + optional month + optional day.
 * Emits Chronicle partial-ISO strings (`1969`, `1969-07`, `-0044-03-15`).
 */
export function DateField({
  legend,
  value,
  onChange,
  error,
  locale = 'en',
}: {
  legend: string;
  value: string | undefined;
  onChange: (value: string) => void;
  error?: string | null;
  locale?: string;
}) {
  const id = useId();
  const parsed = value ? parseDateParts(value) : null;
  const [yearText, setYearText] = useState(parsed ? String(parsed.year) : '');

  // Follow external changes (undo, import, switching events).
  useEffect(() => {
    const p = value ? parseDateParts(value) : null;
    if (p) setYearText(String(p.year));
    else if (!value) setYearText('');
  }, [value]);

  const parts: DateParts = parsed ?? { year: Number(yearText) || 0, bce: false };
  const commit = (next: DateParts) => {
    if (next.year >= 1) onChange(formatDateParts(next));
  };

  const maxDay = parts.month ? daysInMonth(parts.year || 2000, parts.month, parts.bce) : 31;
  const yearMissing = yearText.trim() === '';
  const shownError =
    error ??
    (yearMissing ? 'Enter a year' : value && !parsed ? `“${value}” is not a valid date` : null);
  const preview = parsed && value ? formatDate(value, locale) : null;

  return (
    <fieldset aria-describedby={shownError ? `${id}-err` : `${id}-preview`}>
      <legend className="label">{legend}</legend>
      <div className="grid grid-cols-[1fr_auto] gap-1.5 sm:grid-cols-[5rem_auto_1fr_4.5rem]">
        <div>
          <label htmlFor={`${id}-year`} className="sr-only">
            {legend} year
          </label>
          <input
            id={`${id}-year`}
            className="input"
            inputMode="numeric"
            placeholder="Year"
            aria-invalid={shownError ? true : undefined}
            value={yearText}
            onChange={(e) => {
              const text = e.target.value.replace(/[^\d]/g, '').slice(0, 6);
              setYearText(text);
              const year = Number(text);
              if (year >= 1)
                commit({
                  ...parts,
                  year,
                  day:
                    parts.day &&
                    parts.month &&
                    parts.day > daysInMonth(year, parts.month, parts.bce)
                      ? undefined
                      : parts.day,
                });
            }}
          />
        </div>
        <div>
          <label htmlFor={`${id}-era`} className="sr-only">
            {legend} era
          </label>
          <select
            id={`${id}-era`}
            className="input w-auto"
            value={parts.bce ? 'bce' : 'ce'}
            onChange={(e) => {
              commit({ ...parts, bce: e.target.value === 'bce' });
            }}
          >
            <option value="ce">CE</option>
            <option value="bce">BCE</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-month`} className="sr-only">
            {legend} month
          </label>
          <select
            id={`${id}-month`}
            className="input"
            value={parts.month ?? ''}
            onChange={(e) => {
              const month = e.target.value ? Number(e.target.value) : undefined;
              const day =
                month && parts.day && parts.day <= daysInMonth(parts.year, month, parts.bce)
                  ? parts.day
                  : undefined;
              commit({ ...parts, month, day });
            }}
          >
            <option value="">Any month</option>
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-day`} className="sr-only">
            {legend} day
          </label>
          <select
            id={`${id}-day`}
            className="input"
            value={parts.day ?? ''}
            disabled={!parts.month}
            onChange={(e) => {
              commit({ ...parts, day: e.target.value ? Number(e.target.value) : undefined });
            }}
          >
            <option value="">Day</option>
            {Array.from({ length: maxDay }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </div>
      </div>
      {shownError ? (
        <p id={`${id}-err`} className="mt-1 text-xs text-red-700" role="alert">
          {shownError}
        </p>
      ) : (
        <p id={`${id}-preview`} className="mt-1 text-xs text-slate-600">
          Shows as <span className="font-medium text-slate-800">{preview}</span>
        </p>
      )}
    </fieldset>
  );
}
