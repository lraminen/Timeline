import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { validateTimeline, type Timeline } from '@chronicle/schema';
import { openDatabase, type Database } from '../db/client.js';
import { runDataMigrations } from '../db/data-migrations.js';
import { dataMigrations, projects, revisions, users } from '../db/schema.js';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** A timeline as an older release could have stored it: valid then, rejected now. */
function legacyTimeline(): Timeline {
  return {
    schemaVersion: '1.0.0',
    id: 'legacy',
    title: 'Legacy',
    events: [
      { id: 'a', title: 'Padded', date: { start: '1969-7-20' }, media: [], tags: [] },
      { id: 'b', title: 'Impossible', date: { start: '1969-02-31' }, media: [], tags: [] },
    ],
    eras: [{ id: 'e', title: 'Era', start: '0000', end: '1969' }],
    settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  };
}

let database: Database | null = null;
afterEach(async () => {
  await database?.close();
  database = null;
});

describe('data migrations', () => {
  it('migrates legacy dates in drafts and revisions once, without bumping draftVersion', async () => {
    database = await openDatabase({});
    await database.migrate();
    const { db } = database;

    const [user] = await db
      .insert(users)
      .values({ email: 'legacy@example.com', name: 'Legacy', passwordHash: 'x' })
      .returning();
    if (!user) throw new Error('user insert failed');
    const [project] = await db
      .insert(projects)
      .values({
        ownerId: user.id,
        title: 'Legacy',
        slug: 'legacy',
        draft: legacyTimeline(),
        draftVersion: 7,
      })
      .returning();
    if (!project) throw new Error('project insert failed');
    await db
      .insert(revisions)
      .values({ projectId: project.id, version: 1, timelineData: legacyTimeline() });

    // The migration already ran (on the empty database) when it was opened; run it again.
    await db.delete(dataMigrations);
    const applied = await runDataMigrations(db);
    expect(applied).toEqual([
      {
        name: '2026-11-timeline-date-calendar-validation',
        details: { draftsMigrated: 1, revisionsMigrated: 1, datesUnrecognised: 0 },
      },
    ]);

    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row?.draftVersion).toBe(7);
    expect(validateTimeline(row?.draft).success).toBe(true);
    expect(row?.draft.events[0]?.date.start).toBe('1969-07-20');
    expect(row?.draft.events[1]?.date).toMatchObject({ start: '1969-02', uncertain: true });
    expect(row?.draft.eras[0]?.start).toBe('-0001');

    const [rev] = await db.select().from(revisions).where(eq(revisions.projectId, project.id));
    expect(validateTimeline(rev?.timelineData).success).toBe(true);

    // Recorded, so it never runs twice.
    expect(await runDataMigrations(db)).toEqual([]);
  });

  it('upgrades a database that applied only the original 0000 and 0001 migrations', async () => {
    // Recreate a database as it was after commit 88991cc: migrations 0000 and 0001 only.
    const oldFolder = mkdtempSync(join(tmpdir(), 'chronicle-migrations-'));
    try {
      cpSync(MIGRATIONS, oldFolder, { recursive: true });
      const journalPath = join(oldFolder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => /^000[01]_/.test(e.tag));
      writeFileSync(journalPath, JSON.stringify(journal));

      const { PGlite } = await import('@electric-sql/pglite');
      const { drizzle } = await import('drizzle-orm/pglite');
      const { migrate } = await import('drizzle-orm/pglite/migrator');
      const client = new PGlite();
      const db = drizzle({ client });
      try {
        await migrate(db, { migrationsFolder: oldFolder });
        const columns = async () =>
          (
            await db.execute<{ column_name: string }>(
              sql`select column_name from information_schema.columns where table_name = 'ai_usage'`,
            )
          ).rows.map((r) => r.column_name);
        expect(await columns()).not.toContain('status');

        // Upgrading with the current migration folder must add the column.
        await migrate(db, { migrationsFolder: MIGRATIONS });
        expect(await columns()).toContain('status');
        // ...and the Phase 6 collaboration schema.
        const projectColumns = (
          await db.execute<{ column_name: string }>(
            sql`select column_name from information_schema.columns where table_name = 'projects'`,
          )
        ).rows.map((r) => r.column_name);
        expect(projectColumns).toEqual(expect.arrayContaining(['ydoc', 'ydoc_seq']));
        const tables = (
          await db.execute<{ table_name: string }>(
            sql`select table_name from information_schema.tables where table_schema = 'public'`,
          )
        ).rows.map((r) => r.table_name);
        expect(tables).toEqual(
          expect.arrayContaining(['collab_updates', 'comments', 'webhooks', 'webhook_deliveries']),
        );
      } finally {
        await client.close();
      }
    } finally {
      rmSync(oldFolder, { recursive: true, force: true });
    }
  });
});
