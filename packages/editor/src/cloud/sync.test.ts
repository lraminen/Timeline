import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Timeline } from '@chronicle/schema';
import { ApiRequestError, DraftConflict } from '../lib/api.js';
import { createBlankTimeline, createEvent } from '../lib/document.js';
import { useEditor } from '../store/editor-store.js';
import { updateEvent, updateTimeline } from '../store/commands.js';
import { useCloud, type Api } from './cloud-store.js';
import { linkCurrentDraft, publishCurrent, pushDraft, resolveConflict } from './sync.js';

function doc(): Timeline {
  const d = createBlankTimeline('Synced');
  d.events = [createEvent({ id: 'a', title: 'A', date: { start: '2000' } })];
  return d;
}

function fakeApi(
  overrides: Partial<Api> = {},
): Api & { saves: { version: number; title: string }[] } {
  const saves: { version: number; title: string }[] = [];
  let serverVersion = 1;
  return {
    saves,
    origin: 'http://api.test',
    refresh: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    listProjects: vi.fn(),
    getProject: vi.fn(),
    getDraft: vi.fn(),
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
        eventCount: 1,
        updatedAt: '',
      }),
    ),
    saveDraft: vi.fn((_id: string, timeline: Timeline, base: number) => {
      if (base !== serverVersion) {
        return Promise.reject(
          new DraftConflict(serverVersion, { ...timeline, title: 'Server title' }, ''),
        );
      }
      serverVersion += 1;
      saves.push({ version: serverVersion, title: timeline.title });
      return Promise.resolve(serverVersion);
    }),
    setVisibility: vi.fn((_id: string, isPublic: boolean) =>
      Promise.resolve({ isPublic } as Awaited<ReturnType<Api['setVisibility']>>),
    ),
    publish: vi.fn(() => Promise.resolve({ version: 1 })),
    pageUrl: (slug: string) => `http://api.test/timeline/${slug}`,
    embedUrl: (slug: string) => `http://api.test/api/v1/embed/${slug}`,
    ...overrides,
  };
}

const editor = () => useEditor.getState();
const cloud = () => useCloud.getState();
const rename = (title: string) => {
  editor().execute(updateTimeline(editor().doc, { title }));
};

beforeEach(() => {
  vi.useRealTimers();
  editor().load(doc(), 'draft-1', null);
  useCloud.setState({ api: null, user: null, conflict: null, sync: { kind: 'local' } });
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

async function signedInAndLinked(api = fakeApi()) {
  useCloud.setState({ api, user: { id: 'u', email: 'u@x.y', name: 'U' } });
  await linkCurrentDraft();
  return api;
}

describe('cloud sync', () => {
  it('links a local draft to a new server project', async () => {
    await signedInAndLinked();
    expect(editor().remote).toMatchObject({
      projectId: 'p1',
      baseVersion: 1,
      dirty: false,
      role: 'owner',
    });
    expect(editor().doc.id).toBe('p1');
  });

  it('marks edits (and undo) dirty, then pushes with the base version', async () => {
    const api = await signedInAndLinked();
    rename('Edited');
    expect(editor().remote?.dirty).toBe(true);
    await pushDraft();
    expect(api.saves).toEqual([{ version: 2, title: 'Edited' }]);
    expect(editor().remote).toMatchObject({ baseVersion: 2, dirty: false });
    expect(cloud().sync.kind).toBe('synced');

    editor().undo();
    expect(editor().remote?.dirty).toBe(true);
  });

  it('keeps the draft dirty when edits happen during a save', async () => {
    let release: (v: number) => void = () => undefined;
    const api = await signedInAndLinked(
      fakeApi({ saveDraft: vi.fn(() => new Promise<number>((r) => (release = r))) }),
    );
    rename('First');
    const pending = pushDraft();
    rename('Second'); // edit while the request is in flight
    release(2);
    await pending;
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    expect(editor().remote).toMatchObject({ baseVersion: 2, dirty: true });
    expect(cloud().sync.kind).toBe('pending');
  });

  it('does not push while offline, signed out, read-only or invalid', async () => {
    const api = await signedInAndLinked();

    rename('Offline edit');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await pushDraft();
    expect(cloud().sync.kind).toBe('offline');
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });

    useCloud.setState({ user: null });
    await pushDraft();
    expect(cloud().sync).toMatchObject({ kind: 'blocked' });
    useCloud.setState({ user: { id: 'u', email: 'u@x.y', name: 'U' } });

    editor().execute(updateEvent(editor().doc, 'a', { title: '' })); // invalid
    await pushDraft();
    const blocked = cloud().sync;
    expect(blocked.kind === 'blocked' && blocked.reason).toMatch(/Fix/);
    expect(api.saves).toEqual([]);

    // Back to valid + online → the queued changes go up.
    editor().execute(updateEvent(editor().doc, 'a', { title: 'A' }));
    await pushDraft();
    expect(api.saves.at(-1)?.title).toBe('Offline edit');
    expect(editor().remote?.dirty).toBe(false);
  });

  it('maps network failures to offline and expired sessions to signed-out', async () => {
    await signedInAndLinked(
      fakeApi({
        saveDraft: vi.fn(() => Promise.reject(new ApiRequestError(0, 'network', 'down'))),
      }),
    );
    rename('x');
    await pushDraft();
    expect(cloud().sync.kind).toBe('offline');
    expect(editor().remote?.dirty).toBe(true);

    useCloud.setState({
      api: fakeApi({
        saveDraft: vi.fn(() => Promise.reject(new ApiRequestError(401, 'unauthorized', 'no'))),
      }),
    });
    await pushDraft();
    expect(cloud().user).toBeNull();
  });
});

