import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Timeline } from '@chronicle/schema';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

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
