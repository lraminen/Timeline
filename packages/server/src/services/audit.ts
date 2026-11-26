import type { Db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export type AuditAction =
  | 'auth.register'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.refresh_reuse_detected'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'project.create'
  | 'project.delete'
  | 'project.visibility_change'
  | 'project.slug_change'
  | 'project.publish'
  | 'project.rollback'
  | 'project.export'
  | 'collaborator.add'
  | 'collaborator.update'
  | 'collaborator.remove'
  | 'share_link.create'
  | 'share_link.revoke_all'
  | 'media.upload'
  | 'media.rejected'
  | 'media.delete'
  | 'ai.extract'
  | 'ai.summarize'
  | 'ai.alt_text'
  | 'ai.normalize_date'
  | 'ai.detect_conflicts'
  | 'webhook.create'
  | 'webhook.update'
  | 'webhook.delete'
  | 'webhook.rotate_secret';

export interface AuditEntry {
  action: AuditAction;
  actorId?: string | null;
  projectId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/** Appends to the audit log. Never throws: auditing must not break requests. */
export async function audit(
  db: Db,
  entry: AuditEntry,
  log?: { error: (o: object, m: string) => void },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      action: entry.action,
      actorId: entry.actorId ?? null,
      projectId: entry.projectId ?? null,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    log?.error({ err, action: entry.action }, 'audit write failed');
  }
}
