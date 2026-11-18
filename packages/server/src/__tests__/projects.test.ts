import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog } from '../db/schema.js';
import {
  createProject,
  createTestServer,
  sampleTimeline,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

let t: TestContext;
let owner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  t = await createTestServer();
  [owner, editor, viewer, stranger] = await Promise.all([
    signUp(t.app, 'Owner'),
    signUp(t.app, 'Editor'),
    signUp(t.app, 'Viewer'),
    signUp(t.app, 'Stranger'),
  ]);
});
afterAll(async () => {
  await t.close();
});

const req = (
  user: TestUser | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...(user ? user.auth : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

async function shareWithTeam(projectId: string) {
  await req(owner, 'POST', `/projects/${projectId}/collaborators`, {
    email: editor.email,
    role: 'editor',
  });
  await req(owner, 'POST', `/projects/${projectId}/collaborators`, {
    email: viewer.email,
    role: 'viewer',
  });
}

describe('projects', () => {
  it('creates from a timeline document, validating it and owning the id', async () => {
    const project = await createProject(t.app, owner);
    const draft = await req(owner, 'GET', `/projects/${project.id}/draft`);
    expect(draft.headers.etag).toBe('"1"');
    const body = draft.json<{ timeline: { id: string; title: string; events: unknown[] } }>();
    expect(body.timeline.id).toBe(project.id);
    expect(body.timeline.events).toHaveLength(2);
    expect(project.slug).toMatch(/^space-race-[a-z0-9]{6}$/);
  });

  it('rejects invalid documents with the schema problems listed', async () => {
    const res = await req(owner, 'POST', '/projects', {
      timeline: {
        id: 'x',
        title: 'Bad',
        events: [{ id: 'a', title: '', date: { start: '2000' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { details: { path: string }[] } }>().error.details[0]?.path).toBe(
      'events.0.title',
    );
  });

  it('rejects unsafe media URLs at the API boundary', async () => {
    const res = await req(owner, 'POST', '/projects', {
      timeline: {
        id: 'x',
        title: 'XSS',
        events: [
          {
            id: 'a',
            title: 'A',
            date: { start: '2000' },
            media: [{ type: 'oembed', url: 'javascript:alert(1)' }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lists only projects the user can access, with their role', async () => {
    const mine = await createProject(t.app, owner, sampleTimeline('Listed'));
    await shareWithTeam(mine.id);
    const list = (u: TestUser) =>
      req(u, 'GET', '/projects').then(
        (r) => r.json<{ projects: { id: string; role: string }[] }>().projects,
      );

    expect((await list(owner)).find((p) => p.id === mine.id)?.role).toBe('owner');
    expect((await list(editor)).find((p) => p.id === mine.id)?.role).toBe('editor');
    expect((await list(viewer)).find((p) => p.id === mine.id)?.role).toBe('viewer');
    expect((await list(stranger)).some((p) => p.id === mine.id)).toBe(false);
  });

  it('hides projects from strangers with 404 and enforces role levels', async () => {
    const p = await createProject(t.app, owner);
    await shareWithTeam(p.id);

    expect((await req(stranger, 'GET', `/projects/${p.id}`)).statusCode).toBe(404);
    expect((await req(null, 'GET', `/projects/${p.id}`)).statusCode).toBe(401);
    expect((await req(viewer, 'GET', `/projects/${p.id}/draft`)).statusCode).toBe(200);
    expect(
      (
        await req(viewer, 'POST', `/projects/${p.id}/events`, {
          title: 'X',
          date: { start: '2000' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await req(editor, 'PATCH', `/projects/${p.id}`, { isPublic: true })).statusCode).toBe(
      403,
    );
    expect((await req(editor, 'DELETE', `/projects/${p.id}`)).statusCode).toBe(403);
    expect((await req(owner, 'PATCH', `/projects/${p.id}`, { isPublic: true })).statusCode).toBe(
      200,
    );
  });

  it('rejects malformed ids with 400 instead of a database error', async () => {
    expect((await req(owner, 'GET', '/projects/not-a-uuid')).statusCode).toBe(400);
  });

  it('enforces unique slugs and audits visibility changes', async () => {
    const a = await createProject(t.app, owner);
    const b = await createProject(t.app, owner);
    expect((await req(owner, 'PATCH', `/projects/${b.id}`, { slug: a.slug })).statusCode).toBe(409);
    expect((await req(owner, 'PATCH', `/projects/${b.id}`, { slug: 'Bad Slug!' })).statusCode).toBe(
      400,
    );
    await req(owner, 'PATCH', `/projects/${b.id}`, { isPublic: true });
    const audits = await t.database.db.select().from(auditLog).where(eq(auditLog.projectId, b.id));
    expect(audits.map((a) => a.action)).toContain('project.visibility_change');
  });

  it('deletes a project (owner only)', async () => {
    const p = await createProject(t.app, owner);
    expect((await req(owner, 'DELETE', `/projects/${p.id}`)).statusCode).toBe(204);
    expect((await req(owner, 'GET', `/projects/${p.id}`)).statusCode).toBe(404);
  });
});

describe('drafts — optimistic concurrency', () => {
  it('requires If-Match, saves with it, and returns 412 with the server copy on conflict', async () => {
    const p = await createProject(t.app, owner);
    await shareWithTeam(p.id);
    const doc = (await req(owner, 'GET', `/projects/${p.id}/draft`)).json<{
      timeline: Record<string, unknown>;
    }>().timeline;

    expect((await req(owner, 'PUT', `/projects/${p.id}/draft`, { timeline: doc })).statusCode).toBe(
      428,
    );

    const first = await req(
      owner,
      'PUT',
      `/projects/${p.id}/draft`,
      { timeline: { ...doc, title: 'Owner edit' } },
      { 'if-match': '"1"' },
    );
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"2"');

    // The editor still holds version 1 → conflict, with the current copy.
    const stale = await req(
      editor,
      'PUT',
      `/projects/${p.id}/draft`,
      { timeline: { ...doc, title: 'Editor edit' } },
      { 'if-match': '"1"' },
    );
    expect(stale.statusCode).toBe(412);
    const conflict = stale.json<{
      error: { code: string; details: { draftVersion: number; draft: { title: string } } };
    }>();
    expect(conflict.error.code).toBe('draft_conflict');
    expect(conflict.error.details.draftVersion).toBe(2);
    expect(conflict.error.details.draft.title).toBe('Owner edit');

    const project = (await req(owner, 'GET', `/projects/${p.id}`)).json<{ title: string }>();
    expect(project.title).toBe('Owner edit');
  });

  it('lets exactly one of two concurrent writers at the same version win', async () => {
    const p = await createProject(t.app, owner);
    const doc = (await req(owner, 'GET', `/projects/${p.id}/draft`)).json<{
      timeline: Record<string, unknown>;
    }>().timeline;
    const results = await Promise.all(
      ['A', 'B'].map((title) =>
        req(
          owner,
          'PUT',
          `/projects/${p.id}/draft`,
          { timeline: { ...doc, title } },
          { 'if-match': '"1"' },
        ),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 412]);
  });
});

describe('events sub-resource', () => {
  it('creates, reads, patches and deletes events, validating each change', async () => {
    const p = await createProject(t.app, owner);
    const created = await req(owner, 'POST', `/projects/${p.id}/events`, {
      title: 'Vostok 1',
      date: { start: '1961-04-12' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    expect((await req(owner, 'GET', `/projects/${p.id}/events/${id}`)).json()).toMatchObject({
      title: 'Vostok 1',
      tags: [],
    });

    const patched = await req(owner, 'PATCH', `/projects/${p.id}/events/${id}`, {
      title: 'Vostok 1 (Gagarin)',
      tags: ['ussr'],
    });
    expect(patched.json()).toMatchObject({ title: 'Vostok 1 (Gagarin)', tags: ['ussr'] });

    expect(
      (await req(owner, 'PATCH', `/projects/${p.id}/events/${id}`, { title: '' })).statusCode,
    ).toBe(400);
    expect(
      (await req(owner, 'PATCH', `/projects/${p.id}/events/${id}`, { id: 'other' })).statusCode,
    ).toBe(403);
    expect(
      (
        await req(owner, 'POST', `/projects/${p.id}/events`, {
          id: 'sputnik',
          title: 'Dup',
          date: { start: '2000' },
        })
      ).statusCode,
    ).toBe(409);

    expect((await req(owner, 'DELETE', `/projects/${p.id}/events/${id}`)).statusCode).toBe(204);
    expect((await req(owner, 'GET', `/projects/${p.id}/events/${id}`)).statusCode).toBe(404);

    const events = (await req(owner, 'GET', `/projects/${p.id}/events`)).json<{
      events: unknown[];
      draftVersion: number;
    }>();
    expect(events.events).toHaveLength(2);
    expect(events.draftVersion).toBe(4);
  });

  it('applies concurrent event additions without losing any', async () => {
    const p = await createProject(t.app, owner);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        req(owner, 'POST', `/projects/${p.id}/events`, {
          title: `E${String(i)}`,
          date: { start: '2000' },
        }),
      ),
    );
    const events = (await req(owner, 'GET', `/projects/${p.id}/events`)).json<{
      events: unknown[];
    }>().events;
    expect(events).toHaveLength(7);
  });
});

describe('revisions — publish and rollback', () => {
  it('publishes snapshots, lists history, and rolls back by republishing', async () => {
    const p = await createProject(t.app, owner);
    await shareWithTeam(p.id);

    const v1 = await req(editor, 'POST', `/projects/${p.id}/revisions`, {
      message: 'First publish',
    });
    expect(v1.json()).toMatchObject({ version: 1 });

    const doc = (await req(owner, 'GET', `/projects/${p.id}/draft`)).json<{
      timeline: Record<string, unknown>;
    }>().timeline;
    await req(
      owner,
      'PUT',
      `/projects/${p.id}/draft`,
      { timeline: { ...doc, title: 'Changed' } },
      { 'if-match': '"1"' },
    );
    expect((await req(owner, 'POST', `/projects/${p.id}/revisions`, {})).json()).toMatchObject({
      version: 2,
    });

    expect((await req(viewer, 'POST', `/projects/${p.id}/revisions`, {})).statusCode).toBe(403);

    const rollback = await req(owner, 'POST', `/projects/${p.id}/rollback/1`);
    expect(rollback.json()).toMatchObject({ version: 3 });

    const history = (await req(viewer, 'GET', `/projects/${p.id}/revisions`)).json<{
      revisions: { version: number; message: string | null; author: { name: string } }[];
    }>();
    expect(history.revisions.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(history.revisions[0]?.message).toBe('Rollback to version 1');
    expect(history.revisions[2]?.author.name).toBe('Editor');

    const v3 = (await req(viewer, 'GET', `/projects/${p.id}/revisions/3`)).json<{
      timeline: { title: string };
    }>();
    expect(v3.timeline.title).toBe('Space Race');
    const draft = (await req(owner, 'GET', `/projects/${p.id}/draft`)).json<{
      timeline: { title: string };
    }>();
    expect(draft.timeline.title).toBe('Space Race');
    expect((await req(owner, 'GET', `/projects/${p.id}/revisions/99`)).statusCode).toBe(404);
  });

  it('numbers concurrent publishes uniquely', async () => {
    const p = await createProject(t.app, owner);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => req(owner, 'POST', `/projects/${p.id}/revisions`, {})),
    );
    expect(results.map((r) => r.json<{ version: number }>().version).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('collaborators', () => {
  it('adds, changes, lists and removes collaborators; members can leave', async () => {
    const p = await createProject(t.app, owner);
    const add = await req(owner, 'POST', `/projects/${p.id}/collaborators`, {
      email: editor.email.toUpperCase(),
      role: 'viewer',
    });
    expect(add.statusCode).toBe(201);
    expect(
      (
        await req(owner, 'POST', `/projects/${p.id}/collaborators`, {
          email: editor.email,
          role: 'editor',
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await req(owner, 'POST', `/projects/${p.id}/collaborators`, {
          email: 'nobody@example.com',
          role: 'editor',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await req(editor, 'POST', `/projects/${p.id}/collaborators`, {
          email: viewer.email,
          role: 'editor',
        })
      ).statusCode,
    ).toBe(403);

    await req(owner, 'PATCH', `/projects/${p.id}/collaborators/${editor.id}`, { role: 'editor' });
    const list = (await req(editor, 'GET', `/projects/${p.id}/collaborators`)).json<{
      collaborators: { role: string }[];
    }>();
    expect(list.collaborators.map((c) => c.role)).toEqual(['owner', 'editor']);

    expect(
      (await req(editor, 'DELETE', `/projects/${p.id}/collaborators/${editor.id}`)).statusCode,
    ).toBe(204);
    expect((await req(editor, 'GET', `/projects/${p.id}`)).statusCode).toBe(404);
  });
});

describe('audit trail', () => {
  it('lets owners read their project’s audit log (and nobody else)', async () => {
    const p = await createProject(t.app, owner);
    await shareWithTeam(p.id);
    await req(owner, 'PATCH', `/projects/${p.id}`, { isPublic: true });
    await req(editor, 'POST', `/projects/${p.id}/revisions`, {});

    const res = await req(owner, 'GET', `/projects/${p.id}/audit`);
    const actions = res.json<{ entries: { action: string; actor: { name: string } | null }[] }>()
      .entries;
    expect(actions.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'project.create',
        'collaborator.add',
        'project.visibility_change',
        'project.publish',
      ]),
    );
    expect(actions.find((e) => e.action === 'project.publish')?.actor?.name).toBe('Editor');
    expect((await req(editor, 'GET', `/projects/${p.id}/audit`)).statusCode).toBe(403);
  });
});
