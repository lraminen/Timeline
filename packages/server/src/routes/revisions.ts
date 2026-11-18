import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import type { Timeline } from '@chronicle/schema';
import type { Db } from '../db/client.js';
import { projects, revisions, users } from '../db/schema.js';
import { ApiError, notFound, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole } from '../services/access.js';
import { audit } from '../services/audit.js';
import { etag, validateDocument, writeDraft } from '../services/documents.js';

const VersionParams = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive(),
});
const PublishBody = z.object({ message: z.string().trim().max(500).optional() });

/**
 * Inserts the next revision. The unique (project, version) index makes
 * concurrent publishes safe: a loser retries with the next number.
 */
async function insertRevision(
  db: Db,
  projectId: string,
  authorId: string,
  data: Timeline,
  message: string | undefined,
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [row] = await db
      .select({ latest: max(revisions.version) })
      .from(revisions)
      .where(eq(revisions.projectId, projectId));
    const version = (row?.latest ?? 0) + 1;
    try {
      await db
        .insert(revisions)
        .values({ projectId, authorId, version, timelineData: data, commitMessage: message });
      await db
        .update(projects)
        .set({ publishedVersion: version })
        .where(eq(projects.id, projectId));
      return version;
    } catch (err) {
      // 23505 = unique_violation (both drivers expose the Postgres code).
      if ((err as { code?: string }).code !== '23505') throw err;
    }
  }
  throw new ApiError(409, 'busy', 'Could not publish; please retry');
}

export const revisionRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/projects/:id/revisions', async (request) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const rows = await db
      .select({
        version: revisions.version,
        message: revisions.commitMessage,
        createdAt: revisions.createdAt,
        authorId: revisions.authorId,
        authorName: users.name,
      })
      .from(revisions)
      .leftJoin(users, eq(users.id, revisions.authorId))
      .where(eq(revisions.projectId, id))
      .orderBy(desc(revisions.version));
    return {
      revisions: rows.map((r) => ({
        version: r.version,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
        author: r.authorId ? { id: r.authorId, name: r.authorName } : null,
      })),
    };
  });

  app.get('/projects/:id/revisions/:version', async (request) => {
    const { id, version } = parse(VersionParams, request.params, 'path');
    await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const [row] = await db
      .select()
      .from(revisions)
      .where(and(eq(revisions.projectId, id), eq(revisions.version, version)))
      .limit(1);
    if (!row) throw notFound('Revision');
    return {
      version: row.version,
      message: row.commitMessage,
      createdAt: row.createdAt.toISOString(),
      timeline: row.timelineData,
    };
  });

  /** Publish: snapshot the current draft as the next revision. */
  app.post('/projects/:id/revisions', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    const { userId } = requireAuth(request);
    const { project } = await requireProjectRole(db, id, userId, 'editor');
    const { message } = parse(PublishBody, request.body ?? {});
    // Re-validate: an export/publish must always be loadable.
    const data = validateDocument(project.draft);
    const version = await insertRevision(db, id, userId, data, message);
    await audit(
      db,
      {
        action: 'project.publish',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { version },
      },
      request.log,
    );
    return reply.status(201).send({ version, publishedFromDraftVersion: project.draftVersion });
  });

  /**
   * Rollback: republish an earlier revision as a new version (history stays
   * immutable) and reset the draft to it.
   */
  app.post('/projects/:id/rollback/:version', async (request, reply) => {
    const { id, version } = parse(VersionParams, request.params, 'path');
    const { userId } = requireAuth(request);
    const { project } = await requireProjectRole(db, id, userId, 'editor');
    const [target] = await db
      .select()
      .from(revisions)
      .where(and(eq(revisions.projectId, id), eq(revisions.version, version)))
      .limit(1);
    if (!target) throw notFound('Revision');

    const newVersion = await insertRevision(
      db,
      id,
      userId,
      target.timelineData,
      `Rollback to version ${String(version)}`,
    );
    const written = await writeDraft(db, id, target.timelineData, project.draftVersion);
    await audit(
      db,
      {
        action: 'project.rollback',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { from: version, version: newVersion },
      },
      request.log,
    );
    void reply.header('etag', etag(written.draftVersion));
    return reply.status(201).send({ version: newVersion, draftVersion: written.draftVersion });
  });
};
