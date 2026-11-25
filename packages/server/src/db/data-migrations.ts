import { asc, eq, gt, sql } from 'drizzle-orm';
import { repairTimelineDates, type Timeline } from '@chronicle/schema';
import type { Db } from './client.js';
import { dataMigrations, projects, revisions } from './schema.js';

/**
 * One-off rewrites of stored documents. Schema changes belong in drizzle SQL
 * migrations; these run after them, each exactly once per database.
 */
export interface DataMigrationResult {
  name: string;
  details: Record<string, number>;
}

interface DataMigration {
  name: string;
  run: (tx: Db) => Promise<Record<string, number>>;
}

const BATCH = 200;

/**
 * Phase 5 added calendar validation to timeline dates. Older releases stored any
 * string, so drafts and published revisions may hold forms such as `1969-7-20`,
 * `0000` or `1969-02-31` that the schema now rejects. This rewrites them with the
 * same deterministic migration the editor and web component apply on load.
 *
 * `draftVersion` is deliberately not bumped: every client applies the identical
 * migration when it loads a draft, so bumping would only raise false conflicts.
 * Dates that cannot be recognised are left alone for the author to fix.
 */
async function migrateTimelineDates(tx: Db): Promise<Record<string, number>> {
  const counts = { draftsMigrated: 0, revisionsMigrated: 0, datesUnrecognised: 0 };

  let lastProject: string | null = null;
  for (;;) {
    const rows: { id: string; draft: Timeline }[] = await tx
      .select({ id: projects.id, draft: projects.draft })
      .from(projects)
      .where(lastProject ? gt(projects.id, lastProject) : undefined)
      .orderBy(asc(projects.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      const report = repairTimelineDates(row.draft);
      counts.datesUnrecognised += report.unrecognised;
      if (!report.changed) continue;
      await tx.update(projects).set({ draft: report.timeline }).where(eq(projects.id, row.id));
      counts.draftsMigrated += 1;
    }
    lastProject = rows[rows.length - 1]?.id ?? null;
  }

  let lastRevision: string | null = null;
  for (;;) {
    const rows: { id: string; timelineData: Timeline }[] = await tx
      .select({ id: revisions.id, timelineData: revisions.timelineData })
      .from(revisions)
      .where(lastRevision ? gt(revisions.id, lastRevision) : undefined)
      .orderBy(asc(revisions.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    for (const row of rows) {
      const report = repairTimelineDates(row.timelineData);
      if (!report.changed) continue;
      await tx
        .update(revisions)
        .set({ timelineData: report.timeline })
        .where(eq(revisions.id, row.id));
      counts.revisionsMigrated += 1;
    }
    lastRevision = rows[rows.length - 1]?.id ?? null;
  }

  return counts;
}

export const DATA_MIGRATIONS: readonly DataMigration[] = [
  { name: '2026-11-timeline-date-calendar-validation', run: migrateTimelineDates },
];

/** Arbitrary constant key for the advisory lock that serialises data migrations. */
const DATA_MIGRATION_LOCK = 735_201_126;

/**
 * Runs every data migration that has not run yet. Each one runs in its own
 * transaction under an advisory lock, so several server instances starting at
 * once do not run it twice, and a failure leaves no partial rewrite behind.
 */
export async function runDataMigrations(
  db: Db,
  migrations: readonly DataMigration[] = DATA_MIGRATIONS,
): Promise<DataMigrationResult[]> {
  const applied: DataMigrationResult[] = [];
  for (const migration of migrations) {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${DATA_MIGRATION_LOCK})`);
      const [done] = await tx
        .select({ name: dataMigrations.name })
        .from(dataMigrations)
        .where(eq(dataMigrations.name, migration.name));
      if (done) return null;
      const details = await migration.run(tx);
      await tx.insert(dataMigrations).values({ name: migration.name, details });
      return { name: migration.name, details };
    });
    if (result) applied.push(result);
  }
  return applied;
}
