import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate as encodeAwarenessStates,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { repairTimelineDates, validateTimeline, type Timeline } from '@chronicle/schema';
import {
  decodeAwarenessUpdate,
  encodeAwareness,
  encodeAwarenessUpdate,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeTimeline,
  encodeUpdate,
  readTimeline,
  sanitizePresence,
  writeTimeline,
  CloseCode,
  ProtocolError,
  type PresenceUser,
  type Role,
  type ServerControl,
} from '@chronicle/collab';
import type { Db } from '../db/client.js';
import { collabUpdates, projects } from '../db/schema.js';
import { ApiError, badRequest, notFound } from '../http.js';

/**
 * Real-time collaboration: one in-memory "room" per open project.
 *
 * The Yjs document is the source of truth for a project's working copy.
 * Every change — live edits over WebSocket, the REST sync fallback, and the
 * classic REST draft/event endpoints — is applied to the room's document,
 * broadcast to everyone connected, and appended to `collab_updates`.
 *
 * `projects.draft` (the JSON used by publishing, embeds and API readers) is
 * derived from the document: it is re-written shortly after edits stop, and
 * only when the result is schema-valid, so it always holds the latest *valid*
 * state. In-progress invalid states (an empty title while typing) are shared
 * live but never published.
 *
 * Several server instances can serve the same project: writes take a
 * per-project advisory lock, so `collab_updates.seq` commits in order and an
 * instance catches up by reading rows after the last one it applied (before
 * every write, and by polling while people are connected).
 */

/** Transaction origins that are already stored (must not be persisted again). */
const FROM_STORAGE = Symbol('storage');
/** Origin for changes made through REST endpoints. */
const FROM_REST = Symbol('rest');

/** Keep a room in memory this long after the last connection leaves. */
const ROOM_IDLE_MS = 30_000;
const MAX_AWARENESS_CLIENTS_PER_CONNECTION = 2;

export interface CollabConnection {
  readonly id: string;
  readonly userId: string;
  role: Role;
  readonly user: PresenceUser;
  readonly apiKeyId?: string;
  /** Document frames received from this connection (acknowledged cumulatively). */
  received: number;
  /** Awareness client ids this connection speaks for. */
  readonly clientIds: Set<number>;
  send: (frame: Uint8Array) => void;
  close: (code: number, reason: string) => void;
}

export interface CollabOptions {
  db: Db;
  maxDocBytes: number;
  draftSaveMs: number;
  pollMs: number;
  /** Fold the update log into the snapshot after this many rows. */
  compactEvery: number;
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void };
  /** Called after the JSON draft was re-written. */
  onDraftSaved?: (projectId: string, saved: { draftVersion: number; updatedAt: Date }) => void;
}

export interface ValidationProblem {
  path: string;
  message: string;
}

type ValidationResult =
  { ok: true; timeline: Timeline } | { ok: false; issues: ValidationProblem[] };

