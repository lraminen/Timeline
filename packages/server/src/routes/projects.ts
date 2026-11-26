import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { validateEvent, type Timeline, type TimelineEvent } from '@chronicle/schema';
import { auditLog, collaborators, media, projects, users } from '../db/schema.js';
import { ApiError, conflict, forbidden, notFound, one, parse, UuidParam } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole, type Role } from '../services/access.js';
import { audit } from '../services/audit.js';
import { CloseCode } from '@chronicle/collab';
import { etag, parseIfMatch, slugify, SLUG, validateDocument } from '../services/documents.js';
import { createShareToken } from '../services/share.js';

const CreateBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  /** Optional initial document (e.g. an editor draft being uploaded). */
  timeline: z.unknown().optional(),
});

const PatchBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    slug: z.string().regex(SLUG, 'Use 3–80 lowercase letters, digits and hyphens').optional(),
    isPublic: z.boolean().optional(),
  })
  .strict();

const EventParams = z.object({ id: z.string().uuid(), eventId: z.string().min(1).max(200) });

const ShareBody = z.object({
  expiresInHours: z
    .number()
    .int()
    .positive()
    .max(24 * 90)
    .default(24 * 7),
});

function blankTimeline(id: string, title: string): Timeline {
  return {
    schemaVersion: '1.0.0',
    id,
    title,
    events: [],
    eras: [],
    settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  };
}

type ProjectRow = typeof projects.$inferSelect;

