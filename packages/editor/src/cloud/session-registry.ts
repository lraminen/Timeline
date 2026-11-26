import type { CommentDto } from '@chronicle/collab';
import { useCloud } from './cloud-store.js';

/**
 * The running collaboration session, seen through a Yjs-free interface, so
 * UI modules (and their tests) don't load Yjs just to ask about it.
 */
export interface SessionHandle {
  readonly projectId: string;
  readonly draftId: string;
  /** The collaborative state to store with the draft. */
  ystate: () => Uint8Array;
  resolve: (choice: 'keep-mine' | 'use-theirs') => void;
  flush: () => Promise<void>;
  retry: () => void;
  setOnline: (online: boolean) => void;
}

let current: SessionHandle | null = null;

export function setCurrentSession(session: SessionHandle | null): void {
  current = session;
}

/** The running session, if a linked draft is open and the user is signed in. */
export function currentSession(): SessionHandle | null {
  return current;
}

/** The collaborative state to save with a draft (undefined = keep what is stored). */
export function currentYState(draftId: string): Uint8Array | undefined {
  return current?.draftId === draftId ? current.ystate() : undefined;
}

/** Applies a comment change (from the server or our own request) to the loaded list. */
export function applyComment(action: 'created' | 'updated' | 'deleted', comment: CommentDto): void {
  const list = useCloud.getState().comments;
  if (!list) return;
  let next: CommentDto[];
  if (action === 'deleted') {
    next = list.filter((c) => c.id !== comment.id && c.parentId !== comment.id);
  } else if (list.some((c) => c.id === comment.id)) {
    next = list.map((c) => (c.id === comment.id ? comment : c));
  } else {
    next = [...list, comment];
  }
  useCloud.setState({ comments: next });
}
