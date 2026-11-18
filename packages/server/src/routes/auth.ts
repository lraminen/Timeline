import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../db/schema.js';
import { ApiError, conflict, forbidden, parse, unauthorized } from '../http.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/crypto.js';
import {
  issueRefreshToken,
  revokeByToken,
  rotateRefreshToken,
  signAccessToken,
} from '../auth/sessions.js';
import { audit } from '../services/audit.js';
import { requireAuth } from '../app.js';

export const REFRESH_COOKIE = 'chronicle_refresh';
const COOKIE_PATH = '/api/v1/auth';

const Email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
/** NIST 800-63B: length matters more than composition rules. */
const Password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(256, 'Use at most 256 characters');

const RegisterBody = z.object({
  email: Email,
  name: z.string().trim().min(1, 'Enter your name').max(100),
  password: Password,
});
const LoginBody = z.object({ email: Email, password: z.string().min(1).max(256) });

export const authRoutes: FastifyPluginAsync = async (app) => {
  const { config, db } = app.ctx;
  const secureCookie = config.isProduction || config.publicUrl.startsWith('https:');
  const allowedOrigins = new Set([new URL(config.publicUrl).origin, ...config.CORS_ORIGINS]);
  const authLimit = {
    rateLimit: {
      max: config.AUTH_RATE_LIMIT_PER_MINUTE,
      timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => req.ip,
    },
  };

  /**
   * CSRF defence for the cookie-authenticated endpoints (refresh/logout):
   * besides SameSite=Strict, reject browser requests from foreign origins.
   */
  const checkOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw forbidden('Cross-origin request rejected');
  };

  const startSession = async (reply: FastifyReply, user: typeof users.$inferSelect) => {
    const [accessToken, refresh] = await Promise.all([
      signAccessToken(config, user.id),
      issueRefreshToken(db, config, user.id),
    ]);
    void reply.setCookie(REFRESH_COOKIE, refresh.token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: refresh.expiresAt,
    });
    return {
      accessToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
    };
  };

  app.post('/auth/register', { config: authLimit }, async (request, reply) => {
    const body = parse(RegisterBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const inserted = await db
      .insert(users)
      .values({ email: body.email, name: body.name, passwordHash })
      .onConflictDoNothing({ target: users.email })
      .returning();
    const user = inserted.at(0);
    if (!user) throw conflict('An account with that email already exists');
    await audit(db, { action: 'auth.register', actorId: user.id, ip: request.ip }, request.log);
    return reply.status(201).send(await startSession(reply, user));
  });

  app.post('/auth/login', { config: authLimit }, async (request, reply) => {
    const body = parse(LoginBody, request.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    // Same work and same message whether or not the account exists.
    const ok = user
      ? await verifyPassword(user.passwordHash, body.password)
      : await verifyAgainstDummy(body.password);
    if (!user || !ok) {
      await audit(
        db,
        {
          action: 'auth.login_failed',
          actorId: user?.id ?? null,
          ip: request.ip,
          metadata: { email: body.email },
        },
        request.log,
      );
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    await audit(db, { action: 'auth.login', actorId: user.id, ip: request.ip }, request.log);
    return startSession(reply, user);
  });

  app.post('/auth/refresh', { config: authLimit }, async (request, reply) => {
    checkOrigin(request);
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('No session');
    const result = await rotateRefreshToken(db, config, token);
    if (!result.ok) {
      void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      if (result.reason === 'reused') {
        await audit(
          db,
          { action: 'auth.refresh_reuse_detected', actorId: result.userId ?? null, ip: request.ip },
          request.log,
        );
      }
      throw unauthorized('Session expired; please sign in again');
    }
    const [user] = await db.select().from(users).where(eq(users.id, result.userId)).limit(1);
    if (!user) throw unauthorized('Account no longer exists');
    void reply.setCookie(REFRESH_COOKIE, result.token, {
      httpOnly: true,
      secure: secureCookie,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: result.expiresAt,
    });
    return {
      accessToken: await signAccessToken(config, user.id),
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
      user: { id: user.id, email: user.email, name: user.name },
    };
  });

  app.post('/auth/logout', async (request, reply) => {
    checkOrigin(request);
    const token = request.cookies[REFRESH_COOKIE];
    if (token) await revokeByToken(db, token);
    void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
    await audit(
      db,
      { action: 'auth.logout', actorId: request.auth?.userId ?? null, ip: request.ip },
      request.log,
    );
    return reply.status(204).send();
  });

  app.get('/me', async (request) => {
    const { userId, via } = requireAuth(request);
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw unauthorized('Account no longer exists');
    return { id: user.id, email: user.email, name: user.name, authenticatedVia: via };
  });
};
