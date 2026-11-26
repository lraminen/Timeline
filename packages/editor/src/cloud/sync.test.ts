import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Timeline } from '@chronicle/schema';
import {
  encodeTimeline,
  fromBase64,
  readTimeline,
  toBase64,
  writeTimeline,
  type WebSocketLike,
} from '@chronicle/collab';
import { createBlankTimeline, createEvent } from '../lib/document.js';
import { loadYState, saveDraft } from '../lib/drafts.js';
import { useEditor, type RemoteLink } from '../store/editor-store.js';
import { updateEvent, updateTimeline } from '../store/commands.js';
import { useCloud, type Api } from './cloud-store.js';
import { CollabSession } from './collab-session.js';
import { linkCurrentDraft, publishCurrent, resolveConflict } from './sync.js';

function doc(): Timeline {
  const d = createBlankTimeline('Synced');
  d.id = 'p1';
  d.events = [
    createEvent({ id: 'a', title: 'A', date: { start: '2000' } }),
    createEvent({ id: 'b', title: 'B', date: { start: '2001' } }),
  ];
  return d;
}

/** A WebSocket that never connects, so sessions use the HTTP fallback. */
class NeverSocket implements WebSocketLike {
  binaryType = 'arraybuffer';
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send(): void {
    /* never connected */
  }
  close(): void {
    /* nothing to close */
  }
}

/** A fake server: a real Yjs document behind the HTTP sync endpoint. */
function fakeServer(initial: Timeline = doc()) {
  const server = new Y.Doc();
  Y.applyUpdate(server, encodeTimeline(initial));
  const state = { role: 'owner' as RemoteLink['role'], draftVersion: 1, syncs: 0, offline: false };
  const api = {
    origin: 'http://api.test',
    refresh: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    createShareLink: vi.fn(),
    uploadMedia: vi.fn(),
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    createProject: vi.fn(() =>
      Promise.resolve({
        id: 'p1',
        title: 'Synced',
        slug: 'synced-abc123',
        role: 'owner' as const,
        isPublic: false,
        draftVersion: 1,
        publishedVersion: null,
        eventCount: 2,
        updatedAt: '',
      }),
    ),
    setVisibility: vi.fn((_id: string, isPublic: boolean) =>
      Promise.resolve({ isPublic } as Awaited<ReturnType<Api['setVisibility']>>),
    ),
    publish: vi.fn(() => Promise.resolve({ version: 1 })),
    pageUrl: (slug: string) => `http://api.test/timeline/${slug}`,
    embedUrl: (slug: string) => `http://api.test/api/v1/embed/${slug}`,
    collabUrl: () => 'ws://api.test/collab',
    getAccessToken: () => Promise.resolve('token'),
    listComments: vi.fn(() => Promise.resolve([])),
    collabSync: vi.fn((_id: string, body: { stateVector?: string; update?: string }) => {
      if (state.offline) {
        return Promise.reject(Object.assign(new Error('offline'), { status: 0 }));
      }
      state.syncs++;
      if (body.update) {
        if (state.role === 'viewer') return Promise.reject(new Error('read only'));
        Y.applyUpdate(server, fromBase64(body.update));
        state.draftVersion++;
      }
      return Promise.resolve({
        role: state.role,
        update: toBase64(
          Y.encodeStateAsUpdate(
            server,
            body.stateVector ? fromBase64(body.stateVector) : undefined,
          ),
        ),
        stateVector: toBase64(Y.encodeStateVector(server)),
        draftVersion: state.draftVersion,
        problems: [],
      });
    }),
  } satisfies Api;
  return {
    api,
    state,
    server,
    timeline: () => readTimeline(server),
    edit: (change: (t: Timeline) => Timeline) => {
      writeTimeline(server, change(readTimeline(server)));
      state.draftVersion++;
    },
  };
}

