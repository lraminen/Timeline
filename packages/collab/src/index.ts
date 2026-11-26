/**
 * @chronicle/collab — real-time collaboration shared by the server and the editor.
 *
 * - `mapping`: how a timeline is represented as a Yjs document, and how to
 *   read it back or write a new version into it with minimal operations.
 * - `protocol`: the WebSocket wire format, control messages and presence.
 * - `client`: a reconnecting WebSocket client for browsers and Node.
 */
export {
  ROOTS,
  readTimeline,
  writeTimeline,
  encodeTimeline,
  isEmptyUpdate,
  jsonEqual,
  type WriteOptions,
} from './mapping.js';
export { diffText, type Splice } from './text-diff.js';
export {
  MessageType,
  CloseCode,
  ProtocolError,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdate,
  encodeAwareness,
  encodeControl,
  decodeMessage,
  decodeAwarenessUpdate,
  encodeAwarenessUpdate,
  sanitizePresence,
  presenceColor,
  PRESENCE_COLORS,
  toBase64,
  fromBase64,
  type DecodedMessage,
  type AwarenessEntry,
  type PresenceState,
  type PresenceUser,
  type Role,
  type ClientControl,
  type ServerControl,
  type CommentDto,
} from './protocol.js';
export {
  CollabClient,
  type CollabClientOptions,
  type CollabClientEvents,
  type ConnectionStatus,
  type WebSocketLike,
  type WebSocketConstructor,
} from './client.js';
export { Awareness } from 'y-protocols/awareness';
