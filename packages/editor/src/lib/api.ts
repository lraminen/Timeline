import type { Timeline } from '@chronicle/schema';
import type {
  AltTextSuggestion,
  ConflictDetectionResult,
  DateNormalizationResult,
  ExtractionResult,
  SummarySuggestion,
} from '@chronicle/ai';
import type { CommentDto } from '@chronicle/collab';

/**
 * Client for the Chronicle server API.
 *
 * Session model: a short-lived access token kept only in memory, plus a
 * refresh token in an httpOnly cookie the browser sends to /auth/refresh.
 * On a 401 the client refreshes once and retries.
 */

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  slug: string;
  role: 'owner' | 'editor' | 'viewer';
  isPublic: boolean;
  draftVersion: number;
  publishedVersion: number | null;
  eventCount: number;
  updatedAt: string;
}

/** An API key as listed; the secret itself is only returned once, on creation. */
export interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface UploadedMedia {
  id: string;
  url: string;
  kind: 'image' | 'video' | 'audio';
  mimeType: string;
  width?: number;
  height?: number;
}

export interface AiStatus {
  configured: boolean;
  provider: string | null;
  model: string | null;
  supportsVision: boolean;
  usageToday: {
    requests: number;
    tokens: number;
    estimatedCostUsd: number;
  };
  limits: {
    dailyRequests: number;
    dailyTokens: number;
  };
}

export type WebhookEventType =
  | 'timeline.published'
  | 'draft.updated'
  | 'comment.created'
  | 'comment.updated'
  | 'comment.deleted';

export interface Webhook {
  id: string;
  url: string;
  description: string;
  events: WebhookEventType[];
  active: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
  createdAt: string;
}

export interface WebhookDelivery {
  id: string;
  eventType: string;
  status: 'pending' | 'delivering' | 'succeeded' | 'failed';
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

/** Result of an HTTP sync round (Yjs data base64-encoded). */
export interface CollabSyncResult {
  role: 'owner' | 'editor' | 'viewer';
  update: string;
  stateVector: string;
  draftVersion: number;
  problems: { path: string; message: string }[];
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Thrown on 412: someone else saved first. Carries the server's copy. */
export class DraftConflict extends Error {
  constructor(
    readonly serverVersion: number,
    readonly serverDraft: Timeline,
    readonly serverUpdatedAt: string,
  ) {
    super('The draft changed on the server');
    this.name = 'DraftConflict';
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ChronicleApi {
  private accessToken: string | null = null;
  private refreshing: Promise<User | null> | null = null;

  constructor(readonly baseUrl: string) {}

  get origin(): string {
    return this.baseUrl.replace(/\/$/, '');
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.accessToken) headers.set('authorization', `Bearer ${this.accessToken}`);
    return fetch(`${this.origin}/api/v1${path}`, { ...init, headers, credentials: 'include' });
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    let res: Response;
    try {
      res = await this.raw(path, init);
    } catch {
      throw new ApiRequestError(0, 'network', 'Can’t reach the Chronicle server');
    }
    if (res.status === 401 && retry && !path.startsWith('/auth/')) {
      if (await this.refresh()) return this.request<T>(path, init, false);
    }
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => ({}))) as ErrorBody & T;
    if (!res.ok) {
      throw new ApiRequestError(
        res.status,
        body.error?.code ?? 'error',
        body.error?.message ?? `Request failed (${String(res.status)})`,
        body.error?.details,
      );
    }
    return body;
  }

