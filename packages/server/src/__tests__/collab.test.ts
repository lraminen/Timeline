import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { count, eq } from 'drizzle-orm';
import WebSocket from 'ws';
import * as Y from 'yjs';
import type { FastifyInstance } from 'fastify';
import type { Timeline } from '@chronicle/schema';
import {
  CollabClient,
  decodeMessage,
  encodeControl,
  encodeUpdate,
  fromBase64,
  readTimeline,
  toBase64,
  writeTimeline,
  type ServerControl,
  type WebSocketConstructor,
} from '@chronicle/collab';
import { buildApp } from '../app.js';
import { collabUpdates, projects } from '../db/schema.js';
import { FsStorage } from '../media/storage.js';
import {
  createProject,
  createTestServer,
  EDITOR_ORIGIN,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

/** `ws` client that sends the editor's Origin, like a browser would. */
function wsWith(origin: string | null): WebSocketConstructor {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, origin ? { headers: { origin } } : {});
    }
  } as unknown as WebSocketConstructor;
}

async function waitFor(check: () => boolean | Promise<boolean>, what = 'condition', ms = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Peer {
  client: CollabClient;
  doc: Y.Doc;
  messages: ServerControl[];
  timeline: () => Timeline;
  edit: (change: (t: Timeline) => Timeline) => void;
}

const peers: Peer[] = [];

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  return `ws://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
}

async function connect(
  base: string,
  projectId: string,
  user: TestUser | string,
  options: { origin?: string | null; waitSynced?: boolean; doc?: Y.Doc; pending?: boolean } = {},
): Promise<Peer> {
  const doc = options.doc ?? new Y.Doc();
  const client = new CollabClient({
    url: `${base}/api/v1/projects/${projectId}/collab`,
    doc,
    getToken: () => Promise.resolve(typeof user === 'string' ? user : user.token),
    WebSocket: wsWith(options.origin === undefined ? EDITOR_ORIGIN : options.origin),
    pending: options.pending,
    minReconnectDelayMs: 50,
    maxReconnectDelayMs: 200,
  });
  const messages: ServerControl[] = [];
  client.on('message', (m) => messages.push(m));
  const peer: Peer = {
    client,
    doc,
    messages,
    timeline: () => readTimeline(doc),
    edit: (change) => {
      writeTimeline(doc, change(readTimeline(doc)));
    },
  };
  peers.push(peer);
  client.connect();
  if (options.waitSynced !== false) {
    await waitFor(() => client.synced, 'initial sync');
  }
  return peer;
}

const retitle = (title: string) => (t: Timeline) => ({ ...t, title });
const editEvent =
  (id: string, patch: Partial<Timeline['events'][number]>) =>
  (t: Timeline): Timeline => ({
    ...t,
    events: t.events.map((e) => (e.id === id ? { ...e, ...patch } : e)),
  });

/** Opens a raw socket and returns the close event (for rejection tests). */
function rawClose(
  url: string,
  origin: string | null,
  first?: Uint8Array | string,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { headers: { origin } } : {});
    ws.on('open', () => {
      if (first !== undefined) ws.send(first);
    });
    ws.on('close', (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

describe('real-time collaboration', () => {
  let ctx: TestContext;
  let base: string;
  let owner: TestUser;
  let project: { id: string; slug: string; draftVersion: number };

  beforeEach(async () => {
    ctx = await createTestServer({ COLLAB_DRAFT_SAVE_MS: '50' });
    base = await listen(ctx.app);
    owner = await signUp(ctx.app, 'Ada Owner');
    project = await createProject(ctx.app, owner);
  });

  afterEach(async () => {
    for (const p of peers.splice(0)) p.client.destroy();
    await ctx.close();
  });

  async function addCollaborator(role: 'editor' | 'viewer', name = 'Grace'): Promise<TestUser> {
    const user = await signUp(ctx.app, name);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/collaborators`,
      headers: owner.auth,
      payload: { email: user.email, role },
    });
    expect(res.statusCode).toBe(201);
    return user;
  }

  const getDraft = async (user: TestUser = owner) => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/draft`,
      headers: user.auth,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ draftVersion: number; timeline: Timeline }>();
  };

  it('syncs edits between two editors live and saves the JSON draft', async () => {
    const grace = await addCollaborator('editor');
    const a = await connect(base, project.id, owner);
    const b = await connect(base, project.id, grace);
    expect(a.client.role).toBe('owner');
    expect(b.client.role).toBe('editor');
    expect(a.timeline().events.map((e) => e.id)).toEqual(['sputnik', 'apollo']);

    a.edit(retitle('The Space Race'));
    b.edit(editEvent('apollo', { body: 'One small step.' }));
    await waitFor(
      () =>
        a.timeline().events[1]?.body === 'One small step.' &&
        b.timeline().title === 'The Space Race',
      'edits to cross over',
    );
    await waitFor(() => !a.client.pending && !b.client.pending, 'acks');

    // The saved draft reflects both edits and announces its new version.
    const draft = await getDraft();
    expect(draft.timeline.title).toBe('The Space Race');
    expect(draft.timeline.events[1]?.body).toBe('One small step.');
    expect(draft.draftVersion).toBeGreaterThan(project.draftVersion);
    await waitFor(() => a.messages.some((m) => m.type === 'saved'), 'saved message');
  });

  it('merges concurrent typing in the same field', async () => {
    const grace = await addCollaborator('editor');
    const a = await connect(base, project.id, owner);
    const b = await connect(base, project.id, grace);
    a.client.disconnect();
    b.client.disconnect();
    a.edit(editEvent('sputnik', { body: 'The first **satellite**.' }));
    b.edit(editEvent('sputnik', { body: 'First **satellite**, launched by the USSR.' }));
    a.client.connect();
    b.client.connect();
    const expected = 'The first **satellite**, launched by the USSR.';
    await waitFor(
      () => a.timeline().events[0]?.body === expected && b.timeline().events[0]?.body === expected,
      'merge',
    );
    await waitFor(() => !a.client.pending && !b.client.pending, 'acks');
    expect((await getDraft()).timeline.events[0]?.body).toBe(expected);
  });

  it('applies REST changes to connected editors and keeps If-Match semantics', async () => {
    const a = await connect(base, project.id, owner);
    const current = await getDraft();

    // Whole-document PUT, as API clients and older editors do.
    const replaced = { ...current.timeline, title: 'Replaced over REST' };
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/draft`,
      headers: { ...owner.auth, 'if-match': `"${String(current.draftVersion)}"` },
      payload: { timeline: replaced },
    });
    expect(put.statusCode).toBe(200);
    await waitFor(() => a.timeline().title === 'Replaced over REST', 'REST change to arrive');

    // A stale version is still refused with the server copy.
    const stale = await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/draft`,
      headers: { ...owner.auth, 'if-match': `"${String(current.draftVersion)}"` },
      payload: { timeline: current.timeline },
    });
    expect(stale.statusCode).toBe(412);
    expect(
      stale.json<{ error: { details: { draft: Timeline } } }>().error.details.draft.title,
    ).toBe('Replaced over REST');

    // Fine-grained event API.
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/events`,
      headers: owner.auth,
      payload: { title: 'Vostok 1', date: { start: '1961-04-12' } },
    });
    expect(added.statusCode).toBe(201);
    const newId = added.json<{ id: string }>().id;
    await waitFor(() => a.timeline().events.some((e) => e.id === newId), 'event to arrive');

    // A live edit made right before a REST read is included in it.
    a.edit(editEvent('apollo', { title: 'Apollo 11 lands' }));
    await waitFor(() => !a.client.pending, 'ack');
    const events = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/events/apollo`,
      headers: owner.auth,
    });
    expect(events.json<{ title: string }>().title).toBe('Apollo 11 lands');
  });

  it('merges offline edits with changes made meanwhile', async () => {
    const a = await connect(base, project.id, owner);
    a.client.disconnect();
    a.edit(editEvent('sputnik', { tags: ['ussr', 'offline'] }));
    expect(a.client.pending).toBe(true);

    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/events/apollo`,
      headers: owner.auth,
      payload: { title: 'Apollo 11 (REST)' },
    });

    a.client.connect();
    await waitFor(() => a.timeline().events[1]?.title === 'Apollo 11 (REST)', 'REST edit');
    await waitFor(() => !a.client.pending, 'offline edit to be stored');
    const draft = await getDraft();
    expect(draft.timeline.events[0]?.tags).toEqual(['ussr', 'offline']);
    expect(draft.timeline.events[1]?.title).toBe('Apollo 11 (REST)');
  });

  it('shares invalid in-progress states live but keeps the stored draft valid', async () => {
    const a = await connect(base, project.id, owner);
    a.edit(editEvent('apollo', { title: '' }));
    await waitFor(() => !a.client.pending, 'ack');
    await ctx.app.ctx.collab.flush(project.id);
    expect((await getDraft()).timeline.events[1]?.title).toBe('Apollo 11');

    const sync = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/sync`,
      headers: owner.auth,
      payload: {},
    });
    expect(sync.json<{ problems: { path: string }[] }>().problems[0]?.path).toBe('events.1.title');

    // Publishing uses the last valid draft.
    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: {},
    });
    expect(published.statusCode).toBe(201);
  });

  it('relays presence with the authenticated identity, never the claimed one', async () => {
    const grace = await addCollaborator('editor', 'Grace Hopper');
    const a = await connect(base, project.id, owner);
    const b = await connect(base, project.id, grace);
    b.client.awareness.setLocalState({
      user: { id: owner.id, name: 'Not Grace' },
      eventId: 'apollo',
      field: 'title',
    });
    const remote = () =>
      [...a.client.awareness.getStates().entries()]
        .filter(([id]) => id !== a.doc.clientID)
        .map(([, s]) => s as { user: { id: string; name: string }; eventId: string });
    await waitFor(() => remote()[0]?.eventId === 'apollo', 'presence');
    expect(remote()).toHaveLength(1);
    expect(remote()[0]).toMatchObject({
      user: { id: grace.id, name: 'Grace Hopper' },
      eventId: 'apollo',
      field: 'title',
    });

    // Late joiners get current presence; leaving removes it.
    const c = await connect(base, project.id, owner);
    await waitFor(
      () => [...c.client.awareness.getStates().values()].some((s) => s.eventId === 'apollo'),
      'presence for late joiner',
    );
    b.client.destroy();
    await waitFor(() => !remote().some((s) => s.user.id === grace.id), 'presence removal');
  });

  it('lets viewers follow along but not write', async () => {
    const viewer = await addCollaborator('viewer');
    const v = await connect(base, project.id, viewer);
    const a = await connect(base, project.id, owner);
    expect(v.client.readOnly).toBe(true);
    a.edit(retitle('Owner edit'));
    await waitFor(() => v.timeline().title === 'Owner edit', 'viewer to receive edit');

    // A crafted update from a viewer is refused.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(v.doc));
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    writeTimeline(doc, { ...readTimeline(doc), title: 'Viewer was here' });
    const ws = new WebSocket(`${base}/api/v1/projects/${project.id}/collab`, {
      headers: { origin: EDITOR_ORIGIN },
    });
    const errors: string[] = [];
    await new Promise<void>((resolve) => {
      ws.on('open', () => {
        ws.send(encodeControl({ type: 'auth', token: viewer.token }));
      });
      ws.on('message', (data: Buffer) => {
        const m = decodeMessage(new Uint8Array(data));
        if (m.kind === 'control') {
          const c = m.message as ServerControl;
          if (c.type === 'ready') ws.send(encodeUpdate(updates[0] ?? new Uint8Array()));
          if (c.type === 'error') {
            errors.push(c.code);
            resolve();
          }
        }
      });
    });
    ws.close();
    expect(errors).toEqual(['read_only']);
    expect(a.timeline().title).toBe('Owner edit');

    const sync = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/sync`,
      headers: viewer.auth,
      payload: { update: toBase64(updates[0] ?? new Uint8Array()) },
    });
    expect(sync.statusCode).toBe(403);
  });

  it('rejects bad origins, credentials, non-members and junk frames', async () => {
    const url = `${base}/api/v1/projects/${project.id}/collab`;
    const stranger = await signUp(ctx.app, 'Stranger');
    expect((await rawClose(url, 'https://evil.example')).code).toBe(4003);
    expect(
      (await rawClose(url, EDITOR_ORIGIN, encodeControl({ type: 'auth', token: 'nope' }))).code,
    ).toBe(4001);
    expect(
      (await rawClose(url, EDITOR_ORIGIN, encodeControl({ type: 'auth', token: stranger.token })))
        .code,
    ).toBe(4004);
    expect((await rawClose(url, EDITOR_ORIGIN, 'text frame')).code).toBe(4008);
    expect((await rawClose(url, EDITOR_ORIGIN, new Uint8Array([9, 9, 9]))).code).toBe(4008);
    // Sync frames before authenticating.
    expect((await rawClose(url, EDITOR_ORIGIN, encodeUpdate(new Uint8Array([0, 0])))).code).toBe(
      4001,
    );
    expect((await rawClose(`${base}/api/v1/projects/not-a-uuid/collab`, EDITOR_ORIGIN)).code).toBe(
      4004,
    );
    // Non-browser clients (no Origin) can use API keys.
    const key = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: owner.auth,
      payload: { label: 'script' },
    });
    const apiKey = key.json<{ key: string; id: string }>();
    const scripted = await connect(base, project.id, apiKey.key, { origin: null });
    expect(scripted.client.role).toBe('owner');
    // Revoking the key disconnects it.
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/api-keys/${apiKey.id}`,
      headers: owner.auth,
    });
    await waitFor(() => scripted.client.status !== 'connected', 'revoked key to disconnect');
  });

  it('disconnects people whose access is removed and tells those whose role changes', async () => {
    const grace = await addCollaborator('editor');
    const b = await connect(base, project.id, grace);
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/collaborators/${grace.id}`,
      headers: owner.auth,
      payload: { role: 'viewer' },
    });
    expect(patch.statusCode).toBe(200);
    await waitFor(() => b.client.readOnly, 'role change');
    expect(b.messages).toContainEqual({ type: 'role', role: 'viewer' });

    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}/collaborators/${grace.id}`,
      headers: owner.auth,
    });
    await waitFor(() => b.client.status === 'closed', 'removal');
    expect(b.client.closeReason?.code).toBe(4003);
  });

  it('closes connections when the project is deleted', async () => {
    const a = await connect(base, project.id, owner);
    await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}`,
      headers: owner.auth,
    });
    await waitFor(() => a.client.status === 'closed', 'close');
    expect(a.client.closeReason?.code).toBe(4004);
  });

  it('syncs over HTTP for clients without a WebSocket', async () => {
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/sync`,
      headers: owner.auth,
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    const body = first.json<{ update: string; stateVector: string; role: string }>();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(body.update));
    expect(readTimeline(doc).title).toBe('Space Race');

    const before = Y.encodeStateVector(doc);
    writeTimeline(doc, { ...readTimeline(doc), title: 'Synced over HTTP' });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/sync`,
      headers: owner.auth,
      payload: {
        stateVector: toBase64(Y.encodeStateVector(doc)),
        update: toBase64(Y.encodeStateAsUpdate(doc, before)),
      },
    });
    expect(res.statusCode).toBe(200);
    await ctx.app.ctx.collab.flush(project.id);
    expect((await getDraft()).timeline.title).toBe('Synced over HTTP');

    const bad = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/sync`,
      headers: owner.auth,
      payload: { update: toBase64(new Uint8Array([1, 2, 3, 4, 5])) },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('survives a restart: state is stored, compacted and reloaded', async () => {
    await ctx.app.close();
    // Same database, compaction after every 3 rows.
    const config = { ...ctx.config, COLLAB_COMPACT_EVERY: 3, COLLAB_DRAFT_SAVE_MS: 20 };
    const first = await buildApp({
      config,
      database: ctx.database,
      storage: new FsStorage(ctx.storageDir),
      logger: false,
    });
    const url = await listen(first);
    const a = await connect(url, project.id, owner);
    for (let i = 0; i < 7; i++) {
      a.edit(editEvent('apollo', { body: `Revision ${String(i)}` }));
      await waitFor(() => !a.client.pending, 'ack');
    }
    const rows = await ctx.database.db
      .select({ n: count() })
      .from(collabUpdates)
      .where(eq(collabUpdates.projectId, project.id));
    expect(rows[0]?.n ?? 99).toBeLessThan(3);
    a.client.destroy();
    await first.close();

    const second = await buildApp({
      config,
      database: ctx.database,
      storage: new FsStorage(ctx.storageDir),
      logger: false,
    });
    try {
      const b = await connect(await listen(second), project.id, owner);
      expect(b.timeline().events[1]?.body).toBe('Revision 6');
      const [row] = await ctx.database.db
        .select({ draft: projects.draft })
        .from(projects)
        .where(eq(projects.id, project.id));
      expect(row?.draft.events[1]?.body).toBe('Revision 6');
      b.client.destroy();
    } finally {
      await second.close();
    }
    // Let afterEach close the shared database through a fresh app.
    ctx.app = await buildApp({
      config: ctx.config,
      database: ctx.database,
      storage: new FsStorage(ctx.storageDir),
      logger: false,
    });
  });

  it('keeps several server instances consistent', async () => {
    // A second instance on the same database, picking up rows by polling.
    const config = { ...ctx.config, COLLAB_POLL_MS: 50, COLLAB_DRAFT_SAVE_MS: 20 };
    const other = await buildApp({
      config,
      database: ctx.database,
      storage: new FsStorage(ctx.storageDir),
      logger: false,
    });
    try {
      const otherUrl = await listen(other);
      const a = await connect(base, project.id, owner);
      const b = await connect(otherUrl, project.id, owner);
      a.edit(editEvent('sputnik', { title: 'Sputnik (instance A)' }));
      b.edit(editEvent('apollo', { title: 'Apollo (instance B)' }));
      // B's change reaches A when A's room next writes or catches up; force a write on A.
      await waitFor(() => !a.client.pending && !b.client.pending, 'acks');
      await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/projects/${project.id}`,
        headers: owner.auth,
        payload: { title: 'Renamed on A' },
      });
      await waitFor(
        () =>
          b.timeline().events[0]?.title === 'Sputnik (instance A)' &&
          b.timeline().title === 'Renamed on A',
        'A → B',
      );
      await waitFor(() => a.timeline().events[1]?.title === 'Apollo (instance B)', 'B → A');
      // The saved draft has everything, whichever instance wrote it last.
      await other.ctx.collab.flush(project.id);
      const draft = await getDraft();
      expect(draft.timeline.title).toBe('Renamed on A');
      expect(draft.timeline.events.map((e) => e.title)).toEqual([
        'Sputnik (instance A)',
        'Apollo (instance B)',
      ]);
    } finally {
      for (const p of peers.splice(0)) p.client.destroy();
      await other.close();
    }
  });

  it('refuses documents over the size limit', async () => {
    await ctx.app.close();
    ctx.app = await buildApp({
      config: { ...ctx.config, COLLAB_MAX_DOC_MB: 0.02 },
      database: ctx.database,
      storage: new FsStorage(ctx.storageDir),
      logger: false,
    });
    const a = await connect(await listen(ctx.app), project.id, owner);
    a.edit(editEvent('apollo', { body: 'x'.repeat(40_000) }));
    await waitFor(() => a.client.status === 'closed', 'close');
    expect(a.client.closeReason).toMatchObject({ code: 4008 });
  });
});
