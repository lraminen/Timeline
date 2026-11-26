import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Timeline } from '@chronicle/schema';
import { CollabClient, type WebSocketLike } from '../client.js';
import { encodeTimeline, readTimeline, writeTimeline } from '../mapping.js';
import {
  decodeAwarenessUpdate,
  decodeMessage,
  encodeAwarenessUpdate,
  encodeControl,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  fromBase64,
  presenceColor,
  PRESENCE_COLORS,
  ProtocolError,
  sanitizePresence,
  toBase64,
  type ServerControl,
} from '../protocol.js';

describe('protocol', () => {
  it('round-trips every message kind', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(decodeMessage(encodeSyncStep1(bytes))).toEqual({
      kind: 'sync-step1',
      stateVector: bytes,
    });
    expect(decodeMessage(encodeSyncStep2(bytes))).toEqual({ kind: 'sync-step2', update: bytes });
    expect(decodeMessage(encodeUpdate(bytes))).toEqual({ kind: 'update', update: bytes });
    expect(decodeMessage(encodeControl({ type: 'auth', token: 't' }))).toEqual({
      kind: 'control',
      message: { type: 'auth', token: 't' },
    });
  });

  it('rejects malformed frames', () => {
    expect(() => decodeMessage(new Uint8Array([]))).toThrow(ProtocolError);
    expect(() => decodeMessage(new Uint8Array([9, 0]))).toThrow(ProtocolError);
    expect(() => decodeMessage(new Uint8Array([0, 7, 0]))).toThrow(ProtocolError);
    expect(() => decodeMessage(new Uint8Array([0, 0, 5, 1]))).toThrow(ProtocolError);
    const trailing = new Uint8Array([...encodeUpdate(new Uint8Array([1])), 0]);
    expect(() => decodeMessage(trailing)).toThrow(ProtocolError);
    // Control frame with invalid JSON.
    expect(() => decodeMessage(new Uint8Array([2, 1, 123]))).toThrow(ProtocolError);
  });

  it('round-trips awareness entries', () => {
    const entries = [
      { clientId: 7, clock: 3, state: { eventId: 'a' } },
      { clientId: 9, clock: 1, state: null },
    ];
    expect(decodeAwarenessUpdate(encodeAwarenessUpdate(entries))).toEqual(entries);
    expect(() => decodeAwarenessUpdate(new Uint8Array([5]))).toThrow(ProtocolError);
  });

  it('sanitises presence: the server-supplied user always wins', () => {
    const user = { id: 'u1', name: 'Ada', color: '#1d4ed8' };
    expect(
      sanitizePresence(
        {
          user: { id: 'admin', name: 'Spoofed' },
          eventId: 'e1',
          field: 'date.start',
          extra: 'x'.repeat(10_000),
        },
        user,
      ),
    ).toEqual({ user, eventId: 'e1', field: 'date.start' });
    expect(sanitizePresence({ eventId: 'x'.repeat(201), field: '<script>' }, user)).toEqual({
      user,
      eventId: null,
      field: null,
    });
    expect(sanitizePresence('junk', user)).toEqual({ user, eventId: null, field: null });
  });

  it('assigns stable presence colours from the palette', () => {
    expect(presenceColor('abc')).toBe(presenceColor('abc'));
    expect(PRESENCE_COLORS).toContain(presenceColor('some-user-id'));
  });

  it('base64-encodes binary data', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

// ---------------------------------------------------------------------------
// Client against an in-memory server that speaks the protocol.
// ---------------------------------------------------------------------------

const timeline = {
  schemaVersion: '1.0.0',
  id: 'p',
  title: 'Shared',
  settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  eras: [],
  events: [{ id: 'e1', title: 'One', date: { start: '2000' }, media: [], tags: [] }],
} as unknown as Timeline;

class FakeServer {
  readonly doc = new Y.Doc();
  sockets: FakeSocket[] = [];
  received = 0;
  role: 'editor' | 'viewer' = 'editor';
  autoAck = true;
  constructor() {
    Y.applyUpdate(this.doc, encodeTimeline(timeline));
  }
  handle(socket: FakeSocket, data: Uint8Array): void {
    const m = decodeMessage(data);
    if (m.kind === 'control') {
      socket.deliver(
        encodeControl({
          type: 'ready',
          role: this.role,
          user: { id: 'u', name: 'U', color: '#000' },
          expiresAt: null,
        }),
      );
      socket.deliver(encodeSyncStep1(Y.encodeStateVector(this.doc)));
    } else if (m.kind === 'sync-step1') {
      socket.deliver(encodeSyncStep2(Y.encodeStateAsUpdate(this.doc, m.stateVector)));
    } else if (m.kind === 'sync-step2' || m.kind === 'update') {
      Y.applyUpdate(this.doc, m.update);
      this.received++;
      if (this.autoAck) socket.deliver(encodeControl({ type: 'ack', count: this.received }));
    }
  }
}

class FakeSocket implements WebSocketLike {
  static server: FakeServer;
  binaryType = 'blob';
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.server.sockets.push(this);
    FakeSocket.server.received = 0;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: Uint8Array): void {
    const copy = new Uint8Array(data);
    queueMicrotask(() => {
      FakeSocket.server.handle(this, copy);
    });
  }
  deliver(data: Uint8Array): void {
    queueMicrotask(() => this.onmessage?.({ data: data.buffer.slice(0) }));
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('CollabClient', () => {
  let client: CollabClient | null = null;
  afterEach(() => {
    client?.destroy();
    client = null;
    vi.useRealTimers();
  });

  function start(doc = new Y.Doc(), pending = false): CollabClient {
    client = new CollabClient({
      url: 'ws://test',
      doc,
      getToken: () => Promise.resolve('token'),
      WebSocket: FakeSocket,
      pending,
    });
    return client;
  }

  it('authenticates, receives the document and sends local edits', async () => {
    FakeSocket.server = new FakeServer();
    const doc = new Y.Doc();
    const c = start(doc);
    const statuses: string[] = [];
    c.on('status', (s) => statuses.push(s));
    let synced = false;
    c.on('synced', () => (synced = true));
    c.connect();
    await flush();
    expect(statuses).toEqual(['connecting', 'connected']);
    expect(synced).toBe(true);
    expect(c.role).toBe('editor');
    expect(readTimeline(doc).title).toBe('Shared');

    const pendingChanges: boolean[] = [];
    c.on('pending', (p) => pendingChanges.push(p));
    writeTimeline(doc, { ...readTimeline(doc), title: 'Shared timeline' });
    expect(c.pending).toBe(true);
    await flush();
    expect(c.pending).toBe(false);
    expect(pendingChanges).toEqual([true, false]);
    expect(readTimeline(FakeSocket.server.doc).title).toBe('Shared timeline');
  });

  it('keeps offline edits and sends them on reconnect', async () => {
    FakeSocket.server = new FakeServer();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(FakeSocket.server.doc));
    writeTimeline(doc, { ...readTimeline(doc), title: 'Edited offline' });
    // Meanwhile someone else changed an event on the server.
    writeTimeline(FakeSocket.server.doc, {
      ...readTimeline(FakeSocket.server.doc),
      events: [{ id: 'e1', title: 'One!', date: { start: '2000' }, media: [], tags: [] }],
    });

    const c = start(doc, true);
    expect(c.pending).toBe(true);
    c.connect();
    await flush();
    expect(c.pending).toBe(false);
    const server = readTimeline(FakeSocket.server.doc);
    expect(server.title).toBe('Edited offline');
    expect(server.events[0]?.title).toBe('One!');
    expect(readTimeline(doc)).toEqual(server);
  });

  it('stays pending until the server acknowledges', async () => {
    FakeSocket.server = new FakeServer();
    FakeSocket.server.autoAck = false;
    const doc = new Y.Doc();
    const c = start(doc);
    c.connect();
    await flush();
    writeTimeline(doc, { ...readTimeline(doc), title: 'Unacked' });
    await flush();
    expect(c.pending).toBe(true);
    // The connection drops before the ack: the change counts as unsent again.
    FakeSocket.server.sockets.at(-1)?.close(1006, 'network');
    await flush();
    expect(c.pending).toBe(true);
    expect(c.status).toBe('reconnecting');
  });

  it('does not send edits as a viewer', async () => {
    FakeSocket.server = new FakeServer();
    FakeSocket.server.role = 'viewer';
    const doc = new Y.Doc();
    const c = start(doc);
    c.connect();
    await flush();
    writeTimeline(doc, { ...readTimeline(doc), title: 'Local only' });
    await flush();
    expect(c.readOnly).toBe(true);
    expect(readTimeline(FakeSocket.server.doc).title).toBe('Shared');
  });

  it('stops reconnecting when access is removed', async () => {
    FakeSocket.server = new FakeServer();
    const c = start();
    c.connect();
    await flush();
    FakeSocket.server.sockets.at(-1)?.close(4003, 'Access removed');
    await flush();
    expect(c.status).toBe('closed');
    expect(c.closeReason).toEqual({ code: 4003, reason: 'Access removed' });
  });

  it('reconnects with backoff after a network drop', async () => {
    vi.useFakeTimers();
    FakeSocket.server = new FakeServer();
    const c = start();
    c.connect();
    await vi.runOnlyPendingTimersAsync();
    expect(c.status).toBe('connected');
    FakeSocket.server.sockets.at(-1)?.close(1006, '');
    await flush();
    expect(c.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.status).toBe('connected');
    expect(FakeSocket.server.sockets).toHaveLength(2);
  });

  it('forwards other server messages', async () => {
    FakeSocket.server = new FakeServer();
    const c = start();
    const messages: ServerControl[] = [];
    c.on('message', (m) => messages.push(m));
    c.connect();
    await flush();
    FakeSocket.server.sockets[0]?.deliver(
      encodeControl({ type: 'saved', draftVersion: 3, updatedAt: 'now' }),
    );
    await flush();
    expect(messages).toEqual([{ type: 'saved', draftVersion: 3, updatedAt: 'now' }]);
  });
});
