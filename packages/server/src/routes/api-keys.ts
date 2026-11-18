import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { apiKeys } from '../db/schema.js';
import { forbidden, notFound, parse, UuidParam } from '../http.js';
import { requireAuth } from '../app.js';
import { generateApiKey } from '../auth/sessions.js';
import { audit } from '../services/audit.js';

const CreateBody = z.object({
  label: z.string().trim().min(1).max(100),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});

/**
 * API keys can do anything their owner can, except manage API keys: a
 * leaked key must not be able to mint more keys or hide its tracks.
 */
function requireSession(request: FastifyRequest) {
  const auth = requireAuth(request);
  if (auth.via !== 'session') throw forbidden('API keys can only be managed when signed in');
  return auth;
}

export const apiKeyRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.ctx;

  app.get('/api-keys', async (request) => {
    const { userId } = requireSession(request);
    const rows = await db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        prefix: apiKeys.prefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        expiresAt: apiKeys.expiresAt,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
    return { apiKeys: rows };
  });

  app.post('/api-keys', async (request, reply) => {
    const { userId } = requireSession(request);
    const body = parse(CreateBody, request.body);
    const { key, prefix, hash } = generateApiKey();
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86_400_000)
      : null;
    const [row] = await db
      .insert(apiKeys)
      .values({ userId, label: body.label, prefix, keyHash: hash, expiresAt })
      .returning({ id: apiKeys.id, createdAt: apiKeys.createdAt });
    if (!row) throw new Error('API key insert returned no row');
    await audit(
      db,
      {
        action: 'api_key.create',
        actorId: userId,
        ip: request.ip,
        metadata: { keyId: row.id, label: body.label },
      },
      request.log,
    );
    // The key is shown exactly once; only its hash is stored.
    return reply
      .status(201)
      .send({ id: row.id, label: body.label, key, prefix, expiresAt, createdAt: row.createdAt });
  });

  app.delete('/api-keys/:id', async (request, reply) => {
    const { userId } = requireSession(request);
    const { id } = parse(UuidParam, request.params, 'key id');
    const revoked = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (revoked.length === 0) throw notFound('API key');
    await audit(
      db,
      { action: 'api_key.revoke', actorId: userId, ip: request.ip, metadata: { keyId: id } },
      request.log,
    );
    return reply.status(204).send();
  });
};
