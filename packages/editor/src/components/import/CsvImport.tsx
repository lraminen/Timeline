import { useMemo, useState } from 'react';
import { CircleAlert, FileSpreadsheet, Globe } from 'lucide-react';
import { formatDate } from '@chronicle/core';
import {
  CSV_FIELDS,
  detectSlashOrder,
  guessMapping,
  parseCsv,
  rowsToEvents,
  toCsvUrl,
  type ColumnMapping,
  type CsvTable,
  type SlashOrder,
} from '../../lib/import-csv.js';
import { prepareAppend } from '../../lib/merge.js';
import { useEditor } from '../../store/editor-store.js';
import { appendEvents, replaceDocument } from '../../store/commands.js';
import { ImportMode, type Mode } from './ImportMode.js';

export function CsvImport({ onDone }: { onDone: (message: string) => void }) {
  const [table, setTable] = useState<CsvTable | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [slashOrder, setSlashOrder] = useState<SlashOrder>('mdy');
  const [mode, setMode] = useState<Mode>('append');
  const [url, setUrl] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const docEras = useEditor((s) => s.doc.eras);
  const docEvents = useEditor((s) => s.doc.events);

  const load = (text: string, name: string) => {
    const parsed = parseCsv(text);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setLoadError('That file has no data rows. The first row must contain column names.');
      return;
    }
    const guessed = guessMapping(parsed.headers);
    setTable(parsed);
    setSource(name);
    setMapping(guessed);
    setLoadError(null);
    const startCol = guessed.start;
    if (startCol !== undefined) {
      setSlashOrder(detectSlashOrder(parsed.rows.map((r) => r[startCol] ?? '')).order);
    }
  };

  const fetchUrl = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(toCsvUrl(url));
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
      load(await res.text(), url);
    } catch (err) {
      setLoadError(
        `Couldn’t download that file (${err instanceof Error ? err.message : String(err)}). The site must allow cross-origin downloads; for Google Sheets, use File → Share → Publish to web → CSV. Otherwise download the CSV and choose it as a file.`,
      );
    } finally {
      setLoading(false);
    }
  };

  const slash = useMemo(() => {
    if (!table || mapping.start === undefined) return null;
    const col = mapping.start;
    const endCol = mapping.end;
    return detectSlashOrder(
      table.rows.flatMap((r) => [r[col] ?? '', endCol === undefined ? '' : (r[endCol] ?? '')]),
    );
  }, [table, mapping.start, mapping.end]);

  const conversion = useMemo(() => {
    if (!table || mapping.title === undefined || mapping.start === undefined) return null;
    return rowsToEvents(table, mapping, {
      slashOrder,
      existingEras: mode === 'append' ? docEras : [],
      existingIds: mode === 'append' ? new Set(docEvents.map((e) => e.id)) : undefined,
    });
  }, [table, mapping, slashOrder, mode, docEras, docEvents]);

  const doImport = () => {
    if (!conversion || conversion.events.length === 0) return;
    const { doc, execute } = useEditor.getState();
    if (mode === 'replace') {
      execute(
        replaceDocument(
          doc,
          { ...doc, events: conversion.events, eras: conversion.newEras },
          `Import ${source ?? 'CSV'}`,
        ),
      );
    } else {
      const { events, eras } = prepareAppend(doc, conversion.events, conversion.newEras);
      execute(appendEvents(events, eras));
    }
    const skipped = conversion.errors.filter((e) => e.skipped).length;
    onDone(
      `Imported ${String(conversion.events.length)} events${skipped ? `, skipped ${String(skipped)} rows` : ''}.`,
    );
  };

  if (!table) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-700">
          Use a spreadsheet with one event per row and column names in the first row. You’ll match
          columns to fields next.
        </p>
        <label className="btn-secondary cursor-pointer focus-within:ring-2 focus-within:ring-blue-600">
          <FileSpreadsheet size={15} aria-hidden /> Choose CSV file…
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void file.text().then((t) => {
                  load(t, file.name);
                });
            }}
          />
        </label>
        <form
          className="space-y-1"
          onSubmit={(e) => {
            e.preventDefault();
            void fetchUrl();
          }}
        >
          <label htmlFor="csv-url" className="label">
            …or load from a link (published Google Sheet, CSV URL)
          </label>
          <div className="flex gap-2">
            <input
              id="csv-url"
              className="input"
              type="url"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn-secondary shrink-0"
              disabled={!url.trim() || loading}
            >
              <Globe size={15} aria-hidden /> {loading ? 'Loading…' : 'Load'}
            </button>
          </div>
        </form>
        {loadError && (
          <p role="alert" className="text-sm text-red-800">
            {loadError}
          </p>
        )}
      </div>
    );
  }

  const sample = (col: number) => table.rows.find((r) => r[col])?.[col] ?? '';
  const skipped = conversion?.errors.filter((e) => e.skipped) ?? [];
  const fieldIssues = conversion?.errors.filter((e) => !e.skipped) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-700">
          <span className="font-medium">{source}</span> — {table.rows.length} rows,{' '}
          {table.headers.length} columns
        </p>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => {
            setTable(null);
          }}
        >
          Choose another file
        </button>
      </div>

      <fieldset>
        <legend className="label">Match columns to fields</legend>
        <div className="grid max-h-56 grid-cols-1 gap-x-4 gap-y-2 overflow-y-auto rounded-md border border-slate-200 p-3 sm:grid-cols-2">
          {CSV_FIELDS.map((field) => (
            <label key={field.key} className="flex items-center gap-2 text-sm">
              <span className="w-32 shrink-0 text-slate-800">
                {field.label}
                {'required' in field && (
                  <span className="text-red-700" aria-label="required">
                    {' '}
                    *
                  </span>
                )}
              </span>
              <select
                className="input py-1"
                value={mapping[field.key] ?? ''}
                onChange={(e) => {
                  const value = e.target.value === '' ? undefined : Number(e.target.value);
                  setMapping((m) => ({ ...m, [field.key]: value }));
                }}
              >
                <option value="">— not imported —</option>
                {table.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h}
                    {sample(i) ? ` (e.g. ${sample(i).slice(0, 24)})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </fieldset>

      {slash?.present && (
        <fieldset className="rounded-md border border-slate-200 p-3">
          <legend className="label px-1">Dates like 03/04/2020 mean…</legend>
          {slash.ambiguous && (
            <p className="mb-2 text-xs text-amber-900">
              We couldn’t tell from your data — please choose.
            </p>
          )}
          <div className="flex gap-4 text-sm">
            {(
              [
                ['mdy', 'Month/Day/Year (US)'],
                ['dmy', 'Day/Month/Year'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="slash-order"
                  checked={slashOrder === value}
                  onChange={() => {
                    setSlashOrder(value);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!conversion ? (
        <p className="text-sm text-amber-900">
          Choose columns for Title and Start date to continue.
        </p>
      ) : (
        <>
          <div>
            <h3 className="label">
              Preview — {conversion.events.length} events will be imported
              {skipped.length > 0 && `, ${String(skipped.length)} rows skipped`}
            </h3>
            <div className="max-h-44 overflow-auto rounded-md border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-slate-700">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Title
                    </th>
                    <th scope="col" className="px-2 py-1 font-medium">
                      Tags
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {conversion.events.slice(0, 50).map((e) => (
                    <tr key={e.id} className="border-t border-slate-100">
                      <td className="whitespace-nowrap px-2 py-1">
                        {formatDate(e.date.start, 'en', { approximate: e.date.approximate })}
                        {e.date.end && ` – ${formatDate(e.date.end, 'en')}`}
                      </td>
                      <td className="px-2 py-1">{e.title}</td>
                      <td className="px-2 py-1 text-slate-600">{e.tags.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {conversion.newEras.length > 0 && (
              <p className="mt-1 text-xs text-slate-600">
                New eras: {conversion.newEras.map((e) => e.title).join(', ')}
              </p>
            )}
          </div>

          {(skipped.length > 0 || fieldIssues.length > 0) && (
            <details
              className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-950"
              open={conversion.events.length === 0}
            >
              <summary className="cursor-pointer font-medium">
                <CircleAlert size={13} className="mr-1 inline" aria-hidden />
                {skipped.length + fieldIssues.length} rows need attention
              </summary>
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                {conversion.errors.slice(0, 100).map((err, i) => (
                  <li key={i}>
                    <span className="font-mono">line {err.line}</span>: {err.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <ImportMode mode={mode} onChange={setMode} />
          <button
            type="button"
            className="btn-primary"
            disabled={conversion.events.length === 0}
            onClick={doImport}
          >
            Import {conversion.events.length} events
          </button>
        </>
      )}
    </div>
  );
}
