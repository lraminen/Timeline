import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import { z } from 'zod';
import {
  CloseCode,
  decodeMessage,
  encodeControl,
  fromBase64,
  isEmptyUpdate,
  presenceColor,
  ProtocolError,
  toBase64,
  type DecodedMessage,
  type Role,
} from '@chronicle/collab';
import { users } from '../db/schema.js';
import { ApiError, forbidden, parse, UuidParam } from '../http.js';
import { requireAuth } from '../app.js';
import { isApiKeyFormat, verifyAccessTokenClaims, verifyApiKey } from '../auth/sessions.js';
import { requireProjectRole } from '../services/access.js';
import type { CollabConnection, Room } from '../services/collab.js';

/** Time a client has to authenticate after connecting. */
const AUTH_TIMEOUT_MS = 10_000;

const SyncBody = z.object({
  /** The client's Yjs state vector (base64); omitted = send everything. */
  stateVector: z.string().max(1_000_000).optional(),
  /** Changes the server may not have yet (base64 Yjs update). */
  update: z.string().optional(),
});

const AuthMessage = z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) });

const asBytes = (data: unknown): Uint8Array | null => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  return null;
};

export const collabRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, collab } = app.ctx;
  const allowedOrigins = new Set(config.CORS_ORIGINS);

  /**
   * Live collaboration over WebSocket (see `@chronicle/collab` protocol).
   * The first frame must be `{type:'auth', token}` with an access token or
   * API key. Browsers always send Origin, which must be an editor origin.
   */
  app.get('/projects/:id/collab', { websocket: true }, (socket: WebSocket, request) => {
    const params = UuidParam.safeParse(request.params);
    const origin = request.headers.origin;
    if (!params.success) {
      socket.close(CloseCode.NotFound, 'Project not found');
      return;
    }
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      socket.close(CloseCode.Forbidden, 'Origin not allowed');
      return;
    }
    const projectId = params.data.id;
    let conn: CollabConnection | null = null;
    let room: Room | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let windowStart = Date.now();
    let messagesInWindow = 0;
    let closed = false;

    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      socket.close(code, reason.slice(0, 120));
    };
    const authTimer = setTimeout(() => {
      close(CloseCode.Unauthorized, 'Authentication timed out');
    }, AUTH_TIMEOUT_MS);

    const armExpiry = (expiresAt: number | null) => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
      if (expiresAt === null) return;
      expiryTimer = setTimeout(
        () => {
          close(CloseCode.Unauthorized, 'Session expired');
        },
        Math.max(0, expiresAt - Date.now()),
      );
    };

    /** Verifies a credential: `{ userId, expiresAt, apiKeyId? }` or null. */
    const verify = async (token: string) => {
      if (isApiKeyFormat(token)) {
        const key = await verifyApiKey(db, token);
        return key ? { userId: key.userId, expiresAt: null, apiKeyId: key.keyId } : null;
      }
      const claims = await verifyAccessTokenClaims(config, token);
      return claims ? { ...claims, apiKeyId: undefined } : null;
    };

    const authenticate = async (message: unknown) => {
      const auth = AuthMessage.safeParse(message);
      if (!auth.success) {
        close(CloseCode.Unauthorized, 'Authenticate first');
        return;
      }
      const identity = await verify(auth.data.token);
      if (!identity) {
        close(CloseCode.Unauthorized, 'Invalid or expired credentials');
        return;
      }

      if (conn) {
        // Re-authentication on an open connection extends it.
        if (identity.userId !== conn.userId) {
          close(CloseCode.Unauthorized, 'Credentials belong to another user');
          return;
        }
        armExpiry(identity.expiresAt);
        conn.send(
          encodeControl({
            type: 'ready',
            role: conn.role,
            user: conn.user,
            expiresAt: identity.expiresAt,
          }),
        );
        return;
      }

      let role: Role;
      try {
        role = (await requireProjectRole(db, projectId, identity.userId, 'viewer')).role;
      } catch {
        close(CloseCode.NotFound, 'Project not found');
        return;
      }
      if (
        collab.connectionCount((c) => c.userId === identity.userId) >=
        config.COLLAB_MAX_CONNECTIONS_PER_USER
      ) {
        close(CloseCode.TooManyConnections, 'Too many open connections');
        return;
      }
      const [user] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, identity.userId))
        .limit(1);
      if (!user) {
        close(CloseCode.Unauthorized, 'Unknown user');
        return;
      }
      const joined = await collab.room(projectId);
      if (closed) return;
      if (joined.conns.size >= config.COLLAB_MAX_CONNECTIONS_PER_PROJECT) {
        close(CloseCode.TooManyConnections, 'Too many people are connected to this timeline');
        return;
      }
      clearTimeout(authTimer);
      armExpiry(identity.expiresAt);
      room = joined;
      conn = {
        id: randomUUID(),
        userId: identity.userId,
        role,
        user: { id: identity.userId, name: user.name, color: presenceColor(identity.userId) },
        apiKeyId: identity.apiKeyId,
        received: 0,
        clientIds: new Set(),
        send: (frame) => {
          if (socket.readyState === socket.OPEN) socket.send(frame);
        },
        close,
      };
      joined.join(conn, identity.expiresAt);
    };

    const handle = async (message: DecodedMessage) => {
      if (message.kind === 'control') {
        await authenticate(message.message);
        return;
      }
      if (!conn || !room) {
        close(CloseCode.Unauthorized, 'Authenticate first');
        return;
      }
      switch (message.kind) {
        case 'sync-step1':
          room.syncStep1(conn, message.stateVector);
          break;
        case 'sync-step2':
        case 'update':
          if (conn.role === 'viewer') {
            let empty: boolean;
            try {
              empty = isEmptyUpdate(message.update);
            } catch {
              throw new ProtocolError('Malformed document update');
            }
            if (!empty) {
              conn.send(
                encodeControl({
                  type: 'error',
                  code: 'read_only',
                  message: 'You have view-only access; your changes were not saved',
                }),
              );
            }
            return;
          }
          if (room.wouldExceedLimit(message.update)) {
            close(CloseCode.PolicyViolation, 'The timeline is too large');
            return;
          }
          room.receive(conn, message.update);
          break;
        case 'awareness':
          room.receiveAwareness(conn, message.update);
          break;
      }
    };

    // Frames are handled strictly in order (authentication is asynchronous).
    let chain: Promise<void> = Promise.resolve();
    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (closed) return;
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        messagesInWindow = 0;
      }
      if (++messagesInWindow > config.COLLAB_MAX_MESSAGES_PER_SECOND) {
        close(CloseCode.PolicyViolation, 'Too many messages');
        return;
      }
      const bytes = isBinary ? asBytes(data) : null;
      if (!bytes) {
        close(CloseCode.PolicyViolation, 'Binary frames only');
        return;
      }
      chain = chain.then(async () => {
        if (closed) return;
        try {
          await handle(decodeMessage(bytes));
        } catch (err) {
          if (err instanceof ProtocolError) {
            close(CloseCode.PolicyViolation, err.message);
          } else {
            request.log.error({ err, projectId }, 'collab message failed');
            close(1011, 'Server error');
          }
        }
      });
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(authTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      if (conn && room) room.leave(conn);
    });
    socket.on('error', () => {
      close(1011, 'Socket error');
    });
  });

  /**
   * Sync over plain HTTP, for clients that cannot keep a WebSocket open (and
   * for scripts): send your state vector and any changes, get back what you
   * lack. Changes are stored before the response is sent.
   */
  app.post('/projects/:id/sync', async (request) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { role } = await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const body = parse(SyncBody, request.body ?? {});
    let stateVector: Uint8Array | undefined;
    let update: Uint8Array | null = null;
    try {
      stateVector = body.stateVector ? fromBase64(body.stateVector) : undefined;
      update = body.update ? fromBase64(body.update) : null;
      if (update && isEmptyUpdate(update)) update = null;
      if (stateVector) Y.decodeStateVector(stateVector);
    } catch {
      throw new ApiError(400, 'bad_request', 'Malformed Yjs data');
    }
    const room = await collab.room(id);
    room.touch();
    if (update) {
      if (role === 'viewer') throw forbidden('You have view-only access to this timeline');
      if (room.wouldExceedLimit(update)) {
        throw new ApiError(413, 'payload_too_large', 'The timeline is too large');
      }
      const bytes = update;
      await room.run(() => room.applyRestUpdate(bytes));
    }
    return {
      role,
      update: toBase64(Y.encodeStateAsUpdate(room.doc, stateVector)),
      stateVector: toBase64(Y.encodeStateVector(room.doc)),
      draftVersion: room.draftVersion,
      problems: room.problems,
    };
  });
};
