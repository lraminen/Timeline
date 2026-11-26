import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  CollabClient,
  readTimeline,
  writeTimeline,
  type CommentDto,
  type ServerControl,
  type WebSocketConstructor,
} from '@chronicle/collab';
import {
  createProject,
  createTestServer,
  EDITOR_ORIGIN,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

describe('event comments', () => {
  let ctx: TestContext;
  let owner: TestUser;
  let editor: TestUser;
  let viewer: TestUser;
  let project: { id: string };

  beforeEach(async () => {
    ctx = await createTestServer();
    owner = await signUp(ctx.app, 'Owner');
    editor = await signUp(ctx.app, 'Editor');
    viewer = await signUp(ctx.app, 'Viewer');
    project = await createProject(ctx.app, owner);
    for (const [user, role] of [
      [editor, 'editor'],
      [viewer, 'viewer'],
    ] as const) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/projects/${project.id}/collaborators`,
        headers: owner.auth,
        payload: { email: user.email, role },
      });
    }
  });
  afterEach(async () => {
    await ctx.close();
  });

  const post = (user: TestUser, payload: object) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/comments`,
      headers: user.auth,
      payload,
    });
  const patch = (user: TestUser, id: string, payload: object) =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${project.id}/comments/${id}`,
      headers: user.auth,
      payload,
    });
  const list = async (user: TestUser, query = '') => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/comments${query}`,
      headers: user.auth,
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ comments: CommentDto[] }>().comments;
  };

  it('creates threads and replies; replies to replies join the thread', async () => {
    const root = await post(viewer, { eventId: 'apollo', body: '  Is the date right?  ' });
    expect(root.statusCode).toBe(201);
    const thread = root.json<CommentDto>();
    expect(thread).toMatchObject({
      eventId: 'apollo',
      parentId: null,
      body: 'Is the date right?',
      author: { id: viewer.id, name: 'Viewer' },
      resolvedAt: null,
    });

    const reply = (
      await post(editor, { parentId: thread.id, body: 'Yes, 20 July.' })
    ).json<CommentDto>();
    expect(reply).toMatchObject({ eventId: 'apollo', parentId: thread.id });
    const nested = (await post(owner, { parentId: reply.id, body: 'Thanks!' })).json<CommentDto>();
    expect(nested.parentId).toBe(thread.id);

    await post(owner, { eventId: 'sputnik', body: 'Add a photo' });
    expect((await list(owner)).map((c) => c.body)).toEqual([
      'Is the date right?',
      'Yes, 20 July.',
      'Thanks!',
      'Add a photo',
    ]);
    expect(await list(owner, '?eventId=apollo')).toHaveLength(3);

    // A reply can't move to another event.
    expect(
      (await post(owner, { parentId: thread.id, eventId: 'sputnik', body: 'x' })).statusCode,
    ).toBe(400);
  });

  it('validates input and the event', async () => {
    expect((await post(owner, { eventId: 'apollo', body: '   ' })).statusCode).toBe(400);
    expect((await post(owner, { eventId: 'apollo', body: 'x'.repeat(5001) })).statusCode).toBe(400);
    expect((await post(owner, { body: 'no target' })).statusCode).toBe(400);
    expect((await post(owner, { eventId: 'nope', body: 'Hi' })).statusCode).toBe(404);
    const stranger = await signUp(ctx.app, 'Stranger');
    expect((await post(stranger, { eventId: 'apollo', body: 'Hi' })).statusCode).toBe(404);
  });

  it('enforces who may edit, resolve and delete', async () => {
    const thread = (await post(viewer, { eventId: 'apollo', body: 'Typo?' })).json<CommentDto>();
    const reply = (await post(editor, { parentId: thread.id, body: 'Fixed' })).json<CommentDto>();

    // Only the author edits the text.
    expect((await patch(editor, thread.id, { body: 'Hijacked' })).statusCode).toBe(403);
    const edited = await patch(viewer, thread.id, { body: 'Typo in the title?' });
    expect(edited.json<CommentDto>()).toMatchObject({ body: 'Typo in the title?' });
    expect(edited.json<CommentDto>().editedAt).not.toBeNull();

    // Replies are not resolved; threads are, by editors or the thread's author.
    expect((await patch(editor, reply.id, { resolved: true })).statusCode).toBe(400);
    const other = (
      await post(owner, { eventId: 'sputnik', body: 'Owner note' })
    ).json<CommentDto>();
    expect((await patch(viewer, other.id, { resolved: true })).statusCode).toBe(403);
    const resolved = await patch(editor, thread.id, { resolved: true });
    expect(resolved.json<CommentDto>()).toMatchObject({
      resolvedBy: { id: editor.id, name: 'Editor' },
    });
    expect(await list(owner, '?status=open')).toEqual([expect.objectContaining({ id: other.id })]);
    expect((await list(owner, '?status=resolved')).map((c) => c.id)).toEqual([thread.id, reply.id]);
    const reopened = await patch(viewer, thread.id, { resolved: false });
    expect(reopened.json<CommentDto>().resolvedAt).toBeNull();

    // Delete: own comments, or anything for the owner. Threads take their replies along.
    const del = (user: TestUser, id: string) =>
      ctx.app.inject({
        method: 'DELETE',
        url: `/api/v1/projects/${project.id}/comments/${id}`,
        headers: user.auth,
      });
    expect((await del(viewer, other.id)).statusCode).toBe(403);
    expect((await del(editor, reply.id)).statusCode).toBe(204);
    await post(editor, { parentId: thread.id, body: 'Another reply' });
    expect((await del(owner, thread.id)).statusCode).toBe(204);
    expect((await list(owner)).map((c) => c.id)).toEqual([other.id]);
  });

  it('accepts comments on events that only exist in the live document, and broadcasts', async () => {
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (ctx.app.server.address() as AddressInfo).port;
    const doc = new Y.Doc();
    const client = new CollabClient({
      url: `ws://127.0.0.1:${String(port)}/api/v1/projects/${project.id}/collab`,
      doc,
      getToken: () => Promise.resolve(editor.token),
      WebSocket: class extends WebSocket {
        constructor(url: string) {
          super(url, { headers: { origin: EDITOR_ORIGIN } });
        }
      } as unknown as WebSocketConstructor,
    });
    const messages: ServerControl[] = [];
    client.on('message', (m) => messages.push(m));
    try {
      client.connect();
      const until = async (check: () => boolean) => {
        for (let i = 0; i < 250 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(check()).toBe(true);
      };
      await until(() => client.synced);
      const t = readTimeline(doc);
      writeTimeline(doc, {
        ...t,
        events: [
          ...t.events,
          { id: 'brand-new', title: 'Just added', date: { start: '1970' }, media: [], tags: [] },
        ],
      });
      await until(() => !client.pending);

      const res = await post(viewer, { eventId: 'brand-new', body: 'Nice' });
      expect(res.statusCode).toBe(201);
      await until(() => messages.some((m) => m.type === 'comment'));
      expect(messages.find((m) => m.type === 'comment')).toMatchObject({
        type: 'comment',
        action: 'created',
        comment: { eventId: 'brand-new', body: 'Nice' },
      });
    } finally {
      client.destroy();
    }
  });
});
