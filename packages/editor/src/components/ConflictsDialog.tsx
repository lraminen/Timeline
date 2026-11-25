import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { CircleAlert, CircleCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { detectDeterministicConflicts, type TimelineConflict } from '@chronicle/ai';
import type { Timeline } from '@chronicle/schema';
import { useCloud } from '../cloud/cloud-store.js';
import { useEditor } from '../store/editor-store.js';

export function ConflictsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const doc = useEditor((s) => s.doc);
  const projectId = useEditor((s) => s.remote?.projectId);
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);

  const [deterministicConflicts, setDeterministicConflicts] = useState<TimelineConflict[]>([]);
  const [aiConflicts, setAiConflicts] = useState<TimelineConflict[]>([]);
  const [aiCheckedDoc, setAiCheckedDoc] = useState<Timeline | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDeterministicConflicts(detectDeterministicConflicts(doc));
    setError(null);
  }, [open, doc]);

  const aiChecked = aiCheckedDoc !== null;
  const aiStale = aiChecked && aiCheckedDoc !== doc;
  const conflicts = [...deterministicConflicts, ...aiConflicts];

  const runAiCheck = async () => {
    if (!api?.aiDetectConflicts || !user) return;
    setBusy(true);
    setError(null);
    const snapshot = useEditor.getState().doc;
    const compactTimeline: Timeline = {
      ...snapshot,
      events: snapshot.events.map((e) => ({
        ...e,
        media: [],
        ...(e.body !== undefined ? { body: e.body.slice(0, 500) } : {}),
      })),
    };
    try {
      const res = await api.aiDetectConflicts({
        timeline: compactTimeline,
        includeSemantic: true,
        projectId,
      });
      setDeterministicConflicts(res.conflicts.filter((c) => !c.aiGenerated));
      setAiConflicts(res.conflicts.filter((c) => c.aiGenerated));
      setAiCheckedDoc(snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-white p-5 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-slate-900">
              Timeline conflict check
            </Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-sm text-slate-600">
            Detects invalid date ranges, era mismatches, duplicate events, and optional AI semantic
            contradictions. Review flags manually — nothing is changed automatically.
          </Dialog.Description>

          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-600">
              {conflicts.length === 0
                ? 'No conflicts detected.'
                : `${String(conflicts.length)} conflict${conflicts.length === 1 ? '' : 's'} found`}
            </span>
            {api?.aiDetectConflicts && user && (
              <button
                type="button"
                className="btn-secondary px-2.5 py-1 text-xs"
                disabled={busy}
                onClick={() => void runAiCheck()}
              >
                <Sparkles size={13} aria-hidden />
                {busy ? 'Checking with AI…' : aiChecked ? 'Re-run AI check' : 'Check with AI'}
              </button>
            )}
          </div>

          {aiStale && (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <span>Timeline changed — previous AI results may be stale.</span>
              {api?.aiDetectConflicts && user && (
                <button
                  type="button"
                  className="font-medium underline"
                  disabled={busy}
                  onClick={() => void runAiCheck()}
                >
                  Re-run AI check
                </button>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="mb-3 text-xs text-red-700">
              {error}
            </p>
          )}

          {conflicts.length === 0 ? (
            <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              <CircleCheck size={16} aria-hidden />
              <span>Your timeline dates, eras, and events look consistent.</span>
            </div>
          ) : (
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {conflicts.map((c) => (
                <li
                  key={c.id}
                  className="space-y-1.5 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-medium text-slate-900">
                      {c.severity === 'error' ? (
                        <CircleAlert size={14} className="text-red-700" aria-hidden />
                      ) : (
                        <TriangleAlert size={14} className="text-amber-700" aria-hidden />
                      )}
                      {c.kind.replace(/_/g, ' ')}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        c.aiGenerated
                          ? 'bg-purple-100 text-purple-800'
                          : 'bg-slate-200 text-slate-700'
                      }`}
                    >
                      {c.aiGenerated ? 'AI-flagged' : 'Rule check'}
                    </span>
                  </div>
                  <p className="text-slate-800">{c.message}</p>
                  {c.suggestion && <p className="text-slate-600">Suggestion: {c.suggestion}</p>}
                  {c.eventIds[0] && (
                    <button
                      type="button"
                      className="font-medium text-blue-700 underline"
                      onClick={() => {
                        const firstId = c.eventIds[0];
                        if (!firstId) return;
                        const s = useEditor.getState();
                        s.select(firstId);
                        s.setSidebarTab('events');
                        onOpenChange(false);
                      }}
                    >
                      Jump to event
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close className="btn-primary">Done</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
