import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createProject,
  createTestServer,
  EDITOR_ORIGIN,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

let t: TestContext;
let owner: TestUser;

beforeAll(async () => {
  t = await createTestServer();
  owner = await signUp(t.app, 'Owner');
});
afterAll(async () => {
  await t.close();
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: owner.auth,
    ...(payload ? { payload } : {}),
  });

async function published(timeline?: unknown, isPublic = true) {
  const p = await createProject(t.app, owner, timeline);
  await api('POST', `/projects/${p.id}/revisions`, {});
  if (isPublic) await api('PATCH', `/projects/${p.id}`, { isPublic: true });
  return p;
}

describe('embed API', () => {
  it('serves the latest published version with CORS and short caching', async () => {
    const p = await published();
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/embed/${p.slug}`,
      headers: { origin: 'https://news.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['cache-control']).toContain('max-age=60');
    expect(res.json()).toMatchObject({ version: 1, timeline: { title: 'Space Race' } });

    const again = await t.app.inject({
      method: 'GET',
      url: `/api/v1/embed/${p.slug}`,
      headers: { 'if-none-match': '"v1"' },
    });
    expect(again.statusCode).toBe(304);
  });

  it('serves pinned versions immutably and keeps them after new publishes', async () => {
    const p = await published();
    await api('POST', `/projects/${p.id}/events`, { title: 'New', date: { start: '1990' } });
    await api('POST', `/projects/${p.id}/revisions`, {});

    const v1 = await t.app.inject({ method: 'GET', url: `/api/v1/embed/${p.slug}/v/1` });
    expect(v1.headers['cache-control']).toContain('immutable');
    expect(v1.json<{ timeline: { events: unknown[] } }>().timeline.events).toHaveLength(2);
    const latest = await t.app.inject({ method: 'GET', url: `/api/v1/embed/${p.slug}` });
    expect(latest.json<{ version: number }>().version).toBe(2);
  });

  it('hides private, unpublished and unknown timelines behind the same 404', async () => {
    const priv = await published(undefined, false);
    const unpublished = await createProject(t.app, owner);
    await api('PATCH', `/projects/${unpublished.id}`, { isPublic: true });

    const bodies = await Promise.all(
      [priv.slug, unpublished.slug, 'does-not-exist'].map((slug) =>
        t.app.inject({ method: 'GET', url: `/api/v1/embed/${slug}` }),
      ),
    );
    expect(bodies.map((b) => b.statusCode)).toEqual([404, 404, 404]);
    expect(new Set(bodies.map((b) => b.body)).size).toBe(1);
  });
});

describe('share links for private timelines', () => {
  it('grants access with a valid token, rejects tampering, and can be revoked', async () => {
    const p = await published(undefined, false);
    const link = (await api('POST', `/projects/${p.id}/share-links`, { expiresInHours: 1 })).json<{
      token: string;
      pageUrl: string;
    }>();
    expect(link.pageUrl).toContain(`/timeline/${p.slug}?token=`);

    const ok = await t.app.inject({
      method: 'GET',
      url: `/api/v1/embed/${p.slug}?token=${link.token}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');

    const [exp, sig] = link.token.split('.');
    const longer = `${String(Number(exp) + 86400)}.${sig}`;
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/embed/${p.slug}?token=${longer}` }))
        .statusCode,
    ).toBe(404);

    // A token for one project does not open another.
    const other = await published(undefined, false);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: `/api/v1/embed/${other.slug}?token=${link.token}`,
        })
      ).statusCode,
    ).toBe(404);

    expect((await api('DELETE', `/projects/${p.id}/share-links`)).statusCode).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/embed/${p.slug}?token=${link.token}` }))
        .statusCode,
    ).toBe(404);
  });

  it('rejects expired tokens', async () => {
    const p = await published(undefined, false);
    const { createShareToken } = await import('../services/share.js');
    const draft = (await api('GET', `/projects/${p.id}/draft`)).json<{ timeline: unknown }>();
    expect(draft).toBeDefined();
    const [project] = await t.database.db.query.projects.findMany({
      where: (pr, { eq }) => eq(pr.id, p.id),
    });
    if (!project) throw new Error('project missing');
    const expired = createShareToken(t.config, project, new Date(Date.now() - 1000));
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/v1/embed/${p.slug}?token=${expired}` }))
        .statusCode,
    ).toBe(404);
  });
});

describe('server-rendered timeline pages', () => {
  const hostile = {
    id: 'x',
    title: '</script><script>alert("title")</script>',
    description: 'A *safe* description with <img src=x onerror=alert(1)>',
    settings: { locale: 'en' },
    events: [
      {
        id: 'e1"><script>alert(1)</script>',
        date: { start: '1969-07-20' },
        title: '<b onmouseover=alert(1)>Moon</b>',
        body: 'Body with [bad link](javascript:alert(1)) and **bold**',
        tags: ['"><svg onload=alert(1)>'],
        media: [{ type: 'image', url: 'https://img.example/moon.jpg', alt: '" onerror="alert(1)' }],
        location: { lat: 0.67, lng: 23.47, label: 'Tranquility Base' },
      },
      { id: 'caesar', date: { start: '-0044-03-15' }, title: 'Ides of March' },
    ],
  };

  it('renders semantic content, metadata and structured data — all escaped', async () => {
    const p = await published(hostile);
    const res = await t.app.inject({ method: 'GET', url: `/timeline/${p.slug}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    const html = res.body;

    // No injected markup in the HTML. (The JSON data islands legitimately
    // contain the raw strings as inert data; they are checked separately.)
    const markup = html.replace(
      /<script type="application\/(?:ld\+)?json">[\s\S]*?<\/script>/g,
      '',
    );
    expect(markup).not.toMatch(
      /<script>alert|<b onmouseover|<svg onload|<img src=x|javascript:alert|onerror="alert/,
    );
    // Escaped title in <title> and <h1>.
    expect(html).toContain(
      '<title>&lt;/script&gt;&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;</title>',
    );
    // The JSON data island cannot close its <script> element.
    const island = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(island).not.toContain('</script');
    expect(JSON.parse(island)).toMatchObject({ title: hostile.title });

    // Markdown rendered safely; BCE date formatted; machine-readable dates only for CE.
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<time datetime="1969-07-20">');
    expect(html).toContain('44 BCE');

    // Open Graph / Twitter / canonical.
    expect(html).toContain('<meta property="og:image" content="https://img.example/moon.jpg">');
    expect(html).toContain(
      `<link rel="canonical" href="http://chronicle.test/timeline/${p.slug}">`,
    );
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');

    // JSON-LD parses and describes the events.
    const ld = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}',
    ) as {
      '@type': string;
      itemListElement: {
        item: { name: string; startDate?: string; location?: { geo: { latitude: number } } };
      }[];
    };
    expect(ld['@type']).toBe('ItemList');
    const [caesar, moon] = ld.itemListElement.map((i) => i.item);
    expect(caesar?.startDate).toBeUndefined(); // BCE cannot be an ISO date
    expect(moon?.startDate).toBe('1969-07-20');
    expect(moon?.location?.geo.latitude).toBe(0.67);
  });

  it('sends a strict CSP, allows framing by embedders, and loads only hashed assets', async () => {
    const p = await published();
    const res = await t.app.inject({ method: 'GET', url: `/timeline/${p.slug}` });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain('frame-ancestors *');
    expect(res.headers['x-frame-options']).toBeUndefined();

    const scriptSrc = /<script src="([^"]+)"/.exec(res.body)?.[1] ?? '';
    expect(scriptSrc).toMatch(/^\/assets\/chronicle-timeline\.[0-9a-f]{12}\.js$/);
    const asset = await t.app.inject({ method: 'GET', url: scriptSrc });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    expect(asset.body).toContain('chronicle-timeline');
  });

  it('marks share-link pages noindex and uncached; unknown pages get a friendly 404', async () => {
    const p = await published(undefined, false);
    const { token } = (await api('POST', `/projects/${p.id}/share-links`, {})).json<{
      token: string;
    }>();
    const res = await t.app.inject({ method: 'GET', url: `/timeline/${p.slug}?token=${token}` });
    expect(res.body).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(res.headers['cache-control']).toBe('private, no-store');

    const missing = await t.app.inject({ method: 'GET', url: '/timeline/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('Timeline not found');
  });
});

describe('CORS and security headers', () => {
  it('allows the editor origin with credentials on the API, and nobody else', async () => {
    const pre = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/projects',
      headers: { origin: EDITOR_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(pre.headers['access-control-allow-origin']).toBe(EDITOR_ORIGIN);
    expect(pre.headers['access-control-allow-credentials']).toBe('true');

    const evil = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/projects',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets defensive headers on API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json()).toEqual({ status: 'ok', database: 'pglite' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('never leaks internals in error responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});
