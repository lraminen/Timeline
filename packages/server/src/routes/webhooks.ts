import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { WEBHOOK_EVENTS, webhookDeliveries, webhooks } from '../db/schema.js';
import { ApiError, notFound, one, parse } from '../http.js';
import { requireAuth } from '../app.js';
import { requireProjectRole } from '../services/access.js';
import { audit } from '../services/audit.js';
import { checkWebhookUrl, encryptSecret, generateSecret } from '../services/webhooks.js';

const MAX_WEBHOOKS_PER_PROJECT = 10;

const ProjectParams = z.object({ id: z.string().uuid() });
const HookParams = z.object({ id: z.string().uuid(), webhookId: z.string().uuid() });
const DeliveryParams = HookParams.extend({ deliveryId: z.string().uuid() });

const Events = z
  .array(z.enum(WEBHOOK_EVENTS))
  .min(1, 'Choose at least one event')
  .transform((list) => [...new Set(list)]);

const CreateBody = z.object({
  url: z.string().trim().min(1).max(2000),
  events: Events,
  description: z.string().trim().max(200).default(''),
});

const PatchBody = z
  .object({
    url: z.string().trim().min(1).max(2000).optional(),
    events: Events.optional(),
    description: z.string().trim().max(200).optional(),
    active: z.boolean().optional(),
  })
  .strict();

type Row = typeof webhooks.$inferSelect;

