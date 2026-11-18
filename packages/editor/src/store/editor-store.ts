import { create } from 'zustand';
import type { Timeline } from '@chronicle/schema';
import type { Command } from './commands.js';
import { createBlankTimeline } from '../lib/document.js';
import { newId } from '../lib/ids.js';

/** Consecutive commands with the same mergeKey within this window become one undo step. */
export const MERGE_WINDOW_MS = 1000;
export const HISTORY_LIMIT = 200;

interface HistoryEntry {
  command: Command;
  time: number;
}

export type SidebarTab = 'events' | 'timeline' | 'theme';

/** Link between a local draft and a project on a Chronicle server. */
export interface RemoteLink {
  projectId: string;
  slug: string;
  role: 'owner' | 'editor' | 'viewer';
  /** Server draft version our last sync was based on (sent as If-Match). */
  baseVersion: number;
  /** Local changes not yet saved to the server (survives reloads via IndexedDB). */
  dirty: boolean;
  lastSyncedAt?: number;
}

export interface EditorState {
  doc: Timeline;
  /** IndexedDB draft this document is saved to. */
  draftId: string;
  selectedId: string | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** Increments on every document change; drives autosave and preview. */
  revision: number;
  sidebarTab: SidebarTab;
  /** Server project this draft syncs with, if any. */
  remote: RemoteLink | null;

  execute: (command: Command) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  setSidebarTab: (tab: SidebarTab) => void;
  /** Loads a document as a fresh editing session (clears history). */
  load: (doc: Timeline, draftId?: string, remote?: RemoteLink | null) => void;
  setRemote: (remote: RemoteLink | null) => void;
}

const markDirty = (remote: RemoteLink | null): RemoteLink | null =>
  remote && !remote.dirty ? { ...remote, dirty: true } : remote;

function existing(doc: Timeline, id: string | null | undefined): string | null {
  return id && doc.events.some((e) => e.id === id) ? id : null;
}

export const useEditor = create<EditorState>()((set, get) => ({
  doc: createBlankTimeline(),
  draftId: newId(),
  selectedId: null,
  past: [],
  future: [],
  revision: 0,
  sidebarTab: 'events',
  remote: null,

  execute: (command) => {
    const { doc, past, selectedId, revision, remote } = get();
    const next = command.apply(doc);
    const now = Date.now();
    const top = past.at(-1);

    let entries: HistoryEntry[];
    if (
      top &&
      command.mergeKey !== undefined &&
      top.command.mergeKey === command.mergeKey &&
      now - top.time < MERGE_WINDOW_MS
    ) {
      // Merge: keep the original revert (state before the first edit).
      const merged: Command = { ...command, revert: top.command.revert };
      entries = [...past.slice(0, -1), { command: merged, time: now }];
    } else {
      entries = [...past, { command, time: now }].slice(-HISTORY_LIMIT);
    }

    set({
      doc: next,
      past: entries,
      future: [],
      revision: revision + 1,
      remote: markDirty(remote),
      selectedId:
        command.selectAfterApply !== undefined
          ? existing(next, command.selectAfterApply)
          : existing(next, selectedId),
    });
  },

  undo: () => {
    const { doc, past, future, selectedId, revision, remote } = get();
    const entry = past.at(-1);
    if (!entry) return;
    const next = entry.command.revert(doc);
    set({
      doc: next,
      past: past.slice(0, -1),
      future: [...future, entry],
      revision: revision + 1,
      remote: markDirty(remote),
      selectedId:
        entry.command.selectAfterRevert !== undefined
          ? existing(next, entry.command.selectAfterRevert)
          : existing(next, selectedId),
    });
  },

  redo: () => {
    const { doc, past, future, selectedId, revision, remote } = get();
    const entry = future.at(-1);
    if (!entry) return;
    const next = entry.command.apply(doc);
    set({
      doc: next,
      // A redone command must never merge with the next edit.
      past: [...past, { command: entry.command, time: 0 }],
      future: future.slice(0, -1),
      revision: revision + 1,
      remote: markDirty(remote),
      selectedId:
        entry.command.selectAfterApply !== undefined
          ? existing(next, entry.command.selectAfterApply)
          : existing(next, selectedId),
    });
  },

  select: (id) => {
    set({ selectedId: id });
  },

  setSidebarTab: (tab) => {
    set({ sidebarTab: tab });
  },

  load: (doc, draftId = newId(), remote = null) => {
    set({
      doc,
      draftId,
      remote,
      selectedId: doc.events[0]?.id ?? null,
      past: [],
      future: [],
      revision: get().revision + 1,
    });
  },

  setRemote: (remote) => {
    set({ remote });
  },
}));

/** Label of the next undo/redo step, for tooltips and screen readers. */
export const selectUndoLabel = (s: EditorState): string | null =>
  s.past.at(-1)?.command.label ?? null;
export const selectRedoLabel = (s: EditorState): string | null =>
  s.future.at(-1)?.command.label ?? null;
export const selectSelectedEvent = (s: EditorState) =>
  s.selectedId ? (s.doc.events.find((e) => e.id === s.selectedId) ?? null) : null;
