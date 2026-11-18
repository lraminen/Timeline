import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { collaborators, projects } from '../db/schema.js';
import { forbidden, notFound } from '../http.js';

export type Role = 'owner' | 'editor' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export type Project = typeof projects.$inferSelect;

/**
 * Loads a project and the caller's role on it.
 *
 * Callers without any access get 404 (not 403), so private projects'
 * existence is not revealed. Callers with too low a role get 403.
 */
export async function requireProjectRole(
  db: Db,
  projectId: string,
  userId: string,
  minimum: Role,
): Promise<{ project: Project; role: Role }> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw notFound('Project');

  let role: Role | null = null;
  if (project.ownerId === userId) {
    role = 'owner';
  } else {
    const [collab] = await db
      .select({ role: collaborators.role })
      .from(collaborators)
      .where(and(eq(collaborators.projectId, projectId), eq(collaborators.userId, userId)))
      .limit(1);
    role = collab?.role ?? null;
  }

  if (!role) throw notFound('Project');
  if (RANK[role] < RANK[minimum]) {
    throw forbidden(`This needs ${minimum} access; you are a ${role}`);
  }
  return { project, role };
}
