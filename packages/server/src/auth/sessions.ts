import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { apiKeys, refreshTokens } from '../db/schema.js';
import { randomToken, safeEqual, sha256 } from './crypto.js';

const AUDIENCE = 'chronicle-api';

// ---------------------------------------------------------------------------
// Access tokens (short-lived JWT, HS256)
// ---------------------------------------------------------------------------

export async function signAccessToken(config: Config, userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(config.publicUrl)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(config.ACCESS_TOKEN_TTL_SECONDS)}s`)
    .sign(config.jwtSecret);
}

/** Returns the user id, or `null` for any invalid/expired token. */
export async function verifyAccessToken(config: Config, token: string): Promise<string | null> {
  return (await verifyAccessTokenClaims(config, token))?.userId ?? null;
}

/** Like `verifyAccessToken`, also returning when the token expires (ms since epoch). */
export async function verifyAccessTokenClaims(
  config: Config,
  token: string,
): Promise<{ userId: string; expiresAt: number } | null> {
  try {
    const { payload } = await jwtVerify(token, config.jwtSecret, {
      issuer: config.publicUrl,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (!payload.sub || payload.exp === undefined) return null;
    return { userId: payload.sub, expiresAt: payload.exp * 1000 };
  } catch (err) {
    if (err instanceof joseErrors.JOSEError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens (opaque, hashed at rest, rotated on every use)
// ---------------------------------------------------------------------------

export async function issueRefreshToken(
  db: Db,
  config: Config,
  userId: string,
  familyId: string = randomUUID(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  await db.insert(refreshTokens).values({ userId, familyId, tokenHash: sha256(token), expiresAt });
  return { token, expiresAt };
}

export type RotationResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' | 'reused'; userId?: string };

/**
 * Exchanges a refresh token for a new one in the same family.
 *
 * Presenting a token that was already used (or revoked) means it was copied:
 * the whole family is revoked so neither the thief nor the victim can
 * continue, and the user must sign in again.
 */
export async function rotateRefreshToken(
  db: Db,
  config: Config,
  token: string,
): Promise<RotationResult> {
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(token)))
    .limit(1);
  if (!row) return { ok: false, reason: 'invalid' };

  if (row.usedAt || row.revokedAt) {
    await revokeFamily(db, row.familyId);
    return { ok: false, reason: 'reused', userId: row.userId };
  }
  if (row.expiresAt.getTime() <= Date.now())
    return { ok: false, reason: 'expired', userId: row.userId };

  // Atomic claim: only one concurrent request can mark the token used.
  const claimed = await db
    .update(refreshTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.id, row.id),
        isNull(refreshTokens.usedAt),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  if (claimed.length === 0) {
    await revokeFamily(db, row.familyId);
    return { ok: false, reason: 'reused', userId: row.userId };
  }

  const next = await issueRefreshToken(db, config, row.userId, row.familyId);
  return { ok: true, userId: row.userId, ...next };
}

export async function revokeFamily(db: Db, familyId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
}

/** Revokes the session a refresh token belongs to (logout). */
export async function revokeByToken(db: Db, token: string): Promise<void> {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, sha256(token)))
    .limit(1);
  if (row) await revokeFamily(db, row.familyId);
}

// ---------------------------------------------------------------------------
// API keys:  chr_<prefix>_<secret>
// ---------------------------------------------------------------------------

const API_KEY = /^chr_([A-Za-z0-9]{12})_([A-Za-z0-9_-]{43})$/;

export function isApiKeyFormat(value: string): boolean {
  return API_KEY.test(value);
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomToken(12)
    .replace(/[^A-Za-z0-9]/g, '')
    .padEnd(12, '0')
    .slice(0, 12);
  const key = `chr_${prefix}_${randomToken(32)}`;
  return { key, prefix, hash: sha256(key) };
}

/** Resolves an API key to its owner, or `null` if unknown, revoked or expired. */
export async function verifyApiKey(
  db: Db,
  key: string,
): Promise<{ userId: string; keyId: string } | null> {
  const prefix = API_KEY.exec(key)?.[1];
  if (!prefix) return null;
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
  if (!row || row.revokedAt || !safeEqual(row.keyHash, sha256(key))) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  // Best-effort usage tracking; never fails the request.
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => undefined);
  return { userId: row.userId, keyId: row.id };
}
