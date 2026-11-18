import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useEditor } from './store/editor-store.js';
import { collectIssues, type Issue } from './lib/validation.js';
import { saveDraft } from './lib/drafts.js';

/** Validation issues for the current document (recomputed per revision). */
export function useIssues(): Issue[] {
  const doc = useEditor((s) => s.doc);
  return useMemo(() => collectIssues(doc), [doc]);
}

export type SaveStatus =
  | { state: 'idle' }
  | { state: 'saving' }
  | { state: 'saved'; at: number }
  | { state: 'error'; message: string };

const AUTOSAVE_DELAY_MS = 600;

/**
 * Persists the document to IndexedDB shortly after each change. Returns the
 * current save status and a `saveNow` function.
 */
export function useAutosave(enabled: boolean): {
  status: SaveStatus;
  saveNow: () => Promise<void>;
} {
  const doc = useEditor((s) => s.doc);
  const draftId = useEditor((s) => s.draftId);
  const [status, setStatus] = useState<SaveStatus>({ state: 'idle' });
  const latest = useRef({ doc, draftId });
  latest.current = { doc, draftId };

  const saveNow = useMemo(
    () => async () => {
      setStatus({ state: 'saving' });
      try {
        const at = await saveDraft(latest.current.draftId, latest.current.doc);
        setStatus({ state: 'saved', at });
      } catch (err) {
        setStatus({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [doc, draftId, enabled, saveNow]);

  // Flush on tab close / hide so the last edit is not lost.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      if (document.visibilityState === 'hidden') void saveNow();
    };
    document.addEventListener('visibilitychange', flush);
    return () => {
      document.removeEventListener('visibilitychange', flush);
    };
  }, [enabled, saveNow]);

  return { status, saveNow };
}

/** True when keyboard focus is in a text-editing control. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'TEXTAREA' ||
    (target.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'button', 'color'].includes((target as HTMLInputElement).type))
  );
}

/**
 * Global shortcuts. Undo/redo always go through the editor history (React
 * controlled inputs have no reliable native undo), including in text fields.
 */
export function useShortcuts(handlers: { onSave: () => void; onNewEvent: () => void }): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      const { undo, redo } = useEditor.getState();

      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      } else if (key === 's') {
        e.preventDefault();
        ref.current.onSave();
      } else if (key === 'e' && e.shiftKey && !isTyping(e.target)) {
        e.preventDefault();
        ref.current.onNewEvent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}
