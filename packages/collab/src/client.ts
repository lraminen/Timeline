import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { isEmptyUpdate } from './mapping.js';
import {
  CloseCode,
  decodeMessage,
  encodeAwareness,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  type PresenceUser,
  type Role,
  type ServerControl,
} from './protocol.js';

/** The subset of the WebSocket API the client uses (browser or `ws`). */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send: (data: Uint8Array) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type ConnectionStatus =
  /** Not connected and not trying (before `connect()`, or after `disconnect()`). */
  | 'idle'
  | 'connecting'
  /** Authenticated; live updates flow both ways. */
  | 'connected'
  /** Lost the connection; a reconnect is scheduled. */
  | 'reconnecting'
  /** Stopped for good: access removed, project gone, or signed out. See `closeReason`. */
  | 'closed';

export interface CollabClientOptions {
  /** `ws(s)://…/api/v1/projects/:id/collab` */
  url: string;
  doc: Y.Doc;
  awareness?: Awareness;
  /** Returns a current access token (or API key); `null` when signed out. */
  getToken: () => Promise<string | null>;
  WebSocket?: WebSocketConstructor;
  /** Local changes that the server has not confirmed yet (e.g. restored from storage). */
  pending?: boolean;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface CollabClientEvents {
  status: (status: ConnectionStatus) => void;
  /** Authenticated (also fires again after a re-authentication). */
  ready: (info: { role: Role; user: PresenceUser }) => void;
  /** The first exchange of missing changes with the server finished. */
  synced: () => void;
  /** Whether local changes are waiting for the server's confirmation changed. */
  pending: (pending: boolean) => void;
  /** Other server messages (`saved`, `comment`, `role`, `error`). */
  message: (message: ServerControl) => void;
}

type Listener<K extends keyof CollabClientEvents> = CollabClientEvents[K];

const isBinary = (data: unknown): data is ArrayBuffer | Uint8Array =>
  data instanceof ArrayBuffer || data instanceof Uint8Array;

/**
 * Keeps a Yjs document in sync with a Chronicle server over WebSocket, and
 * shares presence through `awareness`.
 *
 * Local changes made while offline stay in the document and are sent on the
 * next connection (the sync handshake exchanges whatever each side lacks), so
 * nothing is lost and nothing conflicts. `pending` tells whether the server
 * has durably stored every local change.
 */
export class CollabClient {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  status: ConnectionStatus = 'idle';
  role: Role | null = null;
  user: PresenceUser | null = null;
  /** True once this connection has received the server's missing changes. */
  synced = false;
  closeReason: { code: number; reason: string } | null = null;

  private readonly url: string;
  private readonly getToken: () => Promise<string | null>;
  private readonly WS: WebSocketConstructor;
  private readonly minDelay: number;
  private readonly maxDelay: number;
  private ws: WebSocketLike | null = null;
  private handshakeDone = false;
  private sent = 0;
  private acked = 0;
  private unsent: boolean;
  private lastPending: boolean;
  private retries = 0;
  private authFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private readonly ownsAwareness: boolean;
  private readonly listeners = new Map<keyof CollabClientEvents, Set<(...args: never[]) => void>>();

