import { and, eq, sql } from 'drizzle-orm';
import { validateTimeline, type Timeline } from '@chronicle/schema';
import type { Db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { ApiError, badRequest } from '../http.js';
import { randomToken } from '../auth/crypto.js';

/** Validates a timeline document, returning the parsed (defaulted) value. */
export function validateDocument(input: unknown): Timeline {
  const result = validateTimeline(input);
  if (!result.success) {
    throw badRequest(
      'Timeline does not match the Chronicle schema',
      result.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Normalises a document for storage: its id is always the project id. */
export function normaliseForProject(doc: Timeline, projectId: string): Timeline {
  return { ...doc, id: projectId };
}

export function slugify(title: string): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'timeline';
  // A short random suffix keeps slugs unique without a lookup loop.
  return `${base}-${randomToken(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 6)
    .padEnd(6, '0')}`;
}

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])$/;

/** Version tag used for If-Match / ETag on drafts. */
export const etag = (version: number): string => `"${String(version)}"`;

export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  return m ? Number(m[1]) : null;
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

/**
 * Writes a draft only if it is still at `expectedVersion` (optimistic
 * concurrency, a single atomic UPDATE). On mismatch, throws a 412 that
 * carries the current server copy so the client can resolve the conflict.
 */
export async function writeDraft(
  db: Db,
  projectId: string,
  doc: Timeline,
  expectedVersion: number,
): Promise<{ draftVersion: number; updatedAt: Date }> {
  const normalised = normaliseForProject(doc, projectId);
  const [row] = await db
    .update(projects)
    .set({
      draft: normalised,
      title: normalised.title || 'Untitled timeline',
      draftVersion: sql`${projects.draftVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(projects.id, projectId), eq(projects.draftVersion, expectedVersion)))
    .returning({ draftVersion: projects.draftVersion, updatedAt: projects.updatedAt });
  if (row) return row;

  const [current] = await db
    .select({
      draft: projects.draft,
      draftVersion: projects.draftVersion,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!current) throw new ApiError(404, 'not_found', 'Project not found');
  throw new DraftConflictError(current);
}

/**
 * Applies a change to the current draft with automatic retry on concurrent
 * writes. Used by fine-grained endpoints (events) that don't require the
 * client to hold the whole document.
 */
export async function updateDraft<T>(
  db: Db,
  projectId: string,
  change: (doc: Timeline) => { doc: Timeline; result: T },
  attempts = 5,
): Promise<{ result: T; draftVersion: number }> {
  for (let i = 0; i < attempts; i++) {
    const [current] = await db
      .select({ draft: projects.draft, draftVersion: projects.draftVersion })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!current) throw new ApiError(404, 'not_found', 'Project not found');
    const { doc, result } = change(current.draft);
    const validated = validateDocument(doc);
    try {
      const written = await writeDraft(db, projectId, validated, current.draftVersion);
      return { result, draftVersion: written.draftVersion };
    } catch (err) {
      if (!(err instanceof DraftConflictError)) throw err;
    }
  }
  throw new ApiError(409, 'busy', 'The draft is being edited heavily; please retry');
}
