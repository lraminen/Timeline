import { create } from 'zustand';
import type { Timeline } from '@chronicle/schema';
import type { CommentDto, PresenceState } from '@chronicle/collab';
import { ChronicleApi, type User } from '../lib/api.js';

export type SyncState =
  | { kind: 'local' }
  | { kind: 'synced'; at: number }
  | { kind: 'pending' }
  | { kind: 'syncing' }
  | { kind: 'offline' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

export interface ConflictInfo {
  serverVersion: number;
  serverDraft: Timeline;
  serverUpdatedAt: string;
}

/** Subset of ChronicleApi the sync layer needs (lets tests use a fake). */
export type Api = Pick<
  ChronicleApi,
  | 'origin'
  | 'refresh'
  | 'login'
  | 'register'
  | 'logout'
  | 'listProjects'
  | 'createProject'
  | 'getProject'
  | 'getDraft'
  | 'saveDraft'
  | 'setVisibility'
  | 'publish'
  | 'createShareLink'
  | 'uploadMedia'
  | 'listApiKeys'
  | 'createApiKey'
  | 'revokeApiKey'
  | 'pageUrl'
  | 'embedUrl'
> &
  Partial<
    Pick<
      ChronicleApi,
      | 'getAiStatus'
      | 'aiExtractText'
      | 'aiExtractFile'
      | 'aiSummarize'
      | 'aiAltText'
      | 'aiNormalizeDate'
      | 'aiDetectConflicts'
      | 'getAccessToken'
      | 'collabUrl'
      | 'collabSync'
      | 'listComments'
      | 'createComment'
      | 'updateComment'
      | 'deleteComment'
      | 'listWebhooks'
      | 'createWebhook'
      | 'updateWebhook'
      | 'deleteWebhook'
      | 'rotateWebhookSecret'
      | 'testWebhook'
      | 'listWebhookDeliveries'
    >
  >;

/** Live collaboration link state (the WebSocket, or the HTTP fallback). */
export type Connection =
  | 'off'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  /** No WebSocket; syncing over plain HTTP every few seconds. */
  | 'http'
  | 'closed';

/** Someone else in the timeline right now. */
export interface Peer extends PresenceState {
  clientId: number;
}

export interface CloudState {
  /** Null when no server is configured (local-only mode). */
  api: Api | null;
  user: User | null;
  /** True until the initial session check finishes. */
  checking: boolean;
  sync: SyncState;
  conflict: ConflictInfo | null;
  connection: Connection;
  /** Other people connected to the same timeline (one entry per browser tab). */
  peers: Peer[];
  /** Comments on the linked project, oldest first; null until loaded. */
  comments: CommentDto[] | null;
  setApi: (api: Api | null) => void;
  setUser: (user: User | null) => void;
  setSync: (sync: SyncState) => void;
  setConflict: (conflict: ConflictInfo | null) => void;
}

export const useCloud = create<CloudState>()((set) => ({
  api: null,
  user: null,
  checking: false,
  sync: { kind: 'local' },
  conflict: null,
  connection: 'off',
  peers: [],
  comments: null,
  setApi: (api) => {
    set({ api, checking: api !== null });
  },
  setUser: (user) => {
    set({ user, checking: false });
  },
  setSync: (sync) => {
    set({ sync });
  },
  setConflict: (conflict) => {
    set({ conflict });
  },
}));

/** Creates the API client from runtime config and restores any session. */
export async function initCloud(apiUrl: string | undefined): Promise<void> {
  const cloud = useCloud.getState();
  if (!apiUrl) {
    cloud.setApi(null);
    return;
  }
  const api = new ChronicleApi(apiUrl);
  cloud.setApi(api);
  cloud.setUser(await api.refresh());
}
