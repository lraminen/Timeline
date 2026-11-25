import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  Check,
  CircleAlert,
  FileText,
  MapPin,
  Quote,
  Sparkles,
  Upload,
} from 'lucide-react';
import type { ExtractedEventSuggestion, ExtractionResult } from '@chronicle/ai';
import { compareDates, type TimelineEvent } from '@chronicle/schema';
import { useCloud } from '../../cloud/cloud-store.js';
import { dateProblem } from '../../lib/dates.js';
import { newId } from '../../lib/ids.js';
import { appendEvents, replaceDocument } from '../../store/commands.js';
import { useEditor } from '../../store/editor-store.js';
import { Field } from '../ui.js';
import { ImportMode, type Mode } from './ImportMode.js';

interface ReviewCandidate {
  suggestion: ExtractedEventSuggestion;
  approved: boolean;
  includeLocation: boolean;
  title: string;
  start: string;
  end: string;
  body: string;
}

function validateCandidate(c: ReviewCandidate): {
  titleError: string | null;
  startError: string | null;
  endError: string | null;
  hasError: boolean;
} {
  const titleError = c.title.trim() ? null : 'Title is required';
  const startError = dateProblem(c.start);
  let endError: string | null = null;
  if (c.end.trim()) {
    endError = dateProblem(c.end);
    if (!endError && !startError) {
      if (compareDates({ start: c.end.trim() }, { start: c.start.trim() }) < 0) {
        endError = 'End date must be on or after start date';
      }
    }
  }
  return {
    titleError,
    startError,
    endError,
    hasError: Boolean(titleError || startError || endError),
  };
}

function confidenceBadge(score: number): { label: string; className: string } {
  const pct = Math.round(score * 100);
  if (score >= 0.85) {
    return { label: `${String(pct)}% confidence`, className: 'bg-green-100 text-green-800' };
  }
  if (score >= 0.6) {
    return { label: `${String(pct)}% confidence`, className: 'bg-amber-100 text-amber-800' };
  }
  return { label: `${String(pct)}% confidence`, className: 'bg-slate-200 text-slate-800' };
}

function HighlightedCitation({
  sourceText,
  quote,
  startOffset,
  endOffset,
}: {
  sourceText: string;
  quote: string;
  startOffset?: number;
  endOffset?: number;
}) {
  if (!sourceText) return null;
  let start = startOffset;
  let end = endOffset;
  if (start === undefined || end === undefined) {
    const idx = sourceText.toLowerCase().indexOf(quote.toLowerCase());
    if (idx !== -1) {
      start = idx;
      end = idx + quote.length;
    }
  }
  if (start === undefined || end === undefined) {
    return (
      <p className="mt-1 rounded bg-amber-50 p-2 text-xs text-amber-900">
        Quote could not be matched verbatim inside the extracted source text.
      </p>
    );
  }
  const contextStart = Math.max(0, start - 100);
  const contextEnd = Math.min(sourceText.length, end + 100);
  return (
    <p className="mt-1 rounded border border-slate-200 bg-slate-50 p-2 text-xs leading-relaxed text-slate-700">
      {contextStart > 0 && '…'}
      {sourceText.slice(contextStart, start)}
      <mark className="rounded bg-amber-200 px-0.5 text-slate-900">
        {sourceText.slice(start, end)}
      </mark>
      {sourceText.slice(end, contextEnd)}
      {contextEnd < sourceText.length && '…'}
    </p>
  );
}

