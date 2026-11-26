import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

/**
 * Chronicle collaboration wire protocol (binary WebSocket frames).
 *
 * Every frame starts with a varuint message type:
 * - `0` sync: a y-protocols sync message (step 1 = state vector, step 2 =
 *   missing updates, update = incremental change).
 * - `1` awareness: a y-protocols awareness update (presence).
 * - `2` control: a JSON object, see {@link ClientControl} / {@link ServerControl}.
 *
 * Handshake: the client authenticates with `{type:'auth', token}` as its first
 * frame (browsers cannot set headers on WebSocket requests, and query strings
 * end up in logs). The server answers `ready` plus its sync step 1; the client
 * then sends its own step 1 and both sides exchange what the other lacks.
 * Every client frame carrying document data is acknowledged, in order, by a
 * cumulative `ack` once it is durably stored.
 */

export const MessageType = { Sync: 0, Awareness: 1, Control: 2 } as const;
const SyncStep = { Step1: 0, Step2: 1, Update: 2 } as const;

export type Role = 'owner' | 'editor' | 'viewer';

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** A comment as returned by the REST API and broadcast to collaborators. */
export interface CommentDto {
  id: string;
  projectId: string;
  eventId: string;
  /** Root comment of the thread; null for a root comment. */
  parentId: string | null;
  body: string;
  author: { id: string; name: string } | null;
  createdAt: string;
  editedAt: string | null;
  /** Only set on root comments. */
  resolvedAt: string | null;
  resolvedBy: { id: string; name: string } | null;
}

export interface ClientControl {
  type: 'auth';
  token: string;
}

export type ServerControl =
  | {
      type: 'ready';
      role: Role;
      user: PresenceUser;
      /** When the credential expires (ms since epoch); re-send `auth` before then. */
      expiresAt: number | null;
    }
  | { type: 'ack'; count: number }
  | { type: 'role'; role: Role }
  | { type: 'saved'; draftVersion: number; updatedAt: string }
  | { type: 'comment'; action: 'created' | 'updated' | 'deleted'; comment: CommentDto }
  | { type: 'error'; code: string; message: string };

/** WebSocket close codes used by the server. */
export const CloseCode = {
  /** Server shutting down; reconnect. */
  GoingAway: 1001,
  /** Bad credentials or the credential expired; get a new token and reconnect. */
  Unauthorized: 4001,
  /** Access was removed (or the origin is not allowed); don't reconnect. */
  Forbidden: 4003,
  /** The project does not exist (or was deleted); don't reconnect. */
  NotFound: 4004,
  /** A frame was too big, malformed, or too frequent; don't reconnect. */
  PolicyViolation: 4008,
  /** Too many open connections for this user or project; retry later. */
  TooManyConnections: 4029,
} as const;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function sync(step: number, payload: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MessageType.Sync);
  encoding.writeVarUint(e, step);
  encoding.writeVarUint8Array(e, payload);
  return encoding.toUint8Array(e);
}

export const encodeSyncStep1 = (stateVector: Uint8Array) => sync(SyncStep.Step1, stateVector);
export const encodeSyncStep2 = (update: Uint8Array) => sync(SyncStep.Step2, update);
export const encodeUpdate = (update: Uint8Array) => sync(SyncStep.Update, update);

export function encodeAwareness(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MessageType.Awareness);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}

export function encodeControl(message: ClientControl | ServerControl): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, MessageType.Control);
  encoding.writeVarString(e, JSON.stringify(message));
  return encoding.toUint8Array(e);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export type DecodedMessage =
  | { kind: 'sync-step1'; stateVector: Uint8Array }
  | { kind: 'sync-step2'; update: Uint8Array }
  | { kind: 'update'; update: Uint8Array }
  | { kind: 'awareness'; update: Uint8Array }
  | { kind: 'control'; message: unknown };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Decodes one frame. Throws {@link ProtocolError} for anything malformed. */
export function decodeMessage(data: Uint8Array): DecodedMessage {
  try {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    let result: DecodedMessage;
    if (type === MessageType.Sync) {
      const step = decoding.readVarUint(d);
      const payload = decoding.readVarUint8Array(d);
      if (step === SyncStep.Step1) result = { kind: 'sync-step1', stateVector: payload };
      else if (step === SyncStep.Step2) result = { kind: 'sync-step2', update: payload };
      else if (step === SyncStep.Update) result = { kind: 'update', update: payload };
      else throw new ProtocolError(`Unknown sync step ${String(step)}`);
    } else if (type === MessageType.Awareness) {
      result = { kind: 'awareness', update: decoding.readVarUint8Array(d) };
    } else if (type === MessageType.Control) {
      result = { kind: 'control', message: JSON.parse(decoding.readVarString(d)) as unknown };
    } else {
      throw new ProtocolError(`Unknown message type ${String(type)}`);
    }
    if (decoding.hasContent(d)) throw new ProtocolError('Trailing bytes after message');
    return result;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError('Malformed message');
  }
}

// ---------------------------------------------------------------------------
// Presence (awareness) entries
// ---------------------------------------------------------------------------

/** One entry of a y-protocols awareness update; `state: null` means "gone". */
export interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: unknown;
}

export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  try {
    const d = decoding.createDecoder(update);
    const count = decoding.readVarUint(d);
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(d);
      const clock = decoding.readVarUint(d);
      const state = JSON.parse(decoding.readVarString(d)) as unknown;
      entries.push({ clientId, clock, state });
    }
    if (decoding.hasContent(d)) throw new ProtocolError('Trailing bytes after awareness update');
    return entries;
  } catch (err) {
    if (err instanceof ProtocolError) throw err;
    throw new ProtocolError('Malformed awareness update');
  }
}

export function encodeAwarenessUpdate(entries: readonly AwarenessEntry[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(e, entry.clientId);
    encoding.writeVarUint(e, entry.clock);
    encoding.writeVarString(e, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(e);
}

/**
 * What one collaborator shares about themselves. `user` is always filled in
 * by the server from the authenticated account; whatever a client claims
 * there is discarded.
 */
export interface PresenceState {
  user: PresenceUser;
  /** The event the person has selected, if any. */
  eventId: string | null;
  /** The field they are editing (e.g. `title`, `body`, `date.start`). */
  field: string | null;
}

const FIELD = /^[A-Za-z][A-Za-z0-9.]{0,39}$/;

/** Builds the presence state the server relays: only known keys, bounded sizes. */
export function sanitizePresence(raw: unknown, user: PresenceUser): PresenceState {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const eventId =
    typeof r.eventId === 'string' && r.eventId.length > 0 && r.eventId.length <= 200
      ? r.eventId
      : null;
  const field = typeof r.field === 'string' && FIELD.test(r.field) ? r.field : null;
  return { user, eventId, field };
}

/**
 * Presence colours: dark enough for white text (WCAG AA, ≥ 4.5:1) and
 * visible as rings on a white or dark canvas.
 */
export const PRESENCE_COLORS = [
  '#1d4ed8',
  '#b91c1c',
  '#047857',
  '#7e22ce',
  '#b45309',
  '#be185d',
  '#0e7490',
  '#4d7c0f',
] as const;

/** A stable colour per user id. */
export function presenceColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length] ?? PRESENCE_COLORS[0];
}

// ---------------------------------------------------------------------------
// Binary helpers for the REST sync fallback (JSON bodies)
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
