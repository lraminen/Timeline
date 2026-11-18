import { useEffect } from 'react';
import { useEditor } from '../store/editor-store.js';
import { useOnline } from '../hooks.js';
import { useCloud } from './cloud-store.js';
import { pushDraft } from './sync.js';

/** Debounce between the last edit and pushing to the server. */
export const SYNC_DELAY_MS = 1200;

/**
 * Keeps a linked draft in sync: pushes shortly after edits, and again when
 * the browser comes back online or the user signs in.
 */
export function useCloudSync(): void {
  const revision = useEditor((s) => s.revision);
  const projectId = useEditor((s) => s.remote?.projectId);
  const dirty = useEditor((s) => s.remote?.dirty ?? false);
  const user = useCloud((s) => s.user);
  const hasConflict = useCloud((s) => s.conflict !== null);
  const online = useOnline();

  useEffect(() => {
    if (!projectId) {
      useCloud.getState().setSync({ kind: 'local' });
      return;
    }
    if (!dirty) {
      void pushDraft(); // refreshes the status without a request
      return;
    }
    // Never show "saved" while unsaved edits are waiting for the debounce.
    const { sync, setSync } = useCloud.getState();
    if (sync.kind === 'synced' || sync.kind === 'local') setSync({ kind: 'pending' });
    const timer = setTimeout(() => void pushDraft(), SYNC_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [revision, projectId, dirty, user, online, hasConflict]);
}