const editor = () => useEditor.getState();
const cloud = () => useCloud.getState();
const rename = (title: string) => {
  editor().execute(updateTimeline(editor().doc, { title }));
};
const link = (patch: Partial<RemoteLink> = {}): RemoteLink => ({
  projectId: 'p1',
  slug: 'synced-abc123',
  role: 'owner',
  baseVersion: 1,
  dirty: false,
  lastSyncedAt: 1,
  ...patch,
});

async function until(check: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const sessions: CollabSession[] = [];
function startSession(api: Api, draftId = 'draft-1'): CollabSession {
  const session = new CollabSession(api, 'p1', draftId, {
    WebSocket: NeverSocket as unknown as never,
    httpFallbackMs: 15,
  });
  sessions.push(session);
  void session.start();
  return session;
}

let draftCounter = 0;
beforeEach(() => {
  draftCounter++;
  editor().load(doc(), `draft-${String(draftCounter)}`, null);
  useCloud.setState({
    api: null,
    user: null,
    conflict: null,
    sync: { kind: 'local' },
    connection: 'off',
    peers: [],
    comments: null,
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
});

describe('linking and opening', () => {
  it('links a local draft to a new server project', async () => {
    const { api } = fakeServer();
    useCloud.setState({ api });
    const remote = await linkCurrentDraft();
    expect(api.createProject).toHaveBeenCalledOnce();
    expect(remote).toMatchObject({ projectId: 'p1', role: 'owner', baseVersion: 1, dirty: false });
    expect(editor().doc.id).toBe('p1');
  });

  it('adopts the server copy when the draft has no unsynced changes', async () => {
    const fake = fakeServer();
    fake.edit((t) => ({ ...t, title: 'Changed elsewhere' }));
    editor().load(doc(), editor().draftId, link());
    startSession(fake.api, editor().draftId);
    await until(() => editor().doc.title === 'Changed elsewhere', 'server copy');
    expect(editor().past).toHaveLength(0);
  });
});

describe('live sync (HTTP fallback)', () => {
  it('sends local edits, receives remote ones, and merges concurrent edits', async () => {
    const fake = fakeServer();
    editor().load(doc(), editor().draftId, link());
    startSession(fake.api, editor().draftId);
    await until(() => cloud().connection === 'http', 'HTTP fallback');

    editor().execute(updateEvent(editor().doc, 'a', { title: 'A (mine)' }));
    expect(editor().remote?.dirty).toBe(true);
    fake.edit((t) => ({
      ...t,
      events: t.events.map((e) => (e.id === 'b' ? { ...e, title: 'B (theirs)' } : e)),
    }));
    await until(
      () => editor().doc.events[1]?.title === 'B (theirs)' && editor().remote?.dirty === false,
      'merge',
    );
    expect(fake.timeline().events.map((e) => e.title)).toEqual(['A (mine)', 'B (theirs)']);
    expect(cloud().sync.kind).toBe('synced');
    // The collaborative state is stored with the draft.
    expect(await loadYState(editor().draftId)).not.toBeNull();
  });

  it('undo reverts only my own edit and keeps collaborators’ changes', async () => {
    const fake = fakeServer();
    editor().load(doc(), editor().draftId, link());
    startSession(fake.api, editor().draftId);
    await until(() => cloud().connection === 'http');

    editor().execute(updateEvent(editor().doc, 'a', { title: 'A edited' }));
    fake.edit((t) => ({ ...t, title: 'Renamed by someone else' }));
    await until(() => editor().doc.title === 'Renamed by someone else', 'remote change');
    expect(editor().past).toHaveLength(1);

    editor().undo();
    expect(editor().doc.events[0]?.title).toBe('A');
    expect(editor().doc.title).toBe('Renamed by someone else');
    await until(() => fake.timeline().events[0]?.title === 'A', 'undo to sync');
    expect(fake.timeline().title).toBe('Renamed by someone else');
  });

  it('keeps offline edits and sends them once back online, even after a reload', async () => {
    const fake = fakeServer();
    const draftId = editor().draftId;
    editor().load(doc(), draftId, link());
    const first = startSession(fake.api, draftId);
    await until(() => cloud().connection === 'http');

    fake.state.offline = true;
    rename('Edited offline');
    await until(() => editor().remote?.dirty === true);
    // "Reload": stop the session, keeping what autosave stores.
    await saveDraft(draftId, editor().doc, editor().remote, Y.encodeStateAsUpdate(first.doc));
    first.destroy();
    fake.edit((t) => ({ ...t, events: t.events.filter((e) => e.id !== 'b') }));

    fake.state.offline = false;
    startSession(fake.api, draftId);
    await until(() => editor().remote?.dirty === false, 'offline edit to sync');
    expect(fake.timeline().title).toBe('Edited offline');
    expect(fake.timeline().events.map((e) => e.id)).toEqual(['a']);
    await until(() => editor().doc.events.length === 1, 'remote delete');
  });

  it('does not send edits for viewers', async () => {
    const fake = fakeServer();
    fake.state.role = 'viewer';
    editor().load(doc(), editor().draftId, link({ role: 'viewer' }));
    startSession(fake.api, editor().draftId);
    await until(() => cloud().connection === 'http');
    rename('Viewer edit');
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.timeline().title).toBe('Synced');
    expect(cloud().sync).toMatchObject({ kind: 'blocked' });
  });
});

describe('drafts with unsynced changes from before live collaboration', () => {
  it('applies them when the server has not moved on', async () => {
    const fake = fakeServer();
    const mine = { ...doc(), title: 'Mine' };
    editor().load(mine, editor().draftId, link({ dirty: true, baseVersion: 1 }));
    startSession(fake.api, editor().draftId);
    await until(() => fake.timeline().title === 'Mine', 'local changes to sync');
    expect(cloud().conflict).toBeNull();
  });

  it('asks when the server has moved on: keep mine', async () => {
    const fake = fakeServer();
    fake.edit((t) => ({ ...t, title: 'Theirs' }));
    editor().load({ ...doc(), title: 'Mine' }, editor().draftId, link({ dirty: true }));
    startSession(fake.api, editor().draftId);
    await until(() => cloud().conflict !== null, 'conflict');
    expect(cloud().conflict?.serverDraft.title).toBe('Theirs');
    await resolveConflict('keep-mine');
    await until(() => fake.timeline().title === 'Mine', 'keep mine');
  });

  it('asks when the server has moved on: use theirs (undoable)', async () => {
    const fake = fakeServer();
    fake.edit((t) => ({ ...t, title: 'Theirs' }));
    editor().load({ ...doc(), title: 'Mine' }, editor().draftId, link({ dirty: true }));
    startSession(fake.api, editor().draftId);
    await until(() => cloud().conflict !== null);
    await resolveConflict('use-theirs');
    expect(editor().doc.title).toBe('Theirs');
    editor().undo();
    expect(editor().doc.title).toBe('Mine');
  });
});

describe('publish', () => {
  it('waits for local edits to reach the server, sets visibility and publishes', async () => {
    const fake = fakeServer();
    useCloud.setState({ api: fake.api });
    editor().load(doc(), editor().draftId, link());
    startSession(fake.api, editor().draftId);
    await until(() => cloud().connection === 'http');
    rename('Ready to publish');
    const result = await publishCurrent({ isPublic: true, message: 'v1' });
    expect(fake.timeline().title).toBe('Ready to publish');
    expect(fake.api.setVisibility).toHaveBeenCalledWith('p1', true);
    expect(fake.api.publish).toHaveBeenCalledWith('p1', 'v1');
    expect(result).toMatchObject({
      version: 1,
      pageUrl: 'http://api.test/timeline/synced-abc123',
      isPublic: true,
    });
  });

  it('refuses to publish a timeline with errors', async () => {
    const fake = fakeServer();
    useCloud.setState({ api: fake.api });
    editor().load(doc(), editor().draftId, link());
    editor().execute(updateEvent(editor().doc, 'a', { title: '' }));
    await expect(publishCurrent({ isPublic: false })).rejects.toThrow(/Fix the problems/);
    expect(fake.api.publish).not.toHaveBeenCalled();
  });
});
