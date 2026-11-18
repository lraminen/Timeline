import { useState } from 'react';
import { CircleAlert, CircleCheck, FileJson, Info } from 'lucide-react';
import { importJson, type JsonImportResult } from '../../lib/import-json.js';
import { prepareAppend } from '../../lib/merge.js';
import { useEditor } from '../../store/editor-store.js';
import { appendEvents, replaceDocument } from '../../store/commands.js';
import { ImportMode, type Mode } from './ImportMode.js';

export function JsonImport({ onDone }: { onDone: (message: string) => void }) {
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<JsonImportResult | null>(null);
  const [mode, setMode] = useState<Mode>('replace');

  const check = (source: string) => {
    setResult(source.trim() ? importJson(source) : null);
  };

  const doImport = () => {
    if (!result?.ok) return;
    const { doc, execute } = useEditor.getState();
    const imported = result.timeline;
    if (mode === 'replace') {
      execute(replaceDocument(doc, imported, `Import “${imported.title}”`));
    } else {
      const { events, eras } = prepareAppend(doc, imported.events, imported.eras);
      execute(appendEvents(events, eras));
    }
    onDone(
      `Imported ${String(imported.events.length)} events${result.kind === 'timelinejs' ? ' from TimelineJS' : ''}.`,
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-700">
        Load a Chronicle <code>.json</code> file, or a TimelineJS v3 JSON file — it is detected and
        converted automatically.
      </p>

      <div className="flex items-center gap-3">
        <label className="btn-secondary cursor-pointer focus-within:ring-2 focus-within:ring-blue-600">
          <FileJson size={15} aria-hidden /> Choose file…
          <input
            type="file"
            accept=".json,application/json"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setFileName(file.name);
              void file.text().then((t) => {
                setText(t);
                check(t);
              });
            }}
          />
        </label>
        {fileName && <span className="truncate text-sm text-slate-700">{fileName}</span>}
      </div>

      <div>
        <label htmlFor="json-paste" className="label">
          …or paste JSON
        </label>
        <textarea
          id="json-paste"
          rows={7}
          spellCheck={false}
          className="input font-mono text-xs"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setFileName(null);
            setResult(null);
          }}
        />
        <button
          type="button"
          className="btn-secondary mt-2"
          disabled={!text.trim()}
          onClick={() => {
            check(text);
          }}
        >
          Check
        </button>
      </div>

      {result && !result.ok && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-red-900">
            <CircleAlert size={15} aria-hidden /> This file can’t be imported (
            {result.issues.length} {result.issues.length === 1 ? 'problem' : 'problems'})
          </p>
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-red-900">
            {result.issues.slice(0, 50).map((issue, i) => (
              <li key={i}>
                {issue.line !== undefined && (
                  <span className="mr-1.5 rounded bg-red-100 px-1 font-mono">
                    line {issue.line}:{issue.column}
                  </span>
                )}
                {issue.path && issue.path !== '(root)' && (
                  <code className="mr-1">{issue.path}</code>
                )}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result?.ok && (
        <div role="status" className="space-y-2 rounded-md border border-green-200 bg-green-50 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-green-900">
            <CircleCheck size={15} aria-hidden />
            {result.kind === 'timelinejs' ? 'TimelineJS file' : 'Chronicle timeline'} “
            {result.timeline.title}” — {result.timeline.events.length} events,{' '}
            {result.timeline.eras.length} eras
          </p>
          {result.warnings.length > 0 && (
            <details className="text-xs text-slate-800">
              <summary className="cursor-pointer font-medium">
                <Info size={13} className="mr-1 inline" aria-hidden />
                {result.warnings.length} conversion{' '}
                {result.warnings.length === 1 ? 'note' : 'notes'} (what changed or was dropped)
              </summary>
              <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pl-4">
                {result.warnings.map((w, i) => (
                  <li key={i} className={w.severity === 'warning' ? 'text-amber-900' : ''}>
                    <code>{w.path}</code>: {w.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <ImportMode mode={mode} onChange={setMode} />
          <button type="button" className="btn-primary" onClick={doImport}>
            Import
          </button>
        </div>
      )}
    </div>
  );
}
