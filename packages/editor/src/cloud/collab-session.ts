import * as Y from 'yjs';
import { validateTimeline, type Timeline } from '@chronicle/schema';
import {
  CollabClient,
  fromBase64,
  isEmptyUpdate,
  jsonEqual,
  readTimeline,
  toBase64,
  writeTimeline,
  type ConnectionStatus,
  type PresenceState,
  type ServerControl,
  type WebSocketConstructor,
} from '@chronicle/collab';
import { useEditor, type RemoteLink } from '../store/editor-store.js';
import { replaceDocument } from '../store/commands.js';
import { loadYState, saveDraft } from '../lib/drafts.js';
import { useCloud, type Api, type Connection, type Peer, type SyncState } from './cloud-store.js';
import {
  applyComment,
  currentSession,
  setCurrentSession,
  type SessionHandle,
} from './session-registry.js';

/**
 * Live collaboration for the linked draft.
 *
 * The editor keeps working on plain timeline objects (commands, undo, the
 * preview). A session mirrors them into a Yjs document:
 *
 * - every local change is written into the Yjs document as a minimal diff
 *   (only the fields that changed; text is spliced), and
 * - every remote change is read back out and shown with `applyRemote`, which
 *   is not an undo step.
 *
 * The Yjs state is saved with the draft in IndexedDB, so edits made offline
 * are merged — not overwritten, and never a conflict — when the editor
 * reconnects. Without a WebSocket (blocked by a proxy, say) the session
 * falls back to syncing over HTTP every few seconds.
 */

/** Origin of changes made in this editor. */
const LOCAL = Symbol('local');
/** Origin of state loaded from storage or the initial server fetch. */
const LOADED = Symbol('loaded');
/** Origin of changes received through the HTTP fallback. */
const HTTP = Symbol('http');

const HTTP_FALLBACK_MS = 5000;
const FLUSH_TIMEOUT_MS = 10_000;

/** Adds schema defaults when the document is valid; keeps it as is otherwise. */
function normalise(doc: Timeline): Timeline {
  const result = validateTimeline(doc);
  return result.success ? result.data : doc;
}

/** Reuses unchanged events and eras from `prev`, so React only re-renders what changed. */
function share(prev: Timeline, next: Timeline): Timeline {
  const reuse = <T extends { id: string }>(before: readonly T[], after: T[]): T[] => {
    const byId = new Map(before.map((item) => [item.id, item]));
    let same = before.length === after.length;
    const out = after.map((item, i) => {
      const old = byId.get(item.id);
      const kept = old && jsonEqual(old, item) ? old : item;
      if (kept !== before[i]) same = false;
      return kept;
    });
    return same ? (before as T[]) : out;
  };
  return {
    ...next,
    settings: jsonEqual(prev.settings, next.settings) ? prev.settings : next.settings,
    events: reuse(prev.events, next.events),
    eras: reuse(prev.eras, next.eras),
  };
}

export interface SessionOptions {
  WebSocket?: WebSocketConstructor;
  /** Milliseconds between HTTP syncs while the WebSocket is down. */
  httpFallbackMs?: number;
}

export class CollabSession implements SessionHandle {
  readonly doc = new Y.Doc();
  client: CollabClient | null = null;
  /** The timeline the Yjs document currently represents (identical to the store's when attached). */
  private mirror: Timeline;
  private unsubscribe: (() => void) | null = null;
  private httpTimer: ReturnType<typeof setInterval> | null = null;
  private serverVector: Uint8Array | null = null;
  private localChanges = 0;
  private httpCleanAt: number | null = null;
  private remoteScheduled = false;
  private destroyed = false;
  private online = typeof navigator === 'undefined' ? true : navigator.onLine;
  private field: string | null = null;
  private pendingConflict: Timeline | null = null;
  private lastSavedAt: number | undefined;

  constructor(
    readonly api: Api,
    readonly projectId: string,
    readonly draftId: string,
    private readonly options: SessionOptions = {},
  ) {
    this.mirror = useEditor.getState().doc;
    this.lastSavedAt = useEditor.getState().remote?.lastSyncedAt;
  }

  // --- Start-up -----------------------------------------------------------

