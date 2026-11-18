import { ApiRequestError, DraftConflict } from '../lib/api.js';
import { collectIssues, hasErrors } from '../lib/validation.js';
import { newId } from '../lib/ids.js';
import { useEditor, type RemoteLink } from '../store/editor-store.js';
import { replaceDocument } from '../store/commands.js';
import { useCloud } from './cloud-store.js';
import { saveDraft } from '../lib/drafts.js';
import type { Timeline } from '@chronicle/schema';

/**
 * Editor ↔ server synchronisation.
 *
 * The unit of sync is the whole draft, so the "queue" is simply the latest
 * local state plus a persisted `dirty` flag: edits made offline (or before
 * a reload) are pushed the next time we're online and signed in. Saves use
 * optimistic concurrency (If-Match); a 412 surfaces as a conflict the user
 * resolves explicitly.
 */

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** JSON with object keys sorted, so key order (Postgres jsonb reorders) doesn't matter. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** True when two timelines have the same content (ignoring the document id). */
export function sameDocument(a: Timeline, b: Timeline): boolean {
  return canonical({ ...a, id: '' }) === canonical({ ...b, id: '' });
}

/**
 * Records a successful sync and persists the link immediately — not on the
 * autosave debounce — so a reload right after syncing can't resurrect a
 * stale base version (which would look like a conflict with ourselves).
 */
function markSynced(version: number, stillDirty: boolean): void {
  const editor = useEditor.getState();
  if (!editor.remote) return;
  const remote: RemoteLink = {
    ...editor.remote,
    baseVersion: version,
    dirty: stillDirty,
    lastSyncedAt: Date.now(),
  };
  editor.setRemote(remote);
  void saveDraft(editor.draftId, editor.doc, remote).catch(() => undefined);
  useCloud
    .getState()
    .setSync(stillDirty ? { kind: 'pending' } : { kind: 'synced', at: Date.now() });
}

/** Pushes the current draft if it has unsynced changes. Never throws. */
export async function pushDraft(): Promise<void> {
  const cloud = useCloud.getState();
  const editor = useEditor.getState();
  const { api, user } = cloud;
  const { remote, doc, revision } = editor;

  if (!api || !remote) {
    cloud.setSync({ kind: 'local' });
    return;
  }
  if (cloud.conflict) {
    cloud.setSync({ kind: 'conflict' });
    return;
  }
  if (!remote.dirty) {
    cloud.setSync(
      remote.lastSyncedAt ? { kind: 'synced', at: remote.lastSyncedAt } : { kind: 'pending' },
    );
    return;
  }
  if (!user) {
    cloud.setSync({ kind: 'blocked', reason: 'Sign in to sync your changes' });
    return;
  }
  if (remote.role === 'viewer') {
    cloud.setSync({ kind: 'blocked', reason: 'You have view-only access to this timeline' });
    return;
  }
  if (hasErrors(collectIssues(doc))) {
    cloud.setSync({ kind: 'blocked', reason: 'Fix the problems in this timeline to sync it' });
    return;
  }
  if (!navigator.onLine) {
    cloud.setSync({ kind: 'offline' });
    return;
  }

  cloud.setSync({ kind: 'syncing' });
  try {
    const version = await api.saveDraft(remote.projectId, doc, remote.baseVersion);
    const now = useEditor.getState();
    // The user may have switched documents while we were saving.
    if (now.remote?.projectId !== remote.projectId) return;
    const stillDirty = now.revision !== revision; // edited during the request
    markSynced(version, stillDirty);
  } catch (err) {
    const c = useCloud.getState();
    if (err instanceof DraftConflict && sameDocument(err.serverDraft, doc)) {
      // Our own earlier save already landed (its response was lost, or the
      // page reloaded before the new version was stored): not a conflict.
      markSynced(err.serverVersion, useEditor.getState().revision !== revision);
    } else if (err instanceof DraftConflict) {
      c.setConflict({
        serverVersion: err.serverVersion,
        serverDraft: err.serverDraft,
        serverUpdatedAt: err.serverUpdatedAt,
      });
      c.setSync({ kind: 'conflict' });
    } else if (err instanceof ApiRequestError && err.status === 0) {
      c.setSync({ kind: 'offline' });
    } else if (err instanceof ApiRequestError && err.status === 401) {
      c.setUser(null);
      c.setSync({ kind: 'blocked', reason: 'Your session expired — sign in to sync' });
    } else if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
      c.setSync({ kind: 'blocked', reason: 'You no longer have edit access to this timeline' });
    } else {
      c.setSync({ kind: 'error', message: describe(err) });
    }
  }
}

