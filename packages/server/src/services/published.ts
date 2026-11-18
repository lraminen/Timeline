import { and, eq } from 'drizzle-orm';
import type { Timeline } from '@chronicle/schema';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { projects, revisions } from '../db/schema.js';
import { notFound } from '../http.js';
import { verifyShareToken } from './share.js';

export interface PublishedTimeline {
  project: typeof projects.$inferSelect;
  version: number;
  timeline: Timeline;
  publishedAt: Date;
  /** True when the timeline is public (cacheable); false when reached via a share token. */
  isPublic: boolean;
}

/**
 * Resolves a published revision for public consumption. Every failure —
 * unknown slug, private without a valid token, never published, missing
 * version — is the same 404, so private timelines cannot be probed.
 */
export async function loadPublished(
  db: Db,
  config: Config,
  slug: string,
  options: { version?: number; token?: string },
): Promise<PublishedTimeline> {
  const [project] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
  if (!project) throw notFound('Timeline');
  if (!project.isPublic && !verifyShareToken(config, project, options.token))
    throw notFound('Timeline');

  const version = options.version ?? project.publishedVersion;
  if (!version) throw notFound('Timeline');
  const [revision] = await db
    .select()
    .from(revisions)
    .where(and(eq(revisions.projectId, project.id), eq(revisions.version, version)))
    .limit(1);
  if (!revision) throw notFound('Timeline');

  return {
    project,
    version,
    timeline: revision.timelineData,
    publishedAt: revision.createdAt,
    isPublic: project.isPublic,
  };
}