  /** Loads the collaborative state, reconciles it with the open draft, and connects. */
  async start(): Promise<void> {
    setCurrentSession(this);
    useCloud.setState({ connection: 'connecting', peers: [], comments: null });
    const remote = useEditor.getState().remote;
    if (!remote) return;
    const stored = await loadYState(this.draftId).catch(() => null);
    if (this.destroyed) return;

    if (stored) {
      Y.applyUpdate(this.doc, stored, LOADED);
      // Changes saved to the draft after its Yjs state (e.g. the tab closed
      // mid-save) are re-applied as local edits.
      this.writeLocal(useEditor.getState().doc, readTimeline(this.doc));
      this.attach();
      return;
    }

    // No local Yjs state yet (just linked or opened, or a draft from before
    // live collaboration): start from the server's document.
    let draftVersion: number;
    try {
      const res = await this.callSync({});
      if (this.isDestroyed()) return;
      Y.applyUpdate(this.doc, fromBase64(res.update), LOADED);
      this.serverVector = fromBase64(res.stateVector);
      draftVersion = res.draftVersion;
    } catch (err) {
      this.fail(err);
      return;
    }
    const server = normalise({ ...readTimeline(this.doc), id: this.projectId });
    // Read the link again: edits made while the server copy was loading mark it dirty.
    const { doc: mine, remote: link } = useEditor.getState();
    if (link?.projectId !== this.projectId) return;
    if (jsonEqual({ ...mine, id: '' }, { ...server, id: '' })) {
      this.mirror = mine;
    } else if (!link.dirty) {
      this.mirror = server;
      useEditor.getState().applyRemote(server);
    } else if (draftVersion === link.baseVersion) {
      // Nobody else saved since our last sync: our changes apply cleanly.
      this.writeLocal(mine, readTimeline(this.doc));
    } else {
      // Unsynced changes from before live collaboration, and the server moved on.
      this.pendingConflict = server;
      useCloud.getState().setConflict({
        serverVersion: draftVersion,
        serverDraft: server,
        serverUpdatedAt: '',
      });
      useCloud.getState().setSync({ kind: 'conflict' });
      return;
    }
    this.attach();
  }

  /** Settles a start-up conflict (see `start`), then goes live. */
  resolve(choice: 'keep-mine' | 'use-theirs'): void {
    const server = this.pendingConflict;
    if (!server || this.destroyed) return;
    this.pendingConflict = null;
    useCloud.getState().setConflict(null);
    if (choice === 'keep-mine') {
      this.writeLocal(useEditor.getState().doc, readTimeline(this.doc));
    } else {
      // Undoable, so the user can still get their version back.
      const editor = useEditor.getState();
      this.mirror = server;
      editor.execute(replaceDocument(editor.doc, server, 'Use the server version'));
      this.mirror = useEditor.getState().doc;
    }
    this.attach();
  }

  private writeLocal(next: Timeline, prev?: Timeline): void {
    writeTimeline(this.doc, next, { origin: LOCAL, prev });
    this.mirror = next;
  }

  private attach(): void {
    if (this.destroyed) return;
    this.doc.on('update', this.onDocUpdate);

    // Local edits → Yjs (synchronously, so the document is always current).
    this.unsubscribe = useEditor.subscribe((state, prev) => {
      if (state.draftId !== this.draftId) return;
      if (state.doc !== this.mirror) this.writeLocal(state.doc, this.mirror);
      if (state.selectedId !== prev.selectedId) this.publishPresence();
    });
    // The store may have changed while we were loading.
    const now = useEditor.getState().doc;
    if (now !== this.mirror) this.writeLocal(now, this.mirror);

    const remote = useEditor.getState().remote;
    const client = new CollabClient({
      url: this.api.collabUrl?.(this.projectId) ?? '',
      doc: this.doc,
      getToken: () => this.api.getAccessToken?.() ?? Promise.resolve(null),
      WebSocket: this.options.WebSocket,
      pending: remote?.dirty ?? false,
    });
    this.client = client;
    client.on('status', this.onStatus);
    client.on('pending', () => {
      this.updateSyncState();
    });
    client.on('ready', ({ role }) => {
      this.setRole(role);
      void this.loadComments();
    });
    client.on('message', this.onMessage);
    client.awareness.on('change', this.onPresence);
    document.addEventListener('focusin', this.onFocus);
    document.addEventListener('focusout', this.onFocus);
    this.publishPresence();

    this.httpTimer = setInterval(() => {
      if (this.client?.status !== 'connected' && this.online) void this.httpSync();
    }, this.options.httpFallbackMs ?? HTTP_FALLBACK_MS);
    if (this.online) client.connect();
    else this.onStatus('idle');
    this.updateSyncState();
  }