describe('conflicts', () => {
  async function conflicted() {
    const api = await signedInAndLinked();
    // Someone else saves first: the server is now at version 2.
    await api.saveDraft('p1', doc(), 1);
    rename('Mine');
    await pushDraft();
    expect(cloud().sync.kind).toBe('conflict');
    expect(cloud().conflict?.serverVersion).toBe(2);
    return api;
  }

  it('keep mine: overwrites the server copy', async () => {
    const api = await conflicted();
    await resolveConflict('keep-mine');
    expect(api.saves.at(-1)).toEqual({ version: 3, title: 'Mine' });
    expect(editor().remote).toMatchObject({ baseVersion: 3, dirty: false });
    expect(cloud().conflict).toBeNull();
  });

  it('use theirs: loads the server copy, undoably', async () => {
    await conflicted();
    await resolveConflict('use-theirs');
    expect(editor().doc.title).toBe('Server title');
    expect(editor().remote).toMatchObject({ baseVersion: 2, dirty: false });
    editor().undo();
    expect(editor().doc.title).toBe('Mine');
  });

  it('save a copy: links my version to a new project', async () => {
    const api = await conflicted();
    await resolveConflict('save-copy');
    expect(api.createProject).toHaveBeenCalledTimes(2);
    expect(editor().doc.title).toBe('Mine (my copy)');
    expect(editor().remote?.dirty).toBe(false);
  });
});

describe('publish', () => {
  it('links, syncs pending edits, sets visibility and publishes', async () => {
    const api = fakeApi();
    useCloud.setState({ api, user: { id: 'u', email: 'u@x.y', name: 'U' } });
    const result = await publishCurrent({ isPublic: true, message: 'v1' });
    expect(api.createProject).toHaveBeenCalled();
    expect(api.setVisibility).toHaveBeenCalledWith('p1', true);
    expect(api.publish).toHaveBeenCalledWith('p1', 'v1');
    expect(result).toEqual({
      version: 1,
      isPublic: true,
      pageUrl: 'http://api.test/timeline/synced-abc123',
      embedUrl: 'http://api.test/api/v1/embed/synced-abc123',
      scriptUrl: 'http://api.test/embed.js',
    });

    rename('Changed before publish');
    await publishCurrent({ isPublic: true });
    expect(api.saves.at(-1)?.title).toBe('Changed before publish');
  });

  it('refuses to publish unsaved invalid changes', async () => {
    await signedInAndLinked();
    editor().execute(updateEvent(editor().doc, 'a', { title: '' }));
    await expect(publishCurrent({ isPublic: false })).rejects.toThrow(/Fix the problems/);
  });
});

describe('lost acknowledgements', () => {
  it('treats a 412 whose server copy matches ours as already saved, not a conflict', async () => {
    const api = await signedInAndLinked();
    rename('Saved but the response was lost');
    // The server got our save (now at v2) but we never heard back: base is still 1.
    await api.saveDraft('p1', editor().doc, 1);
    api.saveDraft = vi.fn((_id: string, _t: Timeline, base: number) =>
      Promise.reject(
        new DraftConflict(
          2,
          // Same content, different key order (as Postgres jsonb returns it).
          Object.fromEntries(Object.entries({ ...editor().doc, id: 'p1' }).reverse()) as Timeline,
          String(base),
        ),
      ),
    );
    await pushDraft();
    expect(cloud().conflict).toBeNull();
    expect(cloud().sync.kind).toBe('synced');
    expect(editor().remote).toMatchObject({ baseVersion: 2, dirty: false });
  });

  it('still reports a real conflict when the content differs', async () => {
    const api = await signedInAndLinked();
    await api.saveDraft('p1', { ...doc(), title: 'Someone else' }, 1);
    rename('Mine');
    await pushDraft();
    expect(cloud().conflict).not.toBeNull();
  });

  it('persists the new base version immediately after syncing', async () => {
    const { loadDraft } = await import('../lib/drafts.js');
    await signedInAndLinked();
    rename('Persist me');
    await pushDraft();
    await new Promise((r) => setTimeout(r, 50));
    const stored = await loadDraft(editor().draftId);
    expect(stored?.remote).toMatchObject({ baseVersion: 2, dirty: false });
  });
});