  constructor(options: CollabClientOptions) {
    this.url = options.url;
    this.doc = options.doc;
    this.ownsAwareness = !options.awareness;
    this.awareness = options.awareness ?? new Awareness(options.doc);
    this.getToken = options.getToken;
    const WS =
      options.WebSocket ??
      (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!WS) throw new Error('No WebSocket implementation available');
    this.WS = WS;
    this.minDelay = options.minReconnectDelayMs ?? 500;
    this.maxDelay = options.maxReconnectDelayMs ?? 15_000;
    this.unsent = options.pending ?? false;
    this.lastPending = this.unsent;
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  // --- Events -------------------------------------------------------------

  on<K extends keyof CollabClientEvents>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit<K extends keyof CollabClientEvents>(
    event: K,
    ...args: Parameters<Listener<K>>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...a: Parameters<Listener<K>>) => void)(...args);
    }
  }

  // --- State --------------------------------------------------------------

  /** Local changes not yet confirmed as stored by the server. */
  get pending(): boolean {
    return this.unsent || this.acked < this.sent;
  }

  get readOnly(): boolean {
    return this.role === 'viewer';
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private notifyPending(): void {
    const pending = this.pending;
    if (pending !== this.lastPending) {
      this.lastPending = pending;
      this.emit('pending', pending);
    }
  }

  // --- Connection lifecycle -----------------------------------------------

  /** Connects (or reconnects now, skipping any backoff delay). */
  connect(): void {
    this.wanted = true;
    if (this.status === 'closed' || this.ws) return;
    this.clearRetry();
    this.setStatus('connecting');
    let ws: WebSocketLike;
    try {
      ws = new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.handshakeDone = false;
    ws.onopen = () => void this.authenticate(ws);
    ws.onmessage = (ev) => {
      this.onMessage(ws, ev.data);
    };
    ws.onclose = (ev) => {
      this.onClose(ws, ev.code, ev.reason);
    };
    ws.onerror = () => undefined; // a close event always follows
  }

  /** Closes the connection without reconnecting (e.g. the browser went offline). */
  disconnect(): void {
    this.wanted = false;
    this.clearRetry();
    this.dropSocket(1000, 'Client disconnected');
    if (this.status !== 'closed') this.setStatus('idle');
  }

  /** Disconnects for good and releases listeners. */
  destroy(): void {
    this.awareness.setLocalState(null);
    this.disconnect();
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    if (this.ownsAwareness) this.awareness.destroy();
    this.listeners.clear();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private dropSocket(code: number, reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    this.afterSocketGone();
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private afterSocketGone(): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    this.reauthTimer = null;
    this.synced = false;
    this.handshakeDone = false;
    // Frames the server never confirmed are re-sent by the next handshake.
    this.unsent ||= this.acked < this.sent;
    this.sent = 0;
    this.acked = 0;
    const others = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID);
    if (others.length > 0) removeAwarenessStates(this.awareness, others, this);
  }

  private stop(code: number, reason: string): void {
    this.wanted = false;
    this.clearRetry();
    this.closeReason = { code, reason };
    this.dropSocket(1000, reason);
    this.setStatus('closed');
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.status === 'closed') return;
    this.setStatus('reconnecting');
    const base = Math.min(this.maxDelay, this.minDelay * 2 ** this.retries);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retries++;
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private async authenticate(ws: WebSocketLike): Promise<void> {
    const token = await this.getToken().catch(() => null);
    if (ws !== this.ws) return;
    if (!token) {
      this.stop(CloseCode.Unauthorized, 'Sign in to collaborate');
      return;
    }
    ws.send(encodeControl({ type: 'auth', token }));
  }

  private onClose(ws: WebSocketLike, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    this.afterSocketGone();
    this.notifyPending();
    if (
      code === CloseCode.Forbidden ||
      code === CloseCode.NotFound ||
      code === CloseCode.PolicyViolation ||
      code === 1009 // frame too big: re-sending it would only fail again
    ) {
      this.stop(code, reason);
    } else if (code === CloseCode.Unauthorized) {
      // A fresh token usually fixes it; twice in a row means signed out.
      if (++this.authFailures >= 2) this.stop(code, reason);
      else this.scheduleReconnect();
    } else {
      this.scheduleReconnect();
    }
  }

  // --- Incoming -----------------------------------------------------------

  private onMessage(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.ws || !isBinary(data)) return;
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let message: ReturnType<typeof decodeMessage>;
    try {
      message = decodeMessage(bytes);
    } catch {
      this.dropSocket(CloseCode.PolicyViolation, 'Malformed message');
      this.scheduleReconnect();
      return;
    }
    switch (message.kind) {
      case 'control':
        this.onControl(ws, message.message as ServerControl);
        break;
      case 'sync-step1': {
        // Send the server everything it lacks — including offline edits.
        if (!this.readOnly) {
          const update = Y.encodeStateAsUpdate(this.doc, message.stateVector);
          if (!isEmptyUpdate(update)) this.sendDoc(ws, encodeSyncStep2(update));
          this.unsent = false;
          this.notifyPending();
        }
        break;
      }
      case 'sync-step2':
      case 'update':
        Y.applyUpdate(this.doc, message.update, this);
        if (message.kind === 'sync-step2' && !this.synced) {
          this.synced = true;
          this.emit('synced');
        }
        break;
      case 'awareness':
        applyAwarenessUpdate(this.awareness, message.update, this);
        break;
    }
  }

  private onControl(ws: WebSocketLike, message: ServerControl): void {
    switch (message.type) {
      case 'ready': {
        this.role = message.role;
        this.user = message.user;
        this.retries = 0;
        this.authFailures = 0;
        this.scheduleReauth(message.expiresAt);
        if (!this.handshakeDone) {
          this.handshakeDone = true;
          this.setStatus('connected');
          ws.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
          // Re-announce presence with a newer clock, so the server accepts it
          // even if it still remembers this client from a dropped connection.
          const local = this.awareness.getLocalState();
          if (local !== null) this.awareness.setLocalState(local);
        }
        this.emit('ready', { role: message.role, user: message.user });
        break;
      }
      case 'ack':
        this.acked = Math.min(message.count, this.sent);
        this.notifyPending();
        break;
      case 'role':
        this.role = message.role;
        this.emit('message', message);
        break;
      default:
        this.emit('message', message);
    }
  }

  private scheduleReauth(expiresAt: number | null): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    this.reauthTimer = null;
    if (expiresAt === null) return;
    const delay = Math.max(5_000, expiresAt - Date.now() - 60_000);
    const ws = this.ws;
    this.reauthTimer = setTimeout(() => {
      if (ws) void this.authenticate(ws);
    }, delay);
  }

  // --- Outgoing -----------------------------------------------------------

  private sendDoc(ws: WebSocketLike, frame: Uint8Array): void {
    this.sent++;
    ws.send(frame);
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    const ws = this.ws;
    if (ws && this.handshakeDone && !this.readOnly) {
      this.sendDoc(ws, encodeUpdate(update));
    } else {
      this.unsent = true;
    }
    this.notifyPending();
  };

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    const ws = this.ws;
    if (!ws || !this.handshakeDone) return;
    const mine = [...changes.added, ...changes.updated, ...changes.removed].filter(
      (id) => id === this.doc.clientID,
    );
    if (mine.length > 0) ws.send(encodeAwareness(encodeAwarenessUpdate(this.awareness, mine)));
  };
}
