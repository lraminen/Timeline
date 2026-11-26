import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';
import {
  createProject,
  createTestServer,
  sampleTimeline,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

async function uploadImage(ctx: TestContext, user: TestUser, projectId: string): Promise<string> {
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#36c' } })
    .png()
    .toBuffer();
  const boundary = '----chronicleexport';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/media`,
    headers: { ...user.auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ url: string }>().url;
}

const unzip = (body: Buffer) => {
  const entries = unzipSync(new Uint8Array(body));
  return {
    names: Object.keys(entries),
    text: (name: string) => strFromU8(entries[name] ?? new Uint8Array()),
  };
};

describe('static site export', () => {
  let ctx: TestContext;
  let owner: TestUser;

  beforeEach(async () => {
    ctx = await createTestServer({ MEDIA_PROXY_HOSTS: 'images.example' });
    owner = await signUp(ctx.app, 'Owner');
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('exports the draft with its uploaded media, and published versions', async () => {
    const project = await createProject(ctx.app, owner);
    const own = await uploadImage(ctx, owner, project.id);
    // Another project's upload is never read through this project's export.
    const other = await createProject(ctx.app, owner, sampleTimeline('Other'));
    const foreign = await uploadImage(ctx, owner, other.id);

    const draft = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/draft`,
      headers: owner.auth,
    });
    const timeline = draft.json<{ timeline: ReturnType<typeof sampleTimeline> }>().timeline;
    const events = timeline.events.map((e, i) =>
      i === 0
        ? {
            ...e,
            media: [
              { type: 'image', url: own, alt: 'Ours' },
              {
                type: 'image',
                url: foreign
                  .replace(other.id, project.id)
                  .replace(/media\/[^/]+/, 'media/00000000-0000-4000-8000-000000000000'),
                alt: 'Guessed key',
              },
              { type: 'image', url: 'https://elsewhere.example/x.png', alt: 'Not allowlisted' },
            ],
          }
        : e,
    );
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${project.id}/draft`,
      headers: {
        ...owner.auth,
        'if-match': `"${String(draft.json<{ draftVersion: number }>().draftVersion)}"`,
      },
      payload: { timeline: { ...timeline, events } },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip`,
      headers: owner.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="space-race.zip"');
    const zip = unzip(res.rawPayload);
    expect(zip.names).toEqual(
      expect.arrayContaining([
        'space-race/index.html',
        'space-race/timeline.json',
        'space-race/assets/chronicle-timeline.js',
        'space-race/manifest.json',
      ]),
    );
    expect(zip.names.filter((n) => n.includes('/media/'))).toHaveLength(1);
    const manifest = JSON.parse(zip.text('space-race/manifest.json')) as {
      media: { url: string; status: string; reason?: string }[];
    };
    expect(manifest.media.map((m) => m.status)).toEqual(['included', 'failed', 'failed']);
    expect(manifest.media[2]?.reason).toContain('allowlisted');

    // A published version.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/revisions`,
      headers: owner.auth,
      payload: {},
    });
    const v1 = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip?version=1`,
      headers: owner.auth,
    });
    expect(v1.statusCode).toBe(200);
    expect(v1.headers['content-disposition']).toContain('space-race-v1.zip');
    expect(unzip(v1.rawPayload).text('space-race-v1/index.html')).toContain('version 1');
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip?version=9`,
      headers: owner.auth,
    });
    expect(missing.statusCode).toBe(404);

    // Audited.
    const log = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/audit`,
      headers: owner.auth,
    });
    expect(
      log
        .json<{ entries: { action: string }[] }>()
        .entries.filter((e) => e.action === 'project.export'),
    ).toHaveLength(2);
  });

  it('copies allowlisted external images over https only', async () => {
    await ctx.close();
    const requested: string[] = [];
    ctx = await createTestServer(
      { MEDIA_PROXY_HOSTS: 'images.example' },
      {
        fetch: (input: string | URL | Request) => {
          requested.push(input instanceof Request ? input.url : input.toString());
          return Promise.resolve(
            new Response(new Uint8Array([0xff, 0xd8, 0xff, 0]), {
              headers: { 'content-type': 'image/jpeg' },
            }),
          );
        },
      },
    );
    owner = await signUp(ctx.app, 'Owner');
    const t = sampleTimeline();
    const project = await createProject(ctx.app, owner, {
      ...t,
      events: [
        {
          ...t.events[0],
          media: [
            { type: 'image', url: 'https://images.example/a.jpg', alt: 'a' },
            { type: 'image', url: 'http://images.example/b.jpg', alt: 'b' },
          ],
        },
      ],
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip`,
      headers: owner.auth,
    });
    expect(res.statusCode).toBe(200);
    expect(requested).toEqual(['https://images.example/a.jpg']);
  });

  it('is only for project members', async () => {
    const project = await createProject(ctx.app, owner);
    const stranger = await signUp(ctx.app, 'Stranger');
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip`,
      headers: stranger.auth,
    });
    expect(res.statusCode).toBe(404);
    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/export.zip`,
    });
    expect(anon.statusCode).toBe(401);
  });
});