function view(w: Row) {
  return {
    id: w.id,
    url: w.url,
    description: w.description,
    events: w.events,
    active: w.active,
    disabledReason: w.disabledReason,
    consecutiveFailures: w.consecutiveFailures,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

/** Webhook management (project owners only). Secrets are returned once. */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const { db, config } = app.ctx;
  const service = () => app.ctx.webhooks;

  async function findHook(projectId: string, webhookId: string): Promise<Row> {
    const [row] = await db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, webhookId), eq(webhooks.projectId, projectId)))
      .limit(1);
    if (!row) throw notFound('Webhook');
    return row;
  }

  app.get('/projects/:id/webhooks', async (request) => {
    const { id } = parse(ProjectParams, request.params, 'project id');
    await requireProjectRole(db, id, requireAuth(request).userId, 'owner');
    const rows = await db
      .select()
      .from(webhooks)
      .where(eq(webhooks.projectId, id))
      .orderBy(webhooks.createdAt);
    return { webhooks: rows.map(view), events: WEBHOOK_EVENTS };
  });

  app.post('/projects/:id/webhooks', async (request, reply) => {
    const { id } = parse(ProjectParams, request.params, 'project id');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    const body = parse(CreateBody, request.body);
    const url = checkWebhookUrl(config, body.url);
    const [existing] = await db
      .select({ n: count() })
      .from(webhooks)
      .where(eq(webhooks.projectId, id));
    if ((existing?.n ?? 0) >= MAX_WEBHOOKS_PER_PROJECT) {
      throw new ApiError(
        409,
        'limit_reached',
        `A timeline can have at most ${String(MAX_WEBHOOKS_PER_PROJECT)} webhooks`,
      );
    }
    const secret = generateSecret();
    const row = one(
      await db
        .insert(webhooks)
        .values({
          projectId: id,
          url,
          description: body.description,
          events: body.events,
          secretEncrypted: encryptSecret(config, secret),
          createdBy: userId,
        })
        .returning(),
    );
    await audit(
      db,
      {
        action: 'webhook.create',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { webhookId: row.id, url, events: body.events },
      },
      request.log,
    );
    return reply.status(201).send({ ...view(row), secret });
  });

  app.patch('/projects/:id/webhooks/:webhookId', async (request) => {
    const { id, webhookId } = parse(HookParams, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    const body = parse(PatchBody, request.body);
    const current = await findHook(id, webhookId);
    const changes: Partial<Row> = { updatedAt: new Date() };
    if (body.url !== undefined) changes.url = checkWebhookUrl(config, body.url);
    if (body.events !== undefined) changes.events = body.events;
    if (body.description !== undefined) changes.description = body.description;
    if (body.active !== undefined) {
      changes.active = body.active;
      if (body.active) {
        // Turning it back on clears the failure state.
        changes.disabledReason = null;
        changes.consecutiveFailures = 0;
      }
    }
    const row = one(
      await db.update(webhooks).set(changes).where(eq(webhooks.id, current.id)).returning(),
      'Webhook',
    );
    await audit(
      db,
      {
        action: 'webhook.update',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { webhookId, changes: Object.keys(body) },
      },
      request.log,
    );
    return view(row);
  });

  app.delete('/projects/:id/webhooks/:webhookId', async (request, reply) => {
    const { id, webhookId } = parse(HookParams, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    await findHook(id, webhookId);
    await db.delete(webhooks).where(eq(webhooks.id, webhookId));
    await audit(
      db,
      {
        action: 'webhook.delete',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { webhookId },
      },
      request.log,
    );
    return reply.status(204).send();
  });

  /** Issues a new signing secret; the old one stops working immediately. */
  app.post('/projects/:id/webhooks/:webhookId/rotate-secret', async (request) => {
    const { id, webhookId } = parse(HookParams, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    await findHook(id, webhookId);
    const secret = generateSecret();
    await db
      .update(webhooks)
      .set({ secretEncrypted: encryptSecret(config, secret), updatedAt: new Date() })
      .where(eq(webhooks.id, webhookId));
    await audit(
      db,
      {
        action: 'webhook.rotate_secret',
        actorId: userId,
        projectId: id,
        ip: request.ip,
        metadata: { webhookId },
      },
      request.log,
    );
    return { secret };
  });

  /** Queues a `ping` delivery to check the endpoint and its signature check. */
  app.post('/projects/:id/webhooks/:webhookId/test', async (request, reply) => {
    const { id, webhookId } = parse(HookParams, request.params, 'path');
    const { userId } = requireAuth(request);
    await requireProjectRole(db, id, userId, 'owner');
    await findHook(id, webhookId);
    const [deliveryId] = await service().emit(
      id,
      'ping',
      { message: 'Hello from Chronicle' },
      webhookId,
    );
    return reply.status(202).send({ deliveryId });
  });

  app.get('/projects/:id/webhooks/:webhookId/deliveries', async (request) => {
    const { id, webhookId } = parse(HookParams, request.params, 'path');
    await requireProjectRole(db, id, requireAuth(request).userId, 'owner');
    await findHook(id, webhookId);
    const { limit } = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      request.query,
      'query',
    );
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(limit);
    return {
      deliveries: rows.map((d) => ({
        id: d.id,
        messageId: d.messageId,
        eventType: d.eventType,
        status: d.status,
        attempts: d.attempts,
        lastStatusCode: d.lastStatusCode,
        lastError: d.lastError,
        nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
        lastAttemptAt: d.lastAttemptAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        payload: JSON.parse(d.payload) as unknown,
      })),
    };
  });

  app.post(
    '/projects/:id/webhooks/:webhookId/deliveries/:deliveryId/redeliver',
    async (request, reply) => {
      const { id, webhookId, deliveryId } = parse(DeliveryParams, request.params, 'path');
      await requireProjectRole(db, id, requireAuth(request).userId, 'owner');
      await findHook(id, webhookId);
      const [delivery] = await db
        .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
        .from(webhookDeliveries)
        .where(
          and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)),
        )
        .limit(1);
      if (!delivery) throw notFound('Delivery');
      if (delivery.status === 'pending' || delivery.status === 'delivering') {
        throw new ApiError(409, 'conflict', 'That delivery is still in progress');
      }
      await service().redeliver(deliveryId);
      return reply.status(202).send({ deliveryId });
    },
  );
};