/** Validates a document the same way `validateDocument` does, without throwing. */
export function checkTimeline(input: unknown): ValidationResult {
  const result = validateTimeline(repairTimelineDates(input).timeline);
  if (result.success) return { ok: true, timeline: result.data };
  return {
    ok: false,
    issues: result.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

/** JSON with sorted keys: stable for comparing documents (jsonb reorders keys). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

const lockProject = (tx: Db, projectId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`collab:${projectId}`}))`);

const isFkViolation = (err: unknown) => (err as { code?: string }).code === '23503';

class ProjectGone extends Error {}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly conns = new Set<CollabConnection>();
  /** Highest `collab_updates.seq` applied to `doc`. */
  private lastSeq = 0;
  private rowsSinceSnapshot = 0;
  private approxBytes = 0;
  private pendingUpdates: Uint8Array[] = [];
  private pendingAcks: { conn: CollabConnection; count: number }[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private flushScheduled = false;
  private flushRetryMs = 0;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedJson: string | null = null;
  draftVersion = 0;
  closed = false;
  /** Validation problems of the current document (empty when valid). */
  problems: ValidationProblem[] = [];

  constructor(
    readonly projectId: string,
    private readonly service: CollabService,
  ) {
    // The server takes part in the document but is not a participant.
    this.awareness.setLocalState(null);
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  private get db(): Db {
    return this.service.options.db;
  }

  /** Runs `task` after every task queued before it (one at a time per room). */
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // --- Loading and catching up --------------------------------------------

  async load(): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockProject(tx, this.projectId);
      const [row] = await tx
        .select({
          ydoc: projects.ydoc,
          ydocSeq: projects.ydocSeq,
          draft: projects.draft,
          draftVersion: projects.draftVersion,
        })
        .from(projects)
        .where(eq(projects.id, this.projectId))
        .limit(1);
      if (!row) throw notFound('Project');
      this.draftVersion = row.draftVersion;
      this.lastSavedJson = canonical(row.draft);
      if (row.ydoc) {
        Y.applyUpdate(this.doc, row.ydoc, FROM_STORAGE);
        this.approxBytes = row.ydoc.byteLength;
        this.lastSeq = row.ydocSeq;
        await this.catchUp(tx);
      } else {
        // First collaborative use: build the document once, under the lock,
        // so every instance starts from the same Yjs history.
        const initial = encodeTimeline(row.draft);
        await tx.update(projects).set({ ydoc: initial }).where(eq(projects.id, this.projectId));
        Y.applyUpdate(this.doc, initial, FROM_STORAGE);
        this.approxBytes = initial.byteLength;
      }
    });
    this.problems = this.validate().problems;
    if (this.service.options.pollMs > 0) {
      this.pollTimer = setInterval(() => {
        if (this.conns.size === 0) return;
        void this.run(() => this.catchUp(this.db)).catch((err: unknown) => {
          this.handleStorageError(err, 'collab poll failed');
        });
      }, this.service.options.pollMs);
      this.pollTimer.unref();
    }
  }

  /** Applies rows written by other instances since `lastSeq`. */
  private async catchUp(tx: Db): Promise<void> {
    const [snapshot] = await tx
      .select({ ydoc: projects.ydoc, ydocSeq: projects.ydocSeq })
      .from(projects)
      .where(eq(projects.id, this.projectId))
      .limit(1);
    if (!snapshot) throw new ProjectGone();
    if (snapshot.ydocSeq > this.lastSeq && snapshot.ydoc) {
      // Another instance compacted rows we have not seen: merge its snapshot.
      Y.applyUpdate(this.doc, snapshot.ydoc, FROM_STORAGE);
      this.lastSeq = snapshot.ydocSeq;
      this.rowsSinceSnapshot = 0;
    }
    const rows = await tx
      .select({ seq: collabUpdates.seq, data: collabUpdates.data })
      .from(collabUpdates)
      .where(and(eq(collabUpdates.projectId, this.projectId), gt(collabUpdates.seq, this.lastSeq)))
      .orderBy(asc(collabUpdates.seq));
    for (const r of rows) {
      Y.applyUpdate(this.doc, r.data, FROM_STORAGE);
      this.approxBytes += r.data.byteLength;
      this.lastSeq = r.seq;
      this.rowsSinceSnapshot++;
    }
    if (rows.length > 0) this.scheduleDraftSave();
  }

  // --- Changes ------------------------------------------------------------

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const frame = encodeUpdate(update);
    for (const conn of this.conns) if (conn !== origin) conn.send(frame);
    if (origin === FROM_STORAGE) return;
    this.pendingUpdates.push(update);
    this.approxBytes += update.byteLength;
    this.scheduleFlush();
    this.scheduleDraftSave();
  };

  /** True when applying `update` would push the document over the size limit. */
  wouldExceedLimit(update: Uint8Array): boolean {
    return this.approxBytes + update.byteLength > this.service.options.maxDocBytes;
  }

  /** A document frame from an editor's connection. */
  receive(conn: CollabConnection, update: Uint8Array): void {
    conn.received++;
    try {
      Y.applyUpdate(this.doc, update, conn);
    } catch {
      throw new ProtocolError('Malformed document update');
    }
    this.pendingAcks.push({ conn, count: conn.received });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.closed) return;
    this.flushScheduled = true;
    const delay = this.flushRetryMs;
    const go = () => {
      this.flushScheduled = false;
      void this.run(() => this.flush()).catch((err: unknown) => {
        this.handleStorageError(err, 'collab persist failed');
      });
    };
    if (delay > 0) setTimeout(go, delay).unref();
    else queueMicrotask(go);
  }

  /** Stores queued updates (one row per batch), then acknowledges them. */
  private async flush(): Promise<void> {
    if (this.closed) return;
    const updates = this.pendingUpdates.splice(0);
    const acks = this.pendingAcks.splice(0);
    if (updates.length > 0) {
      try {
        await this.db.transaction(async (transaction) => {
          const tx = transaction as unknown as Db;
          await lockProject(tx, this.projectId);
          await this.catchUp(tx);
          const [row] = await tx
            .insert(collabUpdates)
            .values({ projectId: this.projectId, data: Y.mergeUpdates(updates) })
            .returning({ seq: collabUpdates.seq });
          if (!row) throw new Error('collab update insert returned no row');
          this.lastSeq = row.seq;
          this.rowsSinceSnapshot++;
          if (this.rowsSinceSnapshot >= this.service.options.compactEvery) await this.compact(tx);
        });
        this.flushRetryMs = 0;
      } catch (err) {
        // Keep the work for a retry; clients stay "pending" until acknowledged.
        this.pendingUpdates.unshift(...updates);
        this.pendingAcks.unshift(...acks);
        this.flushRetryMs = Math.min(30_000, Math.max(500, this.flushRetryMs * 2));
        if (!(err instanceof ProjectGone) && !isFkViolation(err)) this.scheduleFlush();
        throw err;
      }
    }
    for (const { conn, count } of acks) {
      if (this.conns.has(conn)) conn.send(encodeControl({ type: 'ack', count }));
    }
  }

  private async compact(tx: Db): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.doc);
    await tx
      .update(projects)
      .set({ ydoc: state, ydocSeq: this.lastSeq })
      .where(eq(projects.id, this.projectId));
    await tx
      .delete(collabUpdates)
      .where(
        and(eq(collabUpdates.projectId, this.projectId), lte(collabUpdates.seq, this.lastSeq)),
      );
    this.rowsSinceSnapshot = 0;
    this.approxBytes = state.byteLength;
  }

  private validate(): { timeline: Timeline | null; problems: ValidationProblem[] } {
    const checked = checkTimeline(readTimeline(this.doc));
    if (!checked.ok) return { timeline: null, problems: checked.issues };
    return { timeline: { ...checked.timeline, id: this.projectId }, problems: [] };
  }

  private scheduleDraftSave(): void {
    if (this.closed || this.draftTimer) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.run(() => this.saveDraft()).catch((err: unknown) => {
        this.handleStorageError(err, 'draft save failed');
      });
    }, this.service.options.draftSaveMs);
    this.draftTimer.unref();
  }

  /**
   * Stores pending updates, then re-writes `projects.draft` from the
   * document if it is valid and changed. Returns the current draft version.
   */
  async saveDraft(): Promise<{ draftVersion: number; updatedAt: Date | null }> {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = null;
    await this.flush();
    if (this.closed) return { draftVersion: this.draftVersion, updatedAt: null };
    const saved = await this.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockProject(tx, this.projectId);
      await this.catchUp(tx);
      const { timeline, problems } = this.validate();
      this.problems = problems;
      const [current] = await tx
        .select({ draftVersion: projects.draftVersion, draft: projects.draft })
        .from(projects)
        .where(eq(projects.id, this.projectId))
        .limit(1);
      if (!current) throw new ProjectGone();
      this.draftVersion = current.draftVersion;
      if (!timeline) return null;
      const json = canonical(timeline);
      // Another instance may have saved the same state already.
      if (json === this.lastSavedJson || json === canonical(current.draft)) {
        this.lastSavedJson = json;
        return null;
      }
      const [row] = await tx
        .update(projects)
        .set({
          draft: timeline,
          title: timeline.title || 'Untitled timeline',
          draftVersion: sql`${projects.draftVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, this.projectId))
        .returning({ draftVersion: projects.draftVersion, updatedAt: projects.updatedAt });
      if (!row) throw new ProjectGone();
      this.lastSavedJson = json;
      this.draftVersion = row.draftVersion;
      return row;
    });
    if (!saved) return { draftVersion: this.draftVersion, updatedAt: null };
    this.broadcast({
      type: 'saved',
      draftVersion: saved.draftVersion,
      updatedAt: saved.updatedAt.toISOString(),
    });
    this.service.options.onDraftSaved?.(this.projectId, saved);
    return saved;
  }

  /**
   * Applies a whole-document change made through the REST API and saves the
   * draft immediately. `change` sees the document's current content.
   */
  async change<T>(
    change: (current: Timeline) => { doc: Timeline; result: T },
    expectedVersion?: number,
  ): Promise<{ result: T; draftVersion: number; updatedAt: Date }> {
    const before = await this.saveDraft();
    if (expectedVersion !== undefined && expectedVersion !== before.draftVersion) {
      const [current] = await this.db
        .select({
          draft: projects.draft,
          draftVersion: projects.draftVersion,
          updatedAt: projects.updatedAt,
        })
        .from(projects)
        .where(eq(projects.id, this.projectId))
        .limit(1);
      if (!current) throw notFound('Project');
      throw new DraftConflictError(current);
    }
    const { doc, result } = change(readTimeline(this.doc));
    const checked = checkTimeline(doc);
    if (!checked.ok) {
      throw badRequest('Timeline does not match the Chronicle schema', checked.issues);
    }
    const next = { ...checked.timeline, id: this.projectId };
    const size = Buffer.byteLength(JSON.stringify(next));
    if (size > this.service.options.maxDocBytes) {
      throw new ApiError(413, 'payload_too_large', 'The timeline is too large');
    }
    writeTimeline(this.doc, next, { origin: FROM_REST });
    const saved = await this.saveDraft();
    const [row] = await this.db
      .select({ updatedAt: projects.updatedAt })
      .from(projects)
      .where(eq(projects.id, this.projectId))
      .limit(1);
    return {
      result,
      draftVersion: saved.draftVersion,
      updatedAt: saved.updatedAt ?? row?.updatedAt ?? new Date(),
    };
  }

  /** Applies a Yjs update from the REST sync endpoint and stores it before returning. */
  async applyRestUpdate(update: Uint8Array): Promise<void> {
    try {
      Y.applyUpdate(this.doc, update, FROM_REST);
    } catch {
      throw badRequest('Malformed Yjs update');
    }
    await this.flush();
  }

  // --- Connections and presence -------------------------------------------

  join(conn: CollabConnection, expiresAt: number | null): void {
    this.cancelIdle();
    this.conns.add(conn);
    conn.send(encodeControl({ type: 'ready', role: conn.role, user: conn.user, expiresAt }));
    conn.send(encodeSyncStep1(Y.encodeStateVector(this.doc)));
    const others = [...this.awareness.getStates().keys()];
    if (others.length > 0) {
      conn.send(encodeAwareness(encodeAwarenessStates(this.awareness, others)));
    }
  }

  leave(conn: CollabConnection): void {
    if (!this.conns.delete(conn)) return;
    this.pendingAcks = this.pendingAcks.filter((a) => a.conn !== conn);
    const owned = [...conn.clientIds].filter((id) => this.awareness.getStates().has(id));
    if (owned.length > 0) removeAwarenessStates(this.awareness, owned, conn);
    if (this.conns.size === 0) this.scheduleIdle();
  }

  syncStep1(conn: CollabConnection, stateVector: Uint8Array): void {
    conn.send(encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, stateVector)));
  }

  /** Relays presence after replacing identity with the authenticated user. */
  receiveAwareness(conn: CollabConnection, update: Uint8Array): void {
    const entries = decodeAwarenessUpdate(update);
    const accepted = entries.flatMap((entry) => {
      if (!conn.clientIds.has(entry.clientId)) {
        const takenByOther = [...this.conns].some(
          (c) => c !== conn && c.clientIds.has(entry.clientId),
        );
        if (takenByOther || conn.clientIds.size >= MAX_AWARENESS_CLIENTS_PER_CONNECTION) return [];
        conn.clientIds.add(entry.clientId);
      }
      return [
        {
          clientId: entry.clientId,
          clock: entry.clock,
          state: entry.state === null ? null : sanitizePresence(entry.state, conn.user),
        },
      ];
    });
    if (accepted.length > 0) {
      applyAwarenessUpdate(this.awareness, encodeAwarenessUpdate(accepted), conn);
    }
  }

  private readonly onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;
    const frame = encodeAwareness(encodeAwarenessStates(this.awareness, changed));
    for (const conn of this.conns) if (conn !== origin) conn.send(frame);
  };

  broadcast(message: ServerControl): void {
    const frame = encodeControl(message);
    for (const conn of this.conns) conn.send(frame);
  }

  // --- Lifecycle ----------------------------------------------------------

  private scheduleIdle(): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.conns.size === 0) void this.service.unload(this);
    }, ROOM_IDLE_MS);
    this.idleTimer.unref();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Keeps the room loaded a little longer (used by REST calls). */
  touch(): void {
    if (this.conns.size === 0) this.scheduleIdle();
  }

  private handleStorageError(err: unknown, message: string): void {
    if (err instanceof ProjectGone || isFkViolation(err)) {
      // Deleted (possibly through another instance).
      void this.service.closeProject(this.projectId, CloseCode.NotFound, 'Project deleted');
      return;
    }
    this.service.options.log.error({ err, projectId: this.projectId }, message);
  }

  destroy(code: number, reason: string): void {
    this.closed = true;
    this.cancelIdle();
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const conn of [...this.conns]) conn.close(code, reason);
    this.conns.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

export class DraftConflictError extends ApiError {
  constructor(current: { draft: Timeline; draftVersion: number; updatedAt: Date }) {
    super(412, 'draft_conflict', 'The draft changed since you loaded it', {
      draftVersion: current.draftVersion,
      updatedAt: current.updatedAt.toISOString(),
      draft: current.draft,
    });
  }
}

export class CollabService {
  private readonly rooms = new Map<string, Promise<Room>>();
  private readonly loaded = new Map<string, Room>();
  private closing = false;

  constructor(readonly options: CollabOptions) {}

  /** The project's room, loading it (and its Yjs state) if needed. */
  room(projectId: string): Promise<Room> {
    if (this.closing) return Promise.reject(new ApiError(503, 'unavailable', 'Shutting down'));
    let pending = this.rooms.get(projectId);
    if (!pending) {
      const room = new Room(projectId, this);
      pending = room.load().then(
        () => {
          this.loaded.set(projectId, room);
          return room;
        },
        (err: unknown) => {
          this.rooms.delete(projectId);
          room.destroy(CloseCode.GoingAway, 'Load failed');
          throw err;
        },
      );
      this.rooms.set(projectId, pending);
    }
    return pending;
  }

  /** The room if it is loaded in this process. */
  peek(projectId: string): Room | undefined {
    return this.loaded.get(projectId);
  }

  connectionCount(filter: (conn: CollabConnection) => boolean): number {
    let n = 0;
    for (const room of this.loaded.values()) for (const c of room.conns) if (filter(c)) n++;
    return n;
  }

  /** Applies a REST change through the room (see `Room.change`). */
  async change<T>(
    projectId: string,
    change: (current: Timeline) => { doc: Timeline; result: T },
    expectedVersion?: number,
  ): Promise<{ result: T; draftVersion: number; updatedAt: Date }> {
    const room = await this.room(projectId);
    room.touch();
    return room.run(() => room.change(change, expectedVersion));
  }

  /** Makes `projects.draft` current if the project is open in this process. */
  async flush(projectId: string): Promise<void> {
    const room = this.loaded.get(projectId);
    if (room) await room.run(() => room.saveDraft());
  }

  /** The working copy as collaborators currently see it (may be invalid). */
  current(projectId: string): Timeline | null {
    const room = this.loaded.get(projectId);
    return room ? readTimeline(room.doc) : null;
  }

  broadcast(projectId: string, message: ServerControl): void {
    this.loaded.get(projectId)?.broadcast(message);
  }

  /** Closes every connection to a project and forgets its room (deleted project). */
  closeProject(projectId: string, code: number, reason: string): Promise<void> {
    const pending = this.rooms.get(projectId);
    this.rooms.delete(projectId);
    const room = this.loaded.get(projectId);
    this.loaded.delete(projectId);
    room?.destroy(code, reason);
    if (!room && pending) {
      return pending.then(
        (r) => {
          r.destroy(code, reason);
        },
        () => undefined,
      );
    }
    return Promise.resolve();
  }

  /** Re-checks one user's connections after their access to a project changed. */
  updateAccess(projectId: string, userId: string, role: Role | null): void {
    const room = this.loaded.get(projectId);
    if (!room) return;
    for (const conn of [...room.conns]) {
      if (conn.userId !== userId) continue;
      if (!role) {
        conn.close(CloseCode.Forbidden, 'Your access to this timeline was removed');
      } else if (conn.role !== role) {
        conn.role = role;
        conn.send(encodeControl({ type: 'role', role }));
      }
    }
  }

  /** Closes connections authenticated with a revoked API key. */
  revokeApiKey(apiKeyId: string): void {
    for (const room of this.loaded.values()) {
      for (const conn of [...room.conns]) {
        if (conn.apiKeyId === apiKeyId) conn.close(CloseCode.Unauthorized, 'API key revoked');
      }
    }
  }

  async unload(room: Room): Promise<void> {
    if (this.loaded.get(room.projectId) !== room || room.conns.size > 0) return;
    try {
      await room.run(() => room.saveDraft());
    } catch (err) {
      this.options.log.warn({ err, projectId: room.projectId }, 'final draft save failed');
    }
    if (room.conns.size > 0) return; // someone joined while saving
    this.loaded.delete(room.projectId);
    this.rooms.delete(room.projectId);
    room.destroy(CloseCode.GoingAway, 'Room closed');
  }

  /** Saves every open room and disconnects everyone (server shutdown). */
  async close(): Promise<void> {
    this.closing = true;
    const rooms = [...this.loaded.values()];
    await Promise.all(
      rooms.map(async (room) => {
        try {
          await room.run(() => room.saveDraft());
        } catch (err) {
          this.options.log.warn({ err, projectId: room.projectId }, 'final draft save failed');
        }
        room.destroy(CloseCode.GoingAway, 'Server shutting down');
      }),
    );
    this.loaded.clear();
    this.rooms.clear();
  }
}
