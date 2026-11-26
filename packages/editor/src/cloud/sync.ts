import { collectIssues, hasErrors } from '../lib/validation.js';
import { newId } from '../lib/ids.js';
import { useEditor, type RemoteLink } from '../store/editor-store.js';
import { useCloud } from './cloud-store.js';
import { currentSession } from './session-registry.js';
import type { Timeline } from '@chronicle/schema';

/**
 * Editor ↔ server: linking drafts to projects, opening projects, publishing.
 *
 * Keeping a linked draft in sync is the job of the live collaboration
 * session (`collab-session.ts`): edits are merged with everyone else's as a
 * CRDT, so there are no save conflicts. The only conflict left is for drafts
 * with unsynced changes made before live collaboration existed.
 */

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

/** Retries syncing now (reconnects, or syncs over HTTP). */
export function syncNow(): void {
  currentSession()?.retry();
}

/** Uploads the current local draft as a new server project and links it. */
export async function linkCurrentDraft(): Promise<RemoteLink> {
  const { api } = useCloud.getState();
  if (!api) throw new Error('No Chronicle server configured');
  const { doc, revision } = useEditor.getState();
  const project = await api.createProject(doc);
  const remote: RemoteLink = {
    projectId: project.id,
    slug: project.slug,
    role: project.role,
    baseVersion: project.draftVersion,
    // Edits made while the project was being created are merged by the session.
    dirty: useEditor.getState().revision !== revision,
    lastSyncedAt: Date.now(),
  };
  useEditor.getState().setRemote(remote);
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

/** Resolves a conflict (unsynced pre-collaboration changes) as the user chose. */
export async function resolveConflict(choice: ConflictChoice): Promise<void> {
  const session = currentSession();
  if (choice !== 'save-copy') {
    session?.resolve(choice);
    return;
  }
  useCloud.getState().setConflict(null);
  useEditor.getState().setRemote(null);
  useEditor.setState((s) => ({
    doc: { ...s.doc, title: `${s.doc.title} (my copy)` },
  }));
  await linkCurrentDraft();
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
 * Publishes the current draft: links it if needed, waits until the server
 * has every local change, applies visibility (owners only) and publishes.
 */
export async function publishCurrent(options: {
  message?: string;
  isPublic: boolean;
}): Promise<PublishResult> {
  const { api, conflict } = useCloud.getState();
  if (!api) throw new Error('No Chronicle server configured');
  if (conflict) throw new Error('Resolve the save conflict before publishing');
  // The server publishes its last valid draft; make sure that is this one.
  if (hasErrors(collectIssues(useEditor.getState().doc))) {
    throw new Error('Fix the problems in this timeline before publishing it');
  }
  let remote = useEditor.getState().remote ?? (await linkCurrentDraft());
  if (remote.role === 'viewer') throw new Error('You have view-only access to this timeline');

  const session = currentSession();
  if (session?.projectId === remote.projectId) await session.flush();
  remote = useEditor.getState().remote ?? remote;

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