export function AiExtractImport({ onDone }: { onDone: (message: string) => void }) {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const projectId = useEditor((s) => s.remote?.projectId);

  const [sourceKind, setSourceKind] = useState<'text' | 'file' | 'url'>('text');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [candidates, setCandidates] = useState<ReviewCandidate[]>([]);
  const [expandedQuoteId, setExpandedQuoteId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('append');

  const canExtract = Boolean(
    api &&
    user &&
    ((sourceKind === 'text' && api.aiExtractText && text.trim()) ||
      (sourceKind === 'url' && api.aiExtractText && url.trim()) ||
      (sourceKind === 'file' && api.aiExtractFile && file)),
  );

  const runExtraction = async () => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      let res: ExtractionResult;
      if (sourceKind === 'file' && file) {
        if (!api.aiExtractFile) throw new Error('File extraction is not available');
        res = await api.aiExtractFile(file, { projectId });
      } else if (sourceKind === 'url') {
        if (!api.aiExtractText) throw new Error('Text extraction is not available');
        res = await api.aiExtractText({ url: url.trim(), projectId });
      } else {
        if (!api.aiExtractText) throw new Error('Text extraction is not available');
        res = await api.aiExtractText({ text: text.trim(), projectId });
      }
      setResult(res);
      setCandidates(
        res.events.map((s) => ({
          suggestion: s,
          approved: false,
          includeLocation: false,
          title: s.title,
          start: s.date.start,
          end: s.date.end ?? '',
          body: s.body ?? '',
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const approvedCandidates = candidates.filter((c) => c.approved);
  const approvedWithErrors = approvedCandidates.filter((c) => validateCandidate(c).hasError);
  const canApply = approvedCandidates.length > 0 && approvedWithErrors.length === 0;

  const applyApproved = () => {
    if (!canApply) return;

    const events: TimelineEvent[] = approvedCandidates.map((c) => ({
      id: newId(),
      title: c.title.trim(),
      date: {
        start: c.start.trim(),
        ...(c.end.trim() ? { end: c.end.trim() } : {}),
        ...(c.suggestion.date.approximate ? { approximate: true } : {}),
        ...(c.suggestion.date.uncertain ? { uncertain: true } : {}),
        ...(c.suggestion.date.displayOverride
          ? { displayOverride: c.suggestion.date.displayOverride }
          : {}),
      },
      ...(c.body.trim() ? { body: c.body.trim() } : {}),
      media: [],
      tags: c.suggestion.tags,
      ...(c.includeLocation && c.suggestion.location ? { location: c.suggestion.location } : {}),
      aiGenerated: true,
    }));

    const { doc, execute } = useEditor.getState();
    if (mode === 'replace') {
      execute(
        replaceDocument(
          doc,
          {
            ...doc,
            title: result?.documentTitle || doc.title,
            events,
          },
          `Import ${String(events.length)} AI-extracted events`,
        ),
      );
    } else {
      execute(appendEvents(events));
    }

    onDone(
      `Added ${String(events.length)} approved AI-extracted event${events.length === 1 ? '' : 's'}.`,
    );
  };

  if (!api) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">Server connection required</p>
        <p className="mt-1">
          AI document extraction runs through a Chronicle server configured with an AI provider
          (OpenAI, Gemini, Claude, or Ollama). Connect a server in editor config to use this
          feature.
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        <p className="font-medium text-slate-900">Sign in to extract events with AI</p>
        <p className="mt-1">
          Sign in to your Chronicle account so AI usage quotas can be applied safely.
        </p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
          <Sparkles size={15} className="mt-0.5 shrink-0" aria-hidden />
          <p>
            AI extracts candidate events with source citations. Nothing is added to your timeline
            until you review and approve each event.
          </p>
        </div>

        <fieldset className="flex gap-2">
          <legend className="sr-only">Document source</legend>
          {(
            [
              ['text', 'Paste text'],
              ['file', 'Upload PDF / DOCX / HTML / TXT'],
              ['url', 'Web page URL'],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-800 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 has-[:checked]:text-blue-800"
            >
              <input
                type="radio"
                name="ai-source-kind"
                checked={sourceKind === value}
                onChange={() => {
                  setSourceKind(value);
                  setError(null);
                }}
              />
              {label}
            </label>
          ))}
        </fieldset>

        {sourceKind === 'text' && (
          <Field
            label="Source text"
            hint="Paste historical notes, articles, or project milestones."
          >
            {(p) => (
              <textarea
                {...p}
                rows={8}
                className="input font-sans text-sm"
                placeholder="Paste text containing dates and events…"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                }}
              />
            )}
          </Field>
        )}

        {sourceKind === 'file' && (
          <div className="rounded-md border border-dashed border-slate-300 p-4 text-center">
            <label className="btn-secondary cursor-pointer">
              <Upload size={15} aria-hidden />
              {file ? file.name : 'Choose PDF, DOCX, HTML, MD, or TXT'}
              <input
                type="file"
                accept=".pdf,.docx,.html,.htm,.md,.txt,text/plain,text/html,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                }}
              />
            </label>
          </div>
        )}

        {sourceKind === 'url' && (
          <Field label="Article or document URL" hint="Must be a public http(s) page.">
            {(p) => (
              <input
                {...p}
                type="url"
                className="input"
                placeholder="https://en.wikipedia.org/wiki/Apollo_11"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                }}
              />
            )}
          </Field>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-red-800">
            <CircleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Dialog.Close className="btn-ghost">Cancel</Dialog.Close>
          <button
            type="button"
            className="btn-primary"
            disabled={!canExtract || busy}
            onClick={() => void runExtraction()}
          >
            <Sparkles size={15} aria-hidden />
            {busy ? 'Extracting events…' : 'Extract events'}
          </button>
        </div>
      </div>
    );
  }

  const effectiveSourceText = result.sourceText ?? (sourceKind === 'text' ? text.trim() : '');
  const approvedCount = approvedCandidates.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <div className="flex items-center gap-1.5">
          <Sparkles size={14} aria-hidden />
          <span>
            <strong>AI-generated suggestions</strong> ({result.provider}/{result.model}) ·{' '}
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} from{' '}
            {result.processedChunks}/{result.totalChunks} chunk
            {result.totalChunks === 1 ? '' : 's'}
            {result.truncated ? ' (document truncated to batch limit)' : ''}
            {result.droppedEvents
              ? ` · ${String(result.droppedEvents)} invalid candidate${result.droppedEvents === 1 ? '' : 's'} skipped`
              : ''}
          </span>
        </div>
        <button
          type="button"
          className="font-medium underline"
          onClick={() => {
            setResult(null);
            setCandidates([]);
          }}
        >
          Try another document
        </button>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm text-slate-600">No dated events were found in this document.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-700">
              {approvedCount} of {candidates.length} selected for import
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setCandidates((prev) => prev.map((c) => ({ ...c, approved: true })));
                }}
              >
                Approve all
              </button>
              <button
                type="button"
                className="btn-ghost px-2 py-1 text-xs"
                onClick={() => {
                  setCandidates((prev) => prev.map((c) => ({ ...c, approved: false })));
                }}
              >
                Reject all
              </button>
            </div>
          </div>

          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {candidates.map((c, idx) => {
              const badge = confidenceBadge(c.suggestion.confidence);
              const quoteExpanded = expandedQuoteId === c.suggestion.id;
              const unverifiedCitation = c.suggestion.citation.startOffset === undefined;
              const validation = validateCandidate(c);

              return (
                <li
                  key={c.suggestion.id}
                  className={`space-y-2 rounded-md border p-3 ${
                    c.approved
                      ? 'border-blue-300 bg-white'
                      : 'border-slate-200 bg-slate-50 opacity-85'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs font-medium text-slate-800">
                      <input
                        type="checkbox"
                        checked={c.approved}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setCandidates((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, approved: checked } : item,
                            ),
                          );
                        }}
                      />
                      Approve
                    </label>
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[11px] font-medium text-purple-800">
                      AI-suggested
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    {unverifiedCitation && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900">
                        <AlertTriangle size={11} aria-hidden />
                        Citation quote not matched verbatim in source
                      </span>
                    )}
                  </div>

                  <div className="grid gap-2 sm:grid-cols-[1fr_9rem_9rem]">
                    <input
                      aria-label={`Event ${String(idx + 1)} title`}
                      className="input text-sm font-medium"
                      aria-invalid={validation.titleError ? true : undefined}
                      value={c.title}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCandidates((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, title: val } : item)),
                        );
                      }}
                    />
                    <input
                      aria-label={`Event ${String(idx + 1)} start date`}
                      className="input font-mono text-xs"
                      aria-invalid={validation.startError ? true : undefined}
                      value={c.start}
                      placeholder="YYYY-MM-DD"
                      onChange={(e) => {
                        const val = e.target.value;
                        setCandidates((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, start: val } : item)),
                        );
                      }}
                    />
                    <input
                      aria-label={`Event ${String(idx + 1)} end date`}
                      className="input font-mono text-xs"
                      aria-invalid={validation.endError ? true : undefined}
                      value={c.end}
                      placeholder="End (optional)"
                      onChange={(e) => {
                        const val = e.target.value;
                        setCandidates((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, end: val } : item)),
                        );
                      }}
                    />
                  </div>

                  {validation.hasError && (
                    <p role="alert" className="text-xs text-red-700">
                      {[validation.titleError, validation.startError, validation.endError]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}

                  <textarea
                    aria-label={`Event ${String(idx + 1)} description`}
                    rows={2}
                    className="input text-xs"
                    value={c.body}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCandidates((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, body: val } : item)),
                      );
                    }}
                  />

                  {c.suggestion.location && (
                    <label className="flex items-center gap-1.5 rounded bg-slate-100 px-2 py-1 text-xs text-slate-800">
                      <input
                        type="checkbox"
                        checked={c.includeLocation}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setCandidates((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, includeLocation: checked } : item,
                            ),
                          );
                        }}
                      />
                      <MapPin size={12} className="shrink-0 text-slate-600" aria-hidden />
                      <span>
                        Include suggested location:{' '}
                        <strong>{c.suggestion.location.label ?? 'Coordinates'}</strong> (
                        {c.suggestion.location.lat.toFixed(4)},{' '}
                        {c.suggestion.location.lng.toFixed(4)})
                      </span>
                    </label>
                  )}

                  <div className="rounded bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex items-start gap-1.5">
                        <Quote size={13} className="mt-0.5 shrink-0 text-slate-500" aria-hidden />
                        <span className="italic">“{c.suggestion.citation.quote}”</span>
                      </span>
                      {effectiveSourceText && (
                        <button
                          type="button"
                          className="shrink-0 text-[11px] font-medium text-blue-700 underline"
                          onClick={() => {
                            setExpandedQuoteId(quoteExpanded ? null : c.suggestion.id);
                          }}
                        >
                          <FileText size={11} className="mr-0.5 inline" aria-hidden />
                          {quoteExpanded ? 'Hide source' : 'Show in source'}
                        </button>
                      )}
                    </div>
                    {quoteExpanded && (
                      <HighlightedCitation
                        sourceText={effectiveSourceText}
                        quote={c.suggestion.citation.quote}
                        startOffset={c.suggestion.citation.startOffset}
                        endOffset={c.suggestion.citation.endOffset}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {approvedWithErrors.length > 0 && (
            <p role="alert" className="text-xs text-red-700">
              Fix invalid title or date errors on approved events before importing.
            </p>
          )}

          <ImportMode mode={mode} onChange={setMode} />

          <div className="flex justify-end gap-2">
            <Dialog.Close className="btn-ghost">Cancel</Dialog.Close>
            <button
              type="button"
              className="btn-primary"
              disabled={!canApply}
              onClick={applyApproved}
            >
              <Check size={15} aria-hidden />
              Add {approvedCount} approved event{approvedCount === 1 ? '' : 's'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
