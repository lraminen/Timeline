import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { collaborators, users } from '../db/schema.js';
import { ApiError, badRequest, conflict, notFound, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole } from '../services/access.js';
import { audit } from '../services/audit.js';

const Role = z.enum(['editor', 'viewer']);
const AddBody = z.object({ email: z.string().trim().toLowerCase().email(), role: Role });
const Params = z.object({ id: z.string().uuid(), userId: z.string().uuid() });

export const collaboratorRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/projects/:id/collaborators', async (request) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    const { project } = await requireProjectRole(db, id, requireAuth(request).userId, 'viewer');
    const [owner] = await db.select().from(users).where(eq(users.id, project.ownerId)).limit(1);
    const rows = await db
      .select({ userId: users.id, name: users.name, email: users.email, role: collaborators.role })
      .from(collaborators)
      .innerJoin(users, eq(users.id, collaborators.userId))
      .where(eq(collaborators.projectId, id));
    return {
      collaborators: [
        ...(owner
          ? [{ userId: owner.id, name: owner.name, email: owner.email, role: 'owner' as const }]
          : []),
        ...rows,
      ],
    };
  });

  /**
   * Adds an existing user by email. (Inviting people without an account
   * needs email delivery, which arrives with notifications in Phase 6.)
   */
  app.post('/projects/:id/collaborators', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'project id');
    const { userId } = requireAuth(request);
    const { project } = await requireProjectRole(db, id, userId, 'owner');
    const body = parse(AddBody, request.body);

    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (!user) {
      throw new ApiError(
        404,
        'user_not_found',
        'No Chronicle account uses that email — ask them to sign up first',
      );
    }
    if (user.id === project.ownerId) throw badRequest('The owner already has full access');

    const inserted = await db
      .insert(collaborators)
      .values({ projectId: id, userId: user.id, role: body.role })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) throw conflict('That person is already a collaborator');
    await audit(
      db,
      {
        action: 'collaborator.add',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { userId: user.id, role: body.role },
      },
      request.log,
    );
    return reply
      .status(201)
      .send({ userId: user.id, name: user.name, email: user.email, role: body.role });
  });

  app.patch('/projects/:id/collaborators/:userId', async (request) => {
    const { id, userId: target } = parse(Params, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    const { role } = parse(z.object({ role: Role }), request.body);
    const updated = await db
      .update(collaborators)
      .set({ role })
      .where(and(eq(collaborators.projectId, id), eq(collaborators.userId, target)))
      .returning();
    if (updated.length === 0) throw notFound('Collaborator');
    await audit(
      db,
      {
        action: 'collaborator.update',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { userId: target, role },
      },
      request.log,
    );
    return { userId: target, role };
  });

  /** Owners can remove anyone; collaborators can remove themselves (leave). */
  app.delete('/projects/:id/collaborators/:userId', async (request, reply) => {
    const { id, userId: target } = parse(Params, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, target === userId ? 'viewer' : 'owner');
    const removed = await db
      .delete(collaborators)
      .where(and(eq(collaborators.projectId, id), eq(collaborators.userId, target)))
      .returning();
    if (removed.length === 0) throw notFound('Collaborator');
    await audit(
      db,
      {
        action: 'collaborator.remove',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { userId: target },
      },
      request.log,
    );
    return reply.status(204).send();
  });
};
