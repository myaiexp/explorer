// The test DB must be at the same migration as the code under test.
//
// Idea #3615: explorer_test carried all five tables while drizzle's own
// __drizzle_migrations was EMPTY, so `drizzle-kit migrate` against it replayed
// 0000 CREATE TABLE and died. Nothing noticed, because the suite never
// migrates — it assumes the schema is already there. That silence is the real
// defect: a new migration reaches prod through deploy while the suite keeps
// asserting against last month's columns, and the first sign is a green run
// that proves nothing.
//
// This is the tripwire. It compares the journal rows in the live test DB
// against drizzle/meta/_journal.json — same tags, same order, same sha256 over
// each .sql file, which is exactly what drizzle-orm's migrator records. Add a
// migration without running `pnpm db:reset:test` and this goes RED.
import { describe, test, expect, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { resolveTestDatabaseUrl } from './test-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, '../drizzle');

interface JournalEntry { idx: number; tag: string; when: number }
interface AppliedRow { id: number; hash: string; created_at: string }

const journal: { entries: JournalEntry[] } = JSON.parse(
  readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8'),
);

// drizzle-orm's migrator hashes the raw .sql file text with sha256 and stores
// that as the row's `hash` — recomputing it here is what makes this a content
// check rather than a filename check.
function hashOf(tag: string): string {
  return createHash('sha256')
    .update(readFileSync(resolve(drizzleDir, `${tag}.sql`), 'utf8'))
    .digest('hex');
}

const pool = new pg.Pool({ connectionString: resolveTestDatabaseUrl() });
afterAll(() => pool.end());

async function appliedMigrations(): Promise<AppliedRow[]> {
  const { rows } = await pool.query<AppliedRow>(
    'select id, hash, created_at from drizzle.__drizzle_migrations order by id',
  );
  return rows;
}

describe('test database migration state', () => {
  test('the drizzle journal table exists', async () => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `select to_regclass('drizzle.__drizzle_migrations') is not null as exists`,
    );
    expect(rows[0].exists).toBe(true);
  });

  test('every migration in the folder is recorded, in order', async () => {
    const applied = await appliedMigrations();
    expect(applied.map((r) => r.hash)).toEqual(
      journal.entries.sort((a, b) => a.idx - b.idx).map((e) => hashOf(e.tag)),
    );
  });

  // The `when` timestamps travel into created_at, so a rewritten (rather than
  // appended) migration file shows up here even if the count still matches.
  test('recorded timestamps match the journal', async () => {
    const applied = await appliedMigrations();
    expect(applied.map((r) => Number(r.created_at))).toEqual(
      journal.entries.sort((a, b) => a.idx - b.idx).map((e) => e.when),
    );
  });
});
