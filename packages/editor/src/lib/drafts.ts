import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { validateTimeline, type Timeline } from '@chronicle/schema';
import type { RemoteLink } from '../store/editor-store.js';

/**
 * Local draft storage (IndexedDB). Drafts let the editor work fully offline
 * and survive reloads; Phase 3 adds server sync on top.
 */

export interface Draft {
  id: string;
  title: string;
  doc: Timeline;
  updatedAt: number;
  /** Server project this draft syncs with. */
  remote?: RemoteLink | null;
}

export type DraftSummary = Omit<Draft, 'doc' | 'remote'> & {
  eventCount: number;
  synced: boolean | null;
};

interface DraftsDB extends DBSchema {
  drafts: { key: string; value: Draft; indexes: { updatedAt: number } };
}

const DB_NAME = 'chronicle-editor';
let dbPromise: Promise<IDBPDatabase<DraftsDB>> | null = null;

function db(): Promise<IDBPDatabase<DraftsDB>> {
  dbPromise ??= openDB<DraftsDB>(DB_NAME, 1, {
    upgrade(database) {
      const store = database.createObjectStore('drafts', { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    },
  });
  return dbPromise;
}

export async function saveDraft(
  id: string,
  doc: Timeline,
  remote: RemoteLink | null = null,
): Promise<number> {
  const updatedAt = Date.now();
  await (await db()).put('drafts', { id, title: doc.title, doc, updatedAt, remote });
  return updatedAt;
}

/**
 * Loads a draft. Stored documents are re-validated: data in IndexedDB is not
 * trusted blindly (it may predate a schema change, or have been edited).
 */
export async function loadDraft(id: string): Promise<Draft | null> {
  const draft = await (await db()).get('drafts', id);
  if (!draft) return null;
  const result = validateTimeline(draft.doc);
  // Keep editing possible even if invalid; the issues panel will explain.
  return result.success ? { ...draft, doc: result.data } : draft;
}

export async function listDrafts(): Promise<DraftSummary[]> {
  const all = await (await db()).getAllFromIndex('drafts', 'updatedAt');
  return all.reverse().map(({ id, title, updatedAt, doc, remote }) => ({
    id,
    title,
    updatedAt,
    eventCount: doc.events.length,
    /** null = local only; false = has unsynced changes; true = in sync. */
    synced: remote ? !remote.dirty : null,
  }));
}

export async function deleteDraft(id: string): Promise<void> {
  await (await db()).delete('drafts', id);
}

/** Most recently edited draft, if any. */
export async function latestDraft(): Promise<Draft | null> {
  const latest = (await listDrafts()).at(0);
  return latest ? loadDraft(latest.id) : null;
}

/** Asks the browser not to evict our storage under pressure (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!('storage' in navigator)) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Test helper: closes and forgets the cached connection. */
export async function resetDraftsConnection(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}
