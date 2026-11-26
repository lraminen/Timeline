import type { FastifyPluginAsync } from 'fastify';
import { and, asc, eq, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { CommentDto } from '@chronicle/collab';
import type { Db } from '../db/client.js';
import { comments, users } from '../db/schema.js';
import { badRequest, forbidden, notFound, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole, type Role } from '../services/access.js';

const Params = z.object({ id: z.string().uuid() });
const CommentParams = z.object({ id: z.string().uuid(), commentId: z.string().uuid() });
const Body = z.string().trim().min(1, 'Write a comment').max(5000);

const ListQuery = z.object({
  eventId: z.string().min(1).max(200).optional(),
  status: z.enum(['open', 'resolved', 'all']).default('all'),
});

const CreateBody = z
  .object({
    eventId: z.string().min(1).max(200).optional(),
    parentId: z.string().uuid().optional(),
    body: Body,
  })
  .refine((b) => b.eventId !== undefined || b.parentId !== undefined, {
    message: 'Give the event to comment on (eventId), or the comment to reply to (parentId)',
  });

const PatchBody = z
  .object({ body: Body.optional(), resolved: z.boolean().optional() })
  .strict()
  .refine((b) => b.body !== undefined || b.resolved !== undefined, {
    message: 'Nothing to change',
  });

const author = alias(users, 'author');
const resolver = alias(users, 'resolver');

async function load(db: Db, where: SQL | undefined): Promise<CommentDto[]> {
  const rows = await db
    .select({
      c: comments,
      authorName: author.name,
      resolverName: resolver.name,
    })
    .from(comments)
    .leftJoin(author, eq(author.id, comments.authorId))
    .leftJoin(resolver, eq(resolver.id, comments.resolvedBy))
    .where(where)
    .orderBy(asc(comments.createdAt), asc(comments.id));
  return rows.map(({ c, authorName, resolverName }) => ({
    id: c.id,
    projectId: c.projectId,
    eventId: c.eventId,
    parentId: c.parentId,
    body: c.body,
    author: c.authorId ? { id: c.authorId, name: authorName ?? 'Deleted user' } : null,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
    resolvedAt: c.resolvedAt?.toISOString() ?? null,
    resolvedBy: c.resolvedBy ? { id: c.resolvedBy, name: resolverName ?? 'Deleted user' } : null,
  }));
}

async function loadOne(db: Db, projectId: string, commentId: string): Promise<CommentDto> {
  const [comment] = await load(
    db,
    and(eq(comments.projectId, projectId), eq(comments.id, commentId)),
  );
  if (!comment) throw notFound('Comment');
  return comment;
}

const canModerate = (role: Role) => role === 'owner' || role === 'editor';

/**
 * Threaded comments on events. Everyone with access to a timeline (viewers
 * included) can read and write comments; people edit their own; editors, and
 * whoever started a thread, can resolve it; owners can delete any comment.
 * Changes are pushed live to connected collaborators and sent to webhooks.
 */
export const commentRoutes: FastifyPluginAsync = async (app) => {
  const { db, collab } = app.ctx;

  const publish = (action: 'created' | 'updated' | 'deleted', comment: CommentDto) => {
    collab.broadcast(comment.projectId, { type: 'comment', action, comment });
    app.ctx.webhooks.notify(comment.projectId, `comment.${action}`, { comment });
  };

  app.get('/projects/:id/comments', async (request) => {
    const { id } = parse(Params, request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const query = parse(ListQuery, request.query, 'query');
    let list = await load(
      db,
      and(
        eq(comments.projectId, id),
        query.eventId ? eq(comments.eventId, query.eventId) : undefined,
      ),
    );
    if (query.status !== 'all') {
      const wantResolved = query.status === 'resolved';
      const roots = new Map(list.filter((c) => !c.parentId).map((c) => [c.id, c]));
      list = list.filter((c) => {
        const root = c.parentId ? roots.get(c.parentId) : c;
        return root !== undefined && (root.resolvedAt !== null) === wantResolved;
      });
    }
    return { comments: list };
  });

  app.post('/projects/:id/comments', async (request, reply) => {
    const { id } = parse(Params, request.params, 'project id');
    const { userId } = requireAuth(request);
    const { project } = await requireProjectRole(db, id, userId, 'viewer');
    const body = parse(CreateBody, request.body);

    let eventId = body.eventId;
    let parentId: string | null = null;
    if (body.parentId) {
      const [parent] = await db
        .select({ id: comments.id, eventId: comments.eventId, parentId: comments.parentId })
        .from(comments)
        .where(and(eq(comments.id, body.parentId), eq(comments.projectId, id)))
        .limit(1);
      if (!parent) throw notFound('Comment');
      if (eventId !== undefined && eventId !== parent.eventId) {
        throw badRequest('A reply must be on the same event as its thread');
      }
      eventId = parent.eventId;
      // Threads are one level deep: a reply to a reply joins the thread.
      parentId = parent.parentId ?? parent.id;
    } else {
      const current = collab.current(id) ?? project.draft;
      if (!current.events.some((e) => e.id === eventId)) throw notFound('Event');
    }
    if (eventId === undefined) throw badRequest('eventId is required');

    const [row] = await db
      .insert(comments)
      .values({ projectId: id, eventId, parentId, authorId: userId, body: body.body })
      .returning({ id: comments.id });
    if (!row) throw new Error('Comment insert returned no row');
    const comment = await loadOne(db, id, row.id);
    publish('created', comment);
    return reply.status(201).send(comment);
  });

  app.patch('/projects/:id/comments/:commentId', async (request) => {
    const { id, commentId } = parse(CommentParams, request.params, 'path');
    const { userId } = requireAuth(request);
    const { role } = await requireProjectRole(db, id, userId, 'viewer');
    const body = parse(PatchBody, request.body);
    const existing = await loadOne(db, id, commentId);
    const isAuthor = existing.author?.id === userId;

    const changes: Partial<typeof comments.$inferInsert> = {};
    if (body.body !== undefined && body.body !== existing.body) {
      if (!isAuthor) throw forbidden('You can only edit your own comments');
      changes.body = body.body;
      changes.editedAt = new Date();
    }
    if (body.resolved !== undefined) {
      if (existing.parentId) throw badRequest('Resolve the thread, not a reply');
      if (!canModerate(role) && !isAuthor) {
        throw forbidden('Only editors and the person who started a thread can resolve it');
      }
      if (body.resolved !== (existing.resolvedAt !== null)) {
        changes.resolvedAt = body.resolved ? new Date() : null;
        changes.resolvedBy = body.resolved ? userId : null;
      }
    }
    if (Object.keys(changes).length === 0) return existing;
    await db
      .update(comments)
      .set(changes)
      .where(and(eq(comments.id, commentId), eq(comments.projectId, id)));
    const comment = await loadOne(db, id, commentId);
    publish('updated', comment);
    return comment;
  });

  app.delete('/projects/:id/comments/:commentId', async (request, reply) => {
    const { id, commentId } = parse(CommentParams, request.params, 'path');
    const { userId } = requireAuth(request);
    const { role } = await requireProjectRole(db, id, userId, 'viewer');
    const existing = await loadOne(db, id, commentId);
    if (existing.author?.id !== userId && role !== 'owner') {
      throw forbidden('You can only delete your own comments');
    }
    // Replies go with their thread (ON DELETE CASCADE).
    await db.delete(comments).where(and(eq(comments.id, commentId), eq(comments.projectId, id)));
    publish('deleted', existing);
    return reply.status(204).send();
  });
};