function summary(p: ProjectRow, role: Role) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    role,
    isPublic: p.isPublic,
    draftVersion: p.draftVersion,
    publishedVersion: p.publishedVersion,
    eventCount: p.draft.events.length,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  const { db, config, storage, cdn, collab } = app.ctx;

  /**
   * The project row with an up-to-date draft: live edits held by this
   * instance's collaboration room are saved first.
   */
  async function withFreshDraft(project: ProjectRow): Promise<ProjectRow> {
    if (!collab.peek(project.id)) return project;
    await collab.flush(project.id);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id)).limit(1);
    if (!row) throw notFound('Project');
    return row;
  }

  app.get('/projects', async (request) => {
    const { userId } = requireAuth(request);
    const shared = db
      .select({ projectId: collaborators.projectId })
      .from(collaborators)
      .where(eq(collaborators.userId, userId));
    const list = () =>
      db
        .select()
        .from(projects)
        .where(or(eq(projects.ownerId, userId), inArray(projects.id, shared)))
        .orderBy(desc(projects.updatedAt));
    let rows = await list();
    // Titles and counts of timelines being edited live: save them first.
    const open = rows.filter((p) => collab.peek(p.id));
    if (open.length > 0) {
      await Promise.all(open.map((p) => collab.flush(p.id)));
      rows = await list();
    }
    const roles = new Map(
      (
        await db
          .select({ projectId: collaborators.projectId, role: collaborators.role })
          .from(collaborators)
          .where(eq(collaborators.userId, userId))
      ).map((r) => [r.projectId, r.role as Role]),
    );
    return {
      projects: rows.map((p) =>
        summary(p, p.ownerId === userId ? 'owner' : (roles.get(p.id) ?? 'viewer')),
      ),
    };
  });

  app.post('/projects', async (request, reply) => {
    const { userId } = requireAuth(request);
    const body = parse(CreateBody, request.body ?? {});
    const id = randomUUID();
    const doc =
      body.timeline !== undefined
        ? { ...validateDocument(body.timeline), id }
        : blankTimeline(id, body.title ?? 'Untitled timeline');
    if (body.title) doc.title = body.title;

    const [project] = await db
      .insert(projects)
      .values({
        id,
        ownerId: userId,
        title: doc.title || 'Untitled timeline',
        slug: slugify(doc.title),
        draft: doc,
      })
      .returning();
    if (!project) throw new Error('Project insert returned no row');
    await audit(
      db,
      { action: 'project.create', actorId: userId, projectId: id, ip: request.ip },
      request.log,
    );
    void reply.header('etag', etag(project.draftVersion));
    return reply.status(201).send(summary(project, 'owner'));
  });

  app.get('/projects/:id', async (request) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { project, role } = await requireProjectRole(
      db,
      id,
      requireAuth(request).userId,
      'viewer',
    );
    return summary(await withFreshDraft(project), role);
  });

  app.patch('/projects/:id', async (request) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { userId } = requireAuth(request);
    const body = parse(PatchBody, request.body);
    const ownerOnly = body.slug !== undefined || body.isPublic !== undefined;
    const { project, role } = await requireProjectRole(
      db,
      id,
      userId,
      ownerOnly ? 'owner' : 'editor',
    );

    if (body.slug && body.slug !== project.slug) {
      const [taken] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.slug, body.slug))
        .limit(1);
      if (taken) throw conflict('That address is already in use');
    }

    const changes: Partial<ProjectRow> = { updatedAt: new Date() };
    if (body.slug) changes.slug = body.slug;
    if (body.isPublic !== undefined) changes.isPublic = body.isPublic;
    if (body.title) {
      // Title lives in the document too; keep both in sync.
      await collab.change(id, (doc) => ({
        doc: { ...doc, title: body.title ?? doc.title },
        result: null,
      }));
    }
    // The project may have been deleted concurrently.
    const updated = one(
      await db.update(projects).set(changes).where(eq(projects.id, id)).returning(),
      'Project',
    );

    if (body.isPublic !== undefined && body.isPublic !== project.isPublic) {
      await audit(
        db,
        {
          action: 'project.visibility_change',
          actorId: userId,
          projectId: id,
          ip: request.ip,
          metadata: { isPublic: body.isPublic },
        },
        request.log,
      );
    }
    if (body.slug && body.slug !== project.slug) {
      await audit(
        db,
        {
          action: 'project.slug_change',
          actorId: userId,
          projectId: id,
          ip: request.ip,
          metadata: { from: project.slug, to: body.slug },
        },
        request.log,
      );
    }
    return summary(updated, role);
  });

  app.delete('/projects/:id', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    // Disconnect collaborators and drop unsaved live state: the project is going away.
    await collab.closeProject(id, CloseCode.NotFound, 'This timeline was deleted');

    const items = await db
      .select({ metadata: media.metadata, storageKey: media.storageKey })
      .from(media)
      .where(eq(media.projectId, id));
    const keys = items.flatMap((m) => Object.values(m.metadata.variants).map((v) => v.key));
    await db.delete(projects).where(eq(projects.id, id));
    // Remove stored files after the rows are gone; failures are logged, not fatal.
    try {
      await storage.delete(keys);
      await cdn.invalidate(keys);
    } catch (err) {
      request.log.error({ err, projectId: id }, 'failed to delete project media');
    }
    await audit(
      db,
      { action: 'project.delete', actorId: userId, projectId: id, ip: request.ip },
      request.log,
    );
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Draft (whole document) — optimistic concurrency via ETag / If-Match
  // ---------------------------------------------------------------------------

  app.get('/projects/:id/draft', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { project: row } = await requireProjectRole(
      db,
      id,
      requireAuth(request).userId,
      'viewer',
    );
    const project = await withFreshDraft(row);
    void reply.header('etag', etag(project.draftVersion)).header('cache-control', 'no-store');
    return {
      draftVersion: project.draftVersion,
      updatedAt: project.updatedAt.toISOString(),
      timeline: project.draft,
    };
  });

  app.put('/projects/:id/draft', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'editor');
    const expected = parseIfMatch(request.headers['if-match']);
    if (expected === null) {
      throw new ApiError(
        428,
        'precondition_required',
        'Send If-Match with the draft version you edited',
      );
    }
    const doc = validateDocument((request.body as { timeline?: unknown } | null)?.timeline);
    // Applied to the live document as a minimal diff, so connected editors see it at once.
    const written = await collab.change(id, () => ({ doc, result: null }), expected);
    void reply.header('etag', etag(written.draftVersion));
    return { draftVersion: written.draftVersion, updatedAt: written.updatedAt.toISOString() };
  });

  // ---------------------------------------------------------------------------
  // Events — fine-grained edits for API clients (retry on concurrent writes)
  // ---------------------------------------------------------------------------

  app.get('/projects/:id/events', async (request) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { project: row } = await requireProjectRole(
      db,
      id,
      requireAuth(request).userId,
      'viewer',
    );
    const project = await withFreshDraft(row);
    return { events: project.draft.events, draftVersion: project.draftVersion };
  });

  app.get('/projects/:id/events/:eventId', async (request) => {
    const { id, eventId } = parse(EventParams, request.params, 'path');
    const { project: row } = await requireProjectRole(
      db,
      id,
      requireAuth(request).userId,
      'viewer',
    );
    const project = await withFreshDraft(row);
    const event = project.draft.events.find((e) => e.id === eventId);
    if (!event) throw notFound('Event');
    return event;
  });

  app.post('/projects/:id/events', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'editor');
    const raw = { id: randomUUID(), ...(request.body as object) };
    const parsed = validateEvent(raw);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'bad_request',
        'Invalid event',
        parsed.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const event = parsed.data;
    const { draftVersion } = await collab.change(id, (doc) => {
      if (doc.events.some((e) => e.id === event.id))
        throw conflict(`An event with id "${event.id}" already exists`);
      return { doc: { ...doc, events: [...doc.events, event] }, result: null };
    });
    void reply.header('etag', etag(draftVersion));
    return reply.status(201).send(event);
  });

  app.patch('/projects/:id/events/:eventId', async (request, reply) => {
    const { id, eventId } = parse(EventParams, request.params, 'path');
    await requireProjectRole(db, id, requireAuth(request).userId, 'editor');
    const patch = parse(z.record(z.unknown()), request.body, 'event changes');
    if ('id' in patch && patch.id !== eventId) throw forbidden('Event ids cannot be changed');

    const { result, draftVersion } = await collab.change(id, (doc) => {
      const index = doc.events.findIndex((e) => e.id === eventId);
      if (index === -1) throw notFound('Event');
      const merged = validateEvent({ ...doc.events[index], ...patch, id: eventId });
      if (!merged.success) {
        throw new ApiError(
          400,
          'bad_request',
          'Invalid event',
          merged.errors.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      const events: TimelineEvent[] = doc.events.map((e, i) => (i === index ? merged.data : e));
      return { doc: { ...doc, events }, result: merged.data };
    });
    void reply.header('etag', etag(draftVersion));
    return result;
  });

  app.delete('/projects/:id/events/:eventId', async (request, reply) => {
    const { id, eventId } = parse(EventParams, request.params, 'path');
    await requireProjectRole(db, id, requireAuth(request).userId, 'editor');
    const { draftVersion } = await collab.change(id, (doc) => {
      if (!doc.events.some((e) => e.id === eventId)) throw notFound('Event');
      return { doc: { ...doc, events: doc.events.filter((e) => e.id !== eventId) }, result: null };
    });
    void reply.header('etag', etag(draftVersion));
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------------------
  // Audit trail (owners only)
  // ---------------------------------------------------------------------------

  app.get('/projects/:id/audit', async (request) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'owner');
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }),
      request.query,
      'query',
    );
    const rows = await db
      .select({
        action: auditLog.action,
        actorId: auditLog.actorId,
        actorName: users.name,
        metadata: auditLog.metadata,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorId))
      .where(eq(auditLog.projectId, id))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    return {
      entries: rows.map((r) => ({
        action: r.action,
        actor: r.actorId ? { id: r.actorId, name: r.actorName } : null,
        metadata: r.metadata,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // Share links for private timelines
  // ---------------------------------------------------------------------------

  app.post('/projects/:id/share-links', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { userId } = requireAuth(request);
    const { project } = await requireProjectRole(db, id, userId, 'editor');
    const { expiresInHours } = parse(ShareBody, request.body ?? {});
    const expiresAt = new Date(Date.now() + expiresInHours * 3_600_000);
    const token = createShareToken(config, project, expiresAt);
    await audit(
      db,
      {
        action: 'share_link.create',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { expiresAt: expiresAt.toISOString() },
      },
      request.log,
    );
    return reply.status(201).send({
      token,
      expiresAt: expiresAt.toISOString(),
      pageUrl: `${config.publicUrl}/timeline/${project.slug}?token=${token}`,
      embedUrl: `${config.publicUrl}/api/v1/embed/${project.slug}?token=${token}`,
    });
  });

  /** Revokes every share link for the project at once. */
  app.delete('/projects/:id/share-links', async (request, reply) => {
    const { id } = parse(UuidParam, request.params, 'project id');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    await db
      .update(projects)
      .set({ shareNonce: randomUUID() })
      .where(and(eq(projects.id, id)));
    await audit(
      db,
      { action: 'share_link.revoke_all', actorId: userId, projectId: id, ip: request.ip },
      request.log,
    );
    return reply.status(204).send();
  });
};
