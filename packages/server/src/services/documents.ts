import { repairTimelineDates, validateTimeline, type Timeline } from '@chronicle/schema';
import { badRequest } from '../http.js';
import { randomToken } from '../auth/crypto.js';

/**
 * Validates a timeline document, returning the parsed (defaulted) value.
 * Date forms written by older releases are migrated first, so API clients and
 * files that predate calendar validation keep working; the canonical form is stored.
 */
export function validateDocument(input: unknown): Timeline {
  const result = validateTimeline(repairTimelineDates(input).timeline);
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

export { DraftConflictError } from './collab.js';
