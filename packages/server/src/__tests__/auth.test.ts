import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, users } from '../db/schema.js';
import {
  createTestServer,
  EDITOR_ORIGIN,
  refreshCookieOf,
  signUp,
  type TestContext,
} from '../test/harness.js';

let t: TestContext;
beforeAll(async () => {
  t = await createTestServer();
});
afterAll(async () => {
  await t.close();
});

const refresh = (cookie: string, origin?: string) =>
  t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    cookies: { chronicle_refresh: cookie },
    headers: origin ? { origin } : {},
  });

describe('registration and login', () => {
  it('registers, hashes the password with Argon2id, and returns a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'Ada@Example.com ', name: 'Ada', password: 'analytical engine' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ accessToken: string; user: { email: string } }>();
    expect(body.user.email).toBe('ada@example.com');
    expect(body.accessToken.split('.')).toHaveLength(3);

    const cookie = res.cookies.find((c) => c.name === 'chronicle_refresh');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });

    const [row] = await t.database.db
      .select()
      .from(users)
      .where(eq(users.email, 'ada@example.com'));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects duplicate emails and weak input', async () => {
    const dup = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'ada@example.com', name: 'Again', password: 'another long password' },
    });
    expect(dup.statusCode).toBe(409);

    const weak = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'not-an-email', name: '', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(
      weak.json<{ error: { details: { path: string }[] } }>().error.details.map((d) => d.path),
    ).toEqual(expect.arrayContaining(['email', 'name', 'password']));
  });

  it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ADA@example.com', password: 'analytical engine' },
    });
    expect(ok.statusCode).toBe(200);

    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ada@example.com', password: 'nope nope nope' },
    });
    const unknown = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'nope nope nope' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());

    const failures = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.login_failed'));
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});

describe('access tokens', () => {
  it('authenticates /me and rejects missing, malformed and forged tokens', async () => {
    const user = await signUp(t.app);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: user.auth });
    expect(me.json()).toMatchObject({ id: user.id, authenticatedVia: 'session' });

    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: 'Bearer garbage' },
        })
      ).statusCode,
    ).toBe(401);

    // Same token with a tampered payload (different subject) must fail.
    const [h, , s] = user.token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'someone-else' })).toString(
      'base64url',
    );
    const forged = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${h}.${forgedPayload}.${s}` },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('expires access tokens', async () => {
    const short = await createTestServer({ ACCESS_TOKEN_TTL_SECONDS: '1' });
    try {
      const user = await signUp(short.app);
      await new Promise((r) => setTimeout(r, 2100));
      const res = await short.app.inject({ method: 'GET', url: '/api/v1/me', headers: user.auth });
      expect(res.statusCode).toBe(401);
    } finally {
      await short.close();
    }
  });
});

describe('refresh tokens', () => {
  it('rotates on every use', async () => {
    const user = await signUp(t.app);
    const first = await refresh(user.refreshCookie, EDITOR_ORIGIN);
    expect(first.statusCode).toBe(200);
    const next = refreshCookieOf(first);
    expect(next).not.toBe(user.refreshCookie);
    expect((await refresh(next)).statusCode).toBe(200);
  });

  it('detects reuse of a rotated token and revokes the whole session family', async () => {
    const user = await signUp(t.app);
    const rotated = refreshCookieOf(await refresh(user.refreshCookie));

    // Attacker replays the old token → rejected and the family is revoked…
    const replay = await refresh(user.refreshCookie);
    expect(replay.statusCode).toBe(401);
    // …so even the legitimate latest token stops working.
    expect((await refresh(rotated)).statusCode).toBe(401);

    const events = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'auth.refresh_reuse_detected'));
    expect(events.some((e) => e.actorId === user.id)).toBe(true);
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const user = await signUp(t.app);
    const results = await Promise.all([refresh(user.refreshCookie), refresh(user.refreshCookie)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('rejects cross-origin refresh requests (CSRF)', async () => {
    const user = await signUp(t.app);
    expect((await refresh(user.refreshCookie, 'https://evil.example')).statusCode).toBe(403);
  });

  it('logout revokes the session', async () => {
    const user = await signUp(t.app);
    const out = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { chronicle_refresh: user.refreshCookie },
    });
    expect(out.statusCode).toBe(204);
    expect((await refresh(user.refreshCookie)).statusCode).toBe(401);
  });
});

describe('rate limiting', () => {
  it('limits login attempts per IP', async () => {
    const limited = await createTestServer({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await limited.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'x@example.com', password: 'whatever whatever' },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('API keys', () => {
  it('creates a key shown once, authenticates with it, and revokes it', async () => {
    const user = await signUp(t.app);
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: user.auth,
      payload: { label: 'CI' },
    });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json<{ key: string; id: string }>();
    expect(key).toMatch(/^chr_[A-Za-z0-9]{12}_/);

    const listed = await t.app.inject({
      method: 'GET',
      url: '/api/v1/api-keys',
      headers: user.auth,
    });
    // The secret is base64url and may itself contain "_", so slice rather than split.
    const secret = key.slice('chr_'.length + 12 + 1);
    expect(secret).toHaveLength(43);
    expect(JSON.stringify(listed.json())).not.toContain(secret);

    const viaKey = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-api-key': key },
    });
    expect(viaKey.json()).toMatchObject({ id: user.id, authenticatedVia: 'api_key' });
    const viaBearer = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(viaBearer.statusCode).toBe(200);

    // A key cannot mint more keys.
    const escalate = await t.app.inject({
      method: 'POST',
      url: '/api/v1/api-keys',
      headers: { 'x-api-key': key },
      payload: { label: 'x' },
    });
    expect(escalate.statusCode).toBe(403);

    await t.app.inject({ method: 'DELETE', url: `/api/v1/api-keys/${id}`, headers: user.auth });
    const revoked = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { 'x-api-key': key },
    });
    expect(revoked.statusCode).toBe(401);
  });
});
