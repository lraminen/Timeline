import { useEffect, useId, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { formatDate } from '@chronicle/core';
import { normalizeNaturalDateDeterministic, type DateNormalizationResult } from '@chronicle/ai';
import type { TimelineDate } from '@chronicle/schema';
import { useCloud } from '../../cloud/cloud-store.js';
import { useEditor } from '../../store/editor-store.js';
import { daysInMonth, formatDateParts, parseDateParts, type DateParts } from '../../lib/dates.js';

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, i, 1)),
  ),
);

/**
 * Partial-date input: Year + CE/BCE + optional month + optional day,
 * plus an optional natural-language date parser ("the summer of '69").
 * Emits Chronicle partial-ISO strings (`1969`, `1969-07`, `-0044-03-15`).
 */
export function DateField({
  legend,
  value,
  onChange,
  onApplyNormalized,
  error,
  locale = 'en',
}: {
  legend: string;
  value: string | undefined;
  onChange: (value: string) => void;
  onApplyNormalized?: (date: TimelineDate) => void;
  error?: string | null;
  locale?: string;
}) {
  const id = useId();
  const parsed = value ? parseDateParts(value) : null;
  const [yearText, setYearText] = useState(parsed ? String(parsed.year) : '');
  const [nlpOpen, setNlpOpen] = useState(false);
  const [nlpInput, setNlpInput] = useState('');
  const [nlpResult, setNlpResult] = useState<DateNormalizationResult | null>(null);
  const [nlpBusy, setNlpBusy] = useState(false);
  const [nlpError, setNlpError] = useState<string | null>(null);

  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const projectId = useEditor((s) => s.remote?.projectId);

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

  const runNlpParse = async (useLlm: boolean) => {
    const q = nlpInput.trim();
    if (!q) return;
    setNlpError(null);
    const local = normalizeNaturalDateDeterministic(q);
    if (local.date || !useLlm || !api?.aiNormalizeDate || !user) {
      setNlpResult(local);
      return;
    }
    setNlpBusy(true);
    try {
      const remote = await api.aiNormalizeDate({ text: q, useLlm: true, projectId });
      setNlpResult(remote);
    } catch (err) {
      setNlpError(err instanceof Error ? err.message : String(err));
    } finally {
      setNlpBusy(false);
    }
  };

  return (
    <fieldset aria-describedby={shownError ? `${id}-err` : `${id}-preview`}>
      <legend className="label mb-1">{legend}</legend>
      <div className="mb-1 flex justify-end">
        <button
          type="button"
          className="btn-ghost px-1.5 py-0.5 text-[11px]"
          onClick={() => {
            setNlpOpen((o) => !o);
            setNlpError(null);
          }}
        >
          <Sparkles size={11} aria-hidden /> {nlpOpen ? 'Close parser' : 'Parse text'}
        </button>
      </div>

      {nlpOpen && (
        <div className="mb-2 space-y-2 rounded-md border border-blue-200 bg-blue-50/60 p-2.5">
          <label htmlFor={`${id}-nlp`} className="block text-xs font-medium text-slate-800">
            Natural language date (e.g. “summer of &apos;69”, “early 20th century”)
          </label>
          <div className="flex gap-1.5">
            <input
              id={`${id}-nlp`}
              className="input bg-white text-xs"
              placeholder="e.g. circa 44 BC"
              value={nlpInput}
              onChange={(e) => {
                const next = e.target.value;
                setNlpInput(next);
                setNlpResult(next.trim() ? normalizeNaturalDateDeterministic(next) : null);
                setNlpError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void runNlpParse(true);
                }
              }}
            />
            {api?.aiNormalizeDate && user && (
              <button
                type="button"
                className="btn-secondary shrink-0 px-2 py-1 text-xs"
                disabled={!nlpInput.trim() || nlpBusy}
                onClick={() => void runNlpParse(true)}
              >
                {nlpBusy ? '…' : 'Ask AI'}
              </button>
            )}
          </div>
          {nlpError && (
            <p className="text-xs text-red-700" role="alert">
              {nlpError}
            </p>
          )}
          {nlpResult?.date && (
            <div className="space-y-1.5 rounded border border-slate-200 bg-white p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-medium text-slate-900">
                  {nlpResult.date.start}
                  {nlpResult.date.end ? ` → ${nlpResult.date.end}` : ''}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    nlpResult.aiGenerated
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-slate-100 text-slate-700'
                  }`}
                >
                  {nlpResult.aiGenerated ? 'AI suggestion' : 'Parsed'}
                </span>
              </div>
              <p className="text-slate-600">{nlpResult.reasoning}</p>
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="btn-primary px-2 py-1 text-xs"
                  onClick={() => {
                    if (!nlpResult.date) return;
                    if (onApplyNormalized) onApplyNormalized(nlpResult.date);
                    else onChange(nlpResult.date.start);
                    setNlpOpen(false);
                    setNlpInput('');
                    setNlpResult(null);
                  }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          {nlpResult && !nlpResult.date && (
            <p className="text-xs text-slate-600">{nlpResult.reasoning}</p>
          )}
        </div>
      )}

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
