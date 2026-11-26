import { useEffect } from 'react';
import { useEditor } from '../store/editor-store.js';
import { useOnline } from '../hooks.js';
import { useCloud } from './cloud-store.js';
import { CollabSession } from './collab-session.js';
import { currentSession } from './session-registry.js';

/**
 * Runs a live collaboration session while a linked draft is open and the
 * user is signed in; reports why syncing is paused otherwise.
 */
export function useCloudSync(): void {
  const api = useCloud((s) => s.api);
  const user = useCloud((s) => s.user);
  const projectId = useEditor((s) => s.remote?.projectId);
  const draftId = useEditor((s) => s.draftId);
  const online = useOnline();

  useEffect(() => {
    const { setSync } = useCloud.getState();
    if (!api || !projectId) {
      setSync({ kind: 'local' });
      return;
    }
    if (!user) {
      const dirty = useEditor.getState().remote?.dirty;
      setSync(
        dirty
          ? { kind: 'blocked', reason: 'Sign in to sync your changes' }
          : { kind: 'blocked', reason: 'Sign in to see live changes' },
      );
      return;
    }
    const session = new CollabSession(api, projectId, draftId);
    void session.start();
    return () => {
      session.destroy();
    };
  }, [api, user, projectId, draftId]);

  useEffect(() => {
    currentSession()?.setOnline(online);
  }, [online]);
}
