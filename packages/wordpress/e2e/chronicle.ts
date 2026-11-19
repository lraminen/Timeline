/** Sets up data on the Chronicle server through its API. */
const API = 'http://127.0.0.1:3998/api/v1';

export const CHRONICLE_URL = 'http://127.0.0.1:3998';

export interface Account {
  token: string;
  apiKey: string;
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; apiKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.apiKey) headers['x-api-key'] = init.apiKey;
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok)
    throw new Error(`${init.method ?? 'GET'} ${path}: ${String(res.status)} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function createAccount(): Promise<Account> {
  const email = `wp-${String(Date.now())}-${String(Math.random()).slice(2, 8)}@example.org`;
  const { accessToken } = await call<{ accessToken: string }>('/auth/register', {
    method: 'POST',
    body: { email, name: 'WordPress Tester', password: 'correct horse battery staple' },
  });
  const { key } = await call<{ key: string }>('/api-keys', {
    method: 'POST',
    token: accessToken,
    body: { label: 'WordPress' },
  });
  return { token: accessToken, apiKey: key };
}

export interface Project {
  id: string;
  slug: string;
}

export function timeline(
  title: string,
  events: { title: string; start: string; tags?: string[]; body?: string }[],
) {
  return {
    schemaVersion: '1.0.0',
    id: 'x',
    title,
    events: events.map((e, i) => ({
      id: `e${String(i)}`,
      title: e.title,
      date: { start: e.start },
      body: e.body,
      media: [],
      tags: e.tags ?? [],
    })),
    eras: [],
    settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  };
}

export async function createProject(
  account: Account,
  doc: unknown,
  options: { publish: boolean; isPublic: boolean },
): Promise<Project> {
  const project = await call<Project>('/projects', {
    method: 'POST',
    token: account.token,
    body: { timeline: doc },
  });
  if (options.publish) {
    await call(`/projects/${project.id}/revisions`, {
      method: 'POST',
      token: account.token,
      body: {},
    });
  }
  if (options.isPublic) {
    await call(`/projects/${project.id}`, {
      method: 'PATCH',
      token: account.token,
      body: { isPublic: true },
    });
  }
  return project;
}

export async function events(account: Account, projectId: string) {
  const res = await call<{
    events: { id: string; title: string; body?: string; tags: string[] }[];
  }>(`/projects/${projectId}/events`, { apiKey: account.apiKey });
  return res.events;
}