  // --- Changes ------------------------------------------------------------

  private readonly onDocUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin === LOCAL) {
      this.localChanges++;
      this.updateSyncState();
      return;
    }
    if (origin === LOADED || this.remoteScheduled) return;
    // Coalesce a burst of remote updates into one store change.
    this.remoteScheduled = true;
    queueMicrotask(() => {
      this.remoteScheduled = false;
      if (this.destroyed) return;
      const next = share(
        this.mirror,
        normalise({ ...readTimeline(this.doc), id: this.mirror.id || this.projectId }),
      );
      this.mirror = next;
      useEditor.getState().applyRemote(next);
    });
  };

  /** Local changes not yet confirmed as stored by the server. */
  get pending(): boolean {
    const client = this.client;
    if (!client) return useEditor.getState().remote?.dirty ?? false;
    if (client.status === 'connected' || this.httpCleanAt === null) return client.pending;
    return client.pending && this.httpCleanAt !== this.localChanges;
  }

  private setRole(role: RemoteLink['role']): void {
    const remote = useEditor.getState().remote;
    if (remote && remote.role !== role) useEditor.getState().setRemote({ ...remote, role });
    this.updateSyncState();
  }

  /** Mirrors the connection into the UI and persists the "unsynced changes" flag. */
  private updateSyncState(): void {
    if (this.destroyed) return;
    const editor = useEditor.getState();
    const remote = editor.remote;
    if (remote?.projectId !== this.projectId) return;
    const pending = this.pending;
    if (pending !== remote.dirty || (!pending && this.lastSavedAt === undefined)) {
      if (!pending) this.lastSavedAt = Date.now();
      const next: RemoteLink = {
        ...remote,
        dirty: pending,
        lastSyncedAt: pending ? remote.lastSyncedAt : this.lastSavedAt,
      };
      editor.setRemote(next);
      // Persist right away, so a reload can't lose track of unsynced changes.
      void saveDraft(this.draftId, editor.doc, next, Y.encodeStateAsUpdate(this.doc)).catch(
        () => undefined,
      );
    }

    const client = this.client;
    let sync: SyncState;
    if (client?.status === 'closed') {
      sync = { kind: 'blocked', reason: client.closeReason?.reason || 'Disconnected' };
    } else if (remote.role === 'viewer') {
      sync = { kind: 'blocked', reason: 'View only — you see others’ changes live' };
    } else if (!pending) {
      sync = { kind: 'synced', at: this.lastSavedAt ?? Date.now() };
    } else if (!this.online) {
      sync = { kind: 'offline' };
    } else if (client?.status === 'connected') {
      sync = { kind: 'syncing' };
    } else {
      sync = { kind: 'pending' };
    }
    const cloud = useCloud.getState();
    if (!cloud.conflict) cloud.setSync(sync);
  }

  private readonly onStatus = (status: ConnectionStatus): void => {
    const map: Record<ConnectionStatus, Connection> = {
      idle: this.httpCleanAt !== null ? 'http' : 'off',
      connecting: 'connecting',
      connected: 'live',
      reconnecting: this.httpCleanAt !== null ? 'http' : 'reconnecting',
      closed: 'closed',
    };
    useCloud.setState({ connection: map[status] });
    if (status !== 'connected') this.onPresence();
    this.updateSyncState();
  };

  private readonly onMessage = (message: ServerControl): void => {
    switch (message.type) {
      case 'role':
        this.setRole(message.role);
        break;
      case 'saved': {
        const remote = useEditor.getState().remote;
        if (remote)
          useEditor.getState().setRemote({ ...remote, baseVersion: message.draftVersion });
        break;
      }
      case 'comment':
        applyComment(message.action, message.comment);
        break;
      default:
        break;
    }
  };

  /** One HTTP sync round: send what the server lacks, take what we lack. */
  async httpSync(): Promise<void> {
    if (this.destroyed || !this.client) return;
    const readOnly = useEditor.getState().remote?.role === 'viewer';
    const before = this.localChanges;
    const update = this.serverVector
      ? Y.encodeStateAsUpdate(this.doc, this.serverVector)
      : Y.encodeStateAsUpdate(this.doc);
    try {
      const res = await this.callSync({
        stateVector: toBase64(Y.encodeStateVector(this.doc)),
        update: readOnly || isEmptyUpdate(update) ? undefined : toBase64(update),
      });
      if (this.isDestroyed()) return;
      Y.applyUpdate(this.doc, fromBase64(res.update), HTTP);
      this.serverVector = fromBase64(res.stateVector);
      if (this.httpCleanAt === null && this.client.status !== 'connected') {
        useCloud.setState({ connection: 'http' });
      }
      this.httpCleanAt = before;
      this.setRole(res.role);
      if (useCloud.getState().comments === null) void this.loadComments();
    } catch {
      // Still offline or unreachable; the next round retries.
    }
    this.updateSyncState();
  }

  private async callSync(body: { stateVector?: string; update?: string }) {
    if (!this.api.collabSync) throw new Error('This server does not support live collaboration');
    return this.api.collabSync(this.projectId, body);
  }

  /** Waits until the server has every local change (before publishing). */
  async flush(): Promise<void> {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS;
    if (this.client?.status !== 'connected') await this.httpSync();
    const pending = () => this.pending;
    while (pending() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (this.client?.status !== 'connected' && pending()) await this.httpSync();
    }
    if (this.pending) throw new Error('Your latest changes are not saved to the server yet');
  }

  /** Reconnects now (the status bar's Retry). */
  retry(): void {
    this.client?.connect();
    void this.httpSync();
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!this.client) return;
    if (online) this.client.connect();
    else this.client.disconnect();
    this.updateSyncState();
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number }).status;
    useCloud.setState({ connection: 'off' });
    useCloud
      .getState()
      .setSync(
        status === 0
          ? { kind: 'offline' }
          : status === 403 || status === 404
            ? { kind: 'blocked', reason: 'You no longer have access to this timeline' }
            : { kind: 'error', message },
      );
    // Try again shortly (e.g. the server was unreachable at start-up).
    if (status !== 403 && status !== 404) {
      setTimeout(() => {
        if (!this.destroyed && !this.client) void this.start();
      }, HTTP_FALLBACK_MS);
    }
  }

  // --- Presence and comments ----------------------------------------------

  private readonly onFocus = (e: FocusEvent): void => {
    const target = e.type === 'focusin' ? e.target : null;
    const field =
      target instanceof Element
        ? (target.closest('[data-presence-field]')?.getAttribute('data-presence-field') ?? null)
        : null;
    if (field !== this.field) {
      this.field = field;
      this.publishPresence();
    }
  };

  private publishPresence(): void {
    const awareness = this.client?.awareness;
    if (!awareness) return;
    awareness.setLocalState({ eventId: useEditor.getState().selectedId, field: this.field });
  }

  private readonly onPresence = (): void => {
    const awareness = this.client?.awareness;
    if (!awareness) return;
    const peers: Peer[] = [];
    if (this.client?.status === 'connected') {
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === this.doc.clientID) continue;
        const s = state as Partial<PresenceState>;
        if (!s.user) continue;
        peers.push({
          clientId,
          user: s.user,
          eventId: s.eventId ?? null,
          field: s.field ?? null,
        });
      }
    }
    peers.sort((a, b) => a.user.name.localeCompare(b.user.name) || a.clientId - b.clientId);
    useCloud.setState({ peers });
  };

  private async loadComments(): Promise<void> {
    if (!this.api.listComments) return;
    try {
      const comments = await this.api.listComments(this.projectId);
      if (!this.destroyed) useCloud.setState({ comments });
    } catch {
      // Comments are optional; they load on the next connection.
    }
  }

  ystate(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** A method, so TypeScript doesn't assume it can't change across an await. */
  private isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (currentSession() === this) setCurrentSession(null);
    this.unsubscribe?.();
    if (this.httpTimer) clearInterval(this.httpTimer);
    document.removeEventListener('focusin', this.onFocus);
    document.removeEventListener('focusout', this.onFocus);
    this.client?.awareness.off('change', this.onPresence);
    this.client?.destroy();
    this.doc.off('update', this.onDocUpdate);
    this.doc.destroy();
    useCloud.setState({ connection: 'off', peers: [], comments: null });
  }
}