  private json(method: string, body?: unknown, headers: Record<string, string> = {}): RequestInit {
    return {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
  }

  // --- Session ----------------------------------------------------------

  /**
   * A current access token for the collaboration socket (which can't use the
   * cookie): refreshed first when it is missing or about to expire.
   */
  async getAccessToken(): Promise<string | null> {
    const exp = this.accessToken ? tokenExpiry(this.accessToken) : 0;
    if (!this.accessToken || exp - Date.now() < 60_000) {
      if (!(await this.refresh())) return null;
    }
    return this.accessToken;
  }

  /** Restores a session from the refresh cookie; `null` when signed out. */
  refresh(): Promise<User | null> {
    this.refreshing ??= (async () => {
      try {
        const res = await this.raw('/auth/refresh', { method: 'POST' });
        if (!res.ok) {
          this.accessToken = null;
          return null;
        }
        const body = (await res.json()) as { accessToken: string; user: User };
        this.accessToken = body.accessToken;
        return body.user;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async login(email: string, password: string): Promise<User> {
    const body = await this.request<{ accessToken: string; user: User }>(
      '/auth/login',
      this.json('POST', { email, password }),
    );
    this.accessToken = body.accessToken;
    return body.user;
  }

  async register(email: string, name: string, password: string): Promise<User> {
    const body = await this.request<{ accessToken: string; user: User }>(
      '/auth/register',
      this.json('POST', { email, name, password }),
    );
    this.accessToken = body.accessToken;
    return body.user;
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' }).catch(() => undefined);
    this.accessToken = null;
  }

  // --- Projects ---------------------------------------------------------

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.request<{ projects: ProjectSummary[] }>('/projects')).projects;
  }

  createProject(timeline: Timeline): Promise<ProjectSummary> {
    return this.request('/projects', this.json('POST', { timeline }));
  }

  getProject(id: string): Promise<ProjectSummary> {
    return this.request(`/projects/${id}`);
  }

  getDraft(id: string): Promise<{ draftVersion: number; timeline: Timeline }> {
    return this.request(`/projects/${id}/draft`);
  }

  /** Saves the draft if the server is still at `baseVersion`; throws DraftConflict otherwise. */
  async saveDraft(id: string, timeline: Timeline, baseVersion: number): Promise<number> {
    try {
      const res = await this.request<{ draftVersion: number }>(
        `/projects/${id}/draft`,
        this.json('PUT', { timeline }, { 'if-match': `"${String(baseVersion)}"` }),
      );
      return res.draftVersion;
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 412) {
        const d = err.details as { draftVersion: number; draft: Timeline; updatedAt: string };
        throw new DraftConflict(d.draftVersion, d.draft, d.updatedAt);
      }
      throw err;
    }
  }

  setVisibility(id: string, isPublic: boolean): Promise<ProjectSummary> {
    return this.request(`/projects/${id}`, this.json('PATCH', { isPublic }));
  }

  publish(id: string, message?: string): Promise<{ version: number }> {
    return this.request(`/projects/${id}/revisions`, this.json('POST', { message }));
  }

  createShareLink(
    id: string,
    expiresInHours = 24 * 7,
  ): Promise<{ pageUrl: string; expiresAt: string }> {
    return this.request(`/projects/${id}/share-links`, this.json('POST', { expiresInHours }));
  }

  async uploadMedia(projectId: string, file: File): Promise<UploadedMedia> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.request(`/projects/${projectId}/media`, { method: 'POST', body: form });
  }

  // --- API keys (for integrations such as the WordPress plugin) -----------

  async listApiKeys(): Promise<ApiKey[]> {
    return (await this.request<{ apiKeys: ApiKey[] }>('/api-keys')).apiKeys;
  }

  /** Returns the new key with its secret (`key`), which is never shown again. */
  createApiKey(label: string): Promise<ApiKey & { key: string }> {
    return this.request('/api-keys', this.json('POST', { label }));
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request(`/api-keys/${id}`, { method: 'DELETE' });
  }

  // --- AI assistive features (Phase 5) ----------------------------------

  getAiStatus(): Promise<AiStatus> {
    return this.request('/ai/status');
  }

  aiExtractText(input: {
    text?: string;
    url?: string;
    documentTitle?: string;
    projectId?: string;
  }): Promise<ExtractionResult> {
    return this.request('/ai/extract', this.json('POST', input));
  }

  aiExtractFile(
    file: File,
    options?: { documentTitle?: string; projectId?: string },
  ): Promise<ExtractionResult> {
    const form = new FormData();
    if (options?.projectId) form.append('projectId', options.projectId);
    if (options?.documentTitle) form.append('documentTitle', options.documentTitle);
    form.append('file', file, file.name);
    return this.request('/ai/extract', { method: 'POST', body: form });
  }

  aiSummarize(input: {
    title: string;
    body: string;
    eventId?: string;
    projectId?: string;
    maxLength?: number;
  }): Promise<SummarySuggestion> {
    return this.request('/ai/summarize', this.json('POST', input));
  }

  aiAltText(input: {
    imageUrl?: string;
    imageDataUrl?: string;
    eventTitle?: string;
    caption?: string;
    projectId?: string;
  }): Promise<AltTextSuggestion> {
    return this.request('/ai/alt-text', this.json('POST', input));
  }

  aiNormalizeDate(input: {
    text: string;
    useLlm?: boolean;
    projectId?: string;
  }): Promise<DateNormalizationResult> {
    return this.request('/ai/normalize-date', this.json('POST', input));
  }

  aiDetectConflicts(input: {
    timeline: Timeline;
    includeSemantic?: boolean;
    projectId?: string;
  }): Promise<ConflictDetectionResult> {
    return this.request('/ai/detect-conflicts', this.json('POST', input));
  }

  // --- Real-time collaboration (Phase 6) ---------------------------------

  /** WebSocket URL of a project's collaboration room. */
  collabUrl(projectId: string): string {
    return `${this.origin.replace(/^http/, 'ws')}/api/v1/projects/${projectId}/collab`;
  }

  /** Sync over HTTP: send our state vector (and changes), get back what we lack. */
  collabSync(
    projectId: string,
    body: { stateVector?: string; update?: string },
  ): Promise<CollabSyncResult> {
    return this.request(`/projects/${projectId}/sync`, this.json('POST', body));
  }

  async listComments(projectId: string): Promise<CommentDto[]> {
    const path = `/projects/${projectId}/comments`;
    return (await this.request<{ comments: CommentDto[] }>(path)).comments;
  }

  createComment(
    projectId: string,
    input: { eventId?: string; parentId?: string; body: string },
  ): Promise<CommentDto> {
    return this.request(`/projects/${projectId}/comments`, this.json('POST', input));
  }

  updateComment(
    projectId: string,
    commentId: string,
    input: { body?: string; resolved?: boolean },
  ): Promise<CommentDto> {
    return this.request(`/projects/${projectId}/comments/${commentId}`, this.json('PATCH', input));
  }

  async deleteComment(projectId: string, commentId: string): Promise<void> {
    await this.request(`/projects/${projectId}/comments/${commentId}`, { method: 'DELETE' });
  }

  async listWebhooks(projectId: string): Promise<Webhook[]> {
    const path = `/projects/${projectId}/webhooks`;
    return (await this.request<{ webhooks: Webhook[] }>(path)).webhooks;
  }

  createWebhook(
    projectId: string,
    input: { url: string; events: WebhookEventType[]; description?: string },
  ): Promise<Webhook & { secret: string }> {
    return this.request(`/projects/${projectId}/webhooks`, this.json('POST', input));
  }

  updateWebhook(
    projectId: string,
    webhookId: string,
    input: { url?: string; events?: WebhookEventType[]; active?: boolean },
  ): Promise<Webhook> {
    return this.request(`/projects/${projectId}/webhooks/${webhookId}`, this.json('PATCH', input));
  }

  async deleteWebhook(projectId: string, webhookId: string): Promise<void> {
    await this.request(`/projects/${projectId}/webhooks/${webhookId}`, { method: 'DELETE' });
  }

  async rotateWebhookSecret(projectId: string, webhookId: string): Promise<string> {
    const path = `/projects/${projectId}/webhooks/${webhookId}/rotate-secret`;
    return (await this.request<{ secret: string }>(path, { method: 'POST' })).secret;
  }

  async testWebhook(projectId: string, webhookId: string): Promise<void> {
    await this.request(`/projects/${projectId}/webhooks/${webhookId}/test`, { method: 'POST' });
  }

  async listWebhookDeliveries(projectId: string, webhookId: string): Promise<WebhookDelivery[]> {
    const path = `/projects/${projectId}/webhooks/${webhookId}/deliveries`;
    return (await this.request<{ deliveries: WebhookDelivery[] }>(path)).deliveries;
  }

  // --- Public URLs ------------------------------------------------------

  pageUrl(slug: string): string {
    return `${this.origin}/timeline/${slug}`;
  }

  embedUrl(slug: string): string {
    return `${this.origin}/api/v1/embed/${slug}`;
  }
}

/** Expiry (ms since epoch) of a JWT; 0 when it can't be read. */
function tokenExpiry(token: string): number {
  try {
    const part = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part)) as { exp?: number };
    return (payload.exp ?? 0) * 1000;
  } catch {
    return 0;
  }
}

