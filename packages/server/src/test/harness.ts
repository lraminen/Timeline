import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp, type AppOptions } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { openDatabase, type Database } from '../db/client.js';
import { FsStorage } from '../media/storage.js';

export const EDITOR_ORIGIN = 'http://editor.test';
export const PUBLIC_URL = 'http://chronicle.test';

export interface TestContext {
  app: FastifyInstance;
  config: Config;
  database: Database;
  storageDir: string;
  close: () => Promise<void>;
}

/**
 * A fully wired server on a fresh in-memory PGlite database (with the real
 * migrations applied) and a temporary storage directory.
 */
export async function createTestServer(
  env: Record<string, string> = {},
  overrides: Partial<Omit<AppOptions, 'config' | 'database'>> = {},
): Promise<TestContext> {
  const storageDir = mkdtempSync(path.join(tmpdir(), 'chronicle-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_URL,
    CORS_ORIGINS: EDITOR_ORIGIN,
    STORAGE_DIR: storageDir,
    AUTH_RATE_LIMIT_PER_MINUTE: '1000',
    ...env,
  });
  const database = await openDatabase(config);
  await database.migrate();
  const app = await buildApp({
    config,
    database,
    storage: new FsStorage(storageDir),
    logger: false,
    ...overrides,
  });
  await app.ready();
  return {
    app,
    config,
    database,
    storageDir,
    close: async () => {
      await app.close();
      await database.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  refreshCookie: string;
  auth: { authorization: string };
}

let counter = 0;

export async function signUp(app: FastifyInstance, name = 'Test User'): Promise<TestUser> {
  const email = `user${String(++counter)}-${String(Date.now())}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, name, password: 'correct horse battery' },
  });
  if (res.statusCode !== 201) throw new Error(`signUp failed: ${res.body}`);
  const body = res.json<{ accessToken: string; user: { id: string } }>();
  return {
    id: body.user.id,
    email,
    token: body.accessToken,
    refreshCookie: refreshCookieOf(res),
    auth: { authorization: `Bearer ${body.accessToken}` },
  };
}

export function refreshCookieOf(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'chronicle_refresh');
  if (!cookie) throw new Error('no refresh cookie set');
  return cookie.value;
}

export const sampleTimeline = (title = 'Space Race') => ({
  id: 'ignored',
  title,
  events: [
    {
      id: 'sputnik',
      date: { start: '1957-10-04' },
      title: 'Sputnik 1',
      body: 'First **satellite**.',
      tags: ['ussr'],
    },
    { id: 'apollo', date: { start: '1969-07-20' }, title: 'Apollo 11', tags: ['usa'] },
  ],
});

export async function createProject(
  app: FastifyInstance,
  user: TestUser,
  timeline: unknown = sampleTimeline(),
): Promise<{ id: string; slug: string; draftVersion: number }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: user.auth,
    payload: { timeline },
  });
  if (res.statusCode !== 201) throw new Error(`createProject failed: ${res.body}`);
  return res.json();
}
