import type { Config } from '../config.js';
import type { projects } from '../db/schema.js';
import { hmac, safeEqual } from '../auth/crypto.js';

type ProjectRow = typeof projects.$inferSelect;

/**
 * Signed, expiring share token: `<expiry-seconds>.<hmac>`, where the HMAC
 * covers the project id, the project's share nonce and the expiry. Rotating
 * the nonce revokes every outstanding token for that project.
 */
export function createShareToken(
  config: Config,
  project: Pick<ProjectRow, 'id' | 'shareNonce'>,
  expiresAt: Date,
): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return `${String(exp)}.${hmac(config.jwtSecret, `share:${project.id}:${project.shareNonce}:${String(exp)}`)}`;
}

export function verifyShareToken(
  config: Config,
  project: Pick<ProjectRow, 'id' | 'shareNonce'>,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m?.[1] || !m[2]) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= Date.now()) return false;
  const expected = hmac(
    config.jwtSecret,
    `share:${project.id}:${project.shareNonce}:${String(exp)}`,
  );
  return safeEqual(expected, m[2]);
}