/** Runtime configuration (`/config.json`), so one build works with or without a server. */
export interface EditorConfig {
  apiUrl?: string;
}

const CONFIG_CACHE_KEY = 'chronicle-editor-config';

/**
 * Resolves the editor configuration: `/config.json` (deploy-time) overrides
 * the build-time `VITE_CHRONICLE_API_URL`. When offline, the last
 * successfully loaded configuration is reused. No API URL = local-only mode.
 */
export async function loadEditorConfig(): Promise<EditorConfig> {
  const envUrl = import.meta.env.VITE_CHRONICLE_API_URL as string | undefined;
  const withDefaults = (c: EditorConfig): EditorConfig => ({ apiUrl: c.apiUrl ?? envUrl });
  try {
    const res = await fetch('/config.json', { cache: 'no-cache' });
    // SPA hosts may answer unknown paths with index.html; only trust JSON.
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) throw new Error('no config');
    const config = (await res.json()) as EditorConfig;
    try {
      localStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
    } catch {
      // Storage unavailable.
    }
    return withDefaults(config);
  } catch {
    try {
      const cached = localStorage.getItem(CONFIG_CACHE_KEY);
      if (cached) return withDefaults(JSON.parse(cached) as EditorConfig);
    } catch {
      // Storage unavailable.
    }
    return withDefaults({});
  }
}
