import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { Timeline } from '@chronicle/schema';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** Binary column (Yjs state and updates). PGlite returns Uint8Array; node-postgres a Buffer (a subclass). */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stored lower-cased; unique. */
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** URL-safe, globally unique; used by public pages and embeds. */
    slug: text('slug').notNull().unique(),
    /** Working copy edited by the editor. Always schema-valid. */
    draft: jsonb('draft').$type<Timeline>().notNull(),
    /** Incremented on every draft write; clients send it back for conflict detection. */
    draftVersion: integer('draft_version').notNull().default(1),
    isPublic: boolean('is_public').notNull().default(false),
    /** Mixed into share-link signatures; rotating it revokes every link at once. */
    shareNonce: uuid('share_nonce').notNull().defaultRandom(),
    /** Latest published revision number (null = never published). */
    publishedVersion: integer('published_version'),
    /**
     * Collaborative (Yjs) state, compacted: every `collab_updates` row up to
     * `ydoc_seq` is folded in. Null until the project is first opened for
     * collaboration; it is then built from `draft`.
     */
    ydoc: bytea('ydoc'),
    ydocSeq: bigint('ydoc_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('projects_owner_idx').on(t.ownerId)],
);

/** Immutable published snapshots. Rollback publishes a copy as a new version. */
export const revisions = pgTable(
  'revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    version: integer('version').notNull(),
    timelineData: jsonb('timeline_data').$type<Timeline>().notNull(),
    commitMessage: text('commit_message'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('revisions_project_version_idx').on(t.projectId, t.version)],
);

export const collaboratorRole = pgEnum('collaborator_role', ['editor', 'viewer']);

export const collaborators = pgTable(
  'collaborators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: collaboratorRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('collaborators_project_user_idx').on(t.projectId, t.userId)],
);

export interface MediaVariant {
  key: string;
  mimeType: string;
  width?: number;
  height?: number;
  sizeBytes: number;
}

export interface MediaMetadata {
  kind: 'image' | 'video' | 'audio';
  width?: number;
  height?: number;
  /** Image renditions: `display` (WebP), `display_avif`, `thumb` (WebP). */
  variants: Record<string, MediaVariant>;
}

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id').references(() => users.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    /** Storage key of the primary (served) file. */
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    metadata: jsonb('metadata').$type<MediaMetadata>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('media_project_idx').on(t.projectId)],
);

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Public lookup part of the key (`chr_<prefix>_…`). */
  prefix: text('prefix').notNull().unique(),
  /** SHA-256 of the full key; the key itself is shown once and never stored. */
  keyHash: text('key_hash').notNull(),
  label: text('label').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/**
 * Opaque refresh tokens (stored hashed). Tokens rotate on every use; all
 * tokens issued from one login share a `familyId`, so presenting an already
 * rotated token (a sign of theft) revokes the whole family.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_family_idx').on(t.familyId)],
);

/**
 * Append-only audit trail of security-relevant actions. No foreign keys:
 * entries must outlive the users and projects they mention.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    projectId: uuid('project_id'),
    ip: text('ip'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_project_idx').on(t.projectId, t.createdAt),
    index('audit_actor_idx').on(t.actorId, t.createdAt),
  ],
);

/**
 * Per-request AI token and cost tracking for budget enforcement and quotas.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    operation: text('operation').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull().default('completed'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_usage_user_idx').on(t.userId, t.createdAt),
    index('ai_usage_project_idx').on(t.projectId, t.createdAt),
  ],
);

/**
 * One row per data migration that has run (see `db/data-migrations.ts`).
 * Schema changes live in drizzle SQL migrations; this table guards one-off
 * rewrites of stored documents so each runs once.
 */
export const dataMigrations = pgTable('data_migrations', {
  name: text('name').primaryKey(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
});

/**
 * Append-only log of Yjs updates per project, folded into `projects.ydoc`
 * from time to time. Writers hold a per-project advisory lock, so sequence
 * numbers commit in order and any server instance can catch up by reading
 * the rows after the last one it has seen.
 */
export const collabUpdates = pgTable(
  'collab_updates',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    data: bytea('data').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('collab_updates_project_seq_idx').on(t.projectId, t.seq)],
);

/**
 * Threaded comments on events. A thread is a root comment (`parent_id` null)
 * plus its replies; only roots can be resolved, and deleting a root deletes
 * its replies. `event_id` is not a foreign key: events live inside the
 * document, and comments on a deleted event are kept (an undo may restore it).
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'cascade',
    }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('comments_project_event_idx').on(t.projectId, t.eventId, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
  ],
);

export const WEBHOOK_EVENTS = [
  'timeline.published',
  'draft.updated',
  'comment.created',
  'comment.updated',
  'comment.deleted',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number] | 'ping';

/**
 * Outgoing webhooks. The signing secret must be usable for signing, so it is
 * stored encrypted (AES-256-GCM with a key derived from JWT_SECRET) rather
 * than hashed, and shown to the owner only when created or rotated.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    events: jsonb('events').$type<WebhookEventType[]>().notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    active: boolean('active').notNull().default(true),
    /** Why the webhook was switched off automatically (repeated failures). */
    disabledReason: text('disabled_reason'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('webhooks_project_idx').on(t.projectId)],
);

export type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed';

/** One row per message per webhook. The payload is fixed, so retries send identical bytes. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    /** Standard Webhooks message id (`webhook-id` header); the same on every retry. */
    messageId: text('message_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    status: text('status').$type<DeliveryStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
  ],
);