/** Uploads the current local draft as a new server project and links it. */
export async function linkCurrentDraft(): Promise<RemoteLink> {
  const { api } = useCloud.getState();
  if (!api) throw new Error('No Chronicle server configured');
  const { doc, setRemote } = useEditor.getState();
  const project = await api.createProject(doc);
  const remote: RemoteLink = {
    projectId: project.id,
    slug: project.slug,
    role: project.role,
    baseVersion: project.draftVersion,
    dirty: false,
    lastSyncedAt: Date.now(),
  };
  setRemote(remote);
  // The server owns the document id from now on.
  useEditor.setState((s) => ({ doc: { ...s.doc, id: project.id } }));
  useCloud.getState().setSync({ kind: 'synced', at: Date.now() });
  return remote;
}

/** Opens a server project as a new local draft linked to it. */
export async function openProject(projectId: string): Promise<void> {
  const { api } = useCloud.getState();
  if (!api) throw new Error('No Chronicle server configured');
  const [project, draft] = await Promise.all([api.getProject(projectId), api.getDraft(projectId)]);
  useCloud.getState().setConflict(null);
  useEditor.getState().load(draft.timeline, newId(), {
    projectId: project.id,
    slug: project.slug,
    role: project.role,
    baseVersion: draft.draftVersion,
    dirty: false,
    lastSyncedAt: Date.now(),
  });
  useCloud.getState().setSync({ kind: 'synced', at: Date.now() });
}

export type ConflictChoice = 'keep-mine' | 'use-theirs' | 'save-copy';

/** Resolves a save conflict as the user chose. */
export async function resolveConflict(choice: ConflictChoice): Promise<void> {
  const cloud = useCloud.getState();
  const editor = useEditor.getState();
  const { conflict } = cloud;
  const { remote } = editor;
  if (!conflict || !remote) return;
  cloud.setConflict(null);

  if (choice === 'keep-mine') {
    // Overwrite the server copy: rebase onto its version and push again.
    editor.setRemote({ ...remote, baseVersion: conflict.serverVersion, dirty: true });
    await pushDraft();
  } else if (choice === 'use-theirs') {
    // Undoable, so the user can still recover their own version.
    editor.execute(replaceDocument(editor.doc, conflict.serverDraft, 'Use the server version'));
    useEditor.getState().setRemote({
      ...remote,
      baseVersion: conflict.serverVersion,
      dirty: false,
      lastSyncedAt: Date.now(),
    });
    cloud.setSync({ kind: 'synced', at: Date.now() });
  } else {
    useEditor.getState().setRemote(null);
    useEditor.setState((s) => ({
      doc: { ...s.doc, title: `${s.doc.title} (my copy)` },
    }));
    await linkCurrentDraft();
  }
}

export interface PublishResult {
  version: number;
  pageUrl: string;
  embedUrl: string;
  /** Stable URL of the <chronicle-timeline> script on this server. */
  scriptUrl: string;
  isPublic: boolean;
}

/**
 * Publishes the current draft: links it if needed, makes sure the server has
 * the latest local changes, applies visibility (owners only) and publishes.
 */
export async function publishCurrent(options: {
  message?: string;
  isPublic: boolean;
}): Promise<PublishResult> {
  const { api } = useCloud.getState();
  if (!api) throw new Error('No Chronicle server configured');
  let remote = useEditor.getState().remote ?? (await linkCurrentDraft());

  if (remote.dirty) {
    await pushDraft();
    const state = useCloud.getState().sync;
    remote = useEditor.getState().remote ?? remote;
    if (remote.dirty) {
      throw new Error(
        state.kind === 'blocked' || state.kind === 'error'
          ? state.kind === 'blocked'
            ? state.reason
            : state.message
          : state.kind === 'conflict'
            ? 'Resolve the save conflict before publishing'
            : 'Your latest changes are not saved to the server yet',
      );
    }
  }

  let isPublic = options.isPublic;
  if (remote.role === 'owner') {
    isPublic = (await api.setVisibility(remote.projectId, options.isPublic)).isPublic;
  }
  const { version } = await api.publish(remote.projectId, options.message);
  return {
    version,
    pageUrl: api.pageUrl(remote.slug),
    embedUrl: api.embedUrl(remote.slug),
    scriptUrl: `${api.origin}/embed.js`,
    isPublic,
  };
}
