import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Trash2, X } from 'lucide-react';
import { deleteDraft, listDrafts, type DraftSummary } from '../lib/drafts.js';
import { useEditor } from '../store/editor-store.js';

export function DraftsDialog({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const currentId = useEditor((s) => s.draftId);
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);

  useEffect(() => {
    if (open) void listDrafts().then(setDrafts);
  }, [open]);

  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
            <Dialog.Title className="text-base font-semibold">Your drafts</Dialog.Title>
            <Dialog.Close className="icon-btn" aria-label="Close">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="px-5 pt-3 text-sm text-slate-600">
            Drafts are saved in this browser automatically and work offline.
          </Dialog.Description>
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto p-3">
            {drafts === null && <li className="p-2 text-sm text-slate-600">Loading…</li>}
            {drafts?.length === 0 && <li className="p-2 text-sm text-slate-600">No drafts yet.</li>}
            {drafts?.map((d) => (
              <li key={d.id} className="flex items-center gap-2 rounded-md hover:bg-slate-50">
                <button
                  type="button"
                  className="min-w-0 flex-1 px-3 py-2 text-left"
                  aria-current={d.id === currentId ? 'true' : undefined}
                  onClick={() => {
                    onOpen(d.id);
                  }}
                >
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {d.title || 'Untitled timeline'}
                    {d.id === currentId && (
                      <span className="ml-2 text-xs font-normal text-blue-700">(open)</span>
                    )}
                  </span>
                  <span className="text-xs text-slate-600">
                    {d.eventCount} events · edited {fmt.format(d.updatedAt)}
                  </span>
                </button>
                {d.id !== currentId && (
                  <button
                    type="button"
                    className="icon-btn mr-1"
                    aria-label={`Delete draft ${d.title}`}
                    onClick={() => {
                      if (window.confirm(`Delete “${d.title}”? This cannot be undone.`)) {
                        void deleteDraft(d.id).then(listDrafts).then(setDrafts);
                      }
                    }}
                  >
                    <Trash2 size={16} aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
