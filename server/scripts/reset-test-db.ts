// Rebuild wander_test from the migration chain — schema AND drizzle journal.
//
// Idea #3615: wander_test had every table but zero rows in
// drizzle.__drizzle_migrations, so `drizzle-kit migrate` against it replayed
// 0000 CREATE TABLE and died. That state is unreachable from here: the script
// drops the schema and replays the whole chain through drizzle-orm's migrator,
// which writes the journal as it goes. Idempotent — run it whenever
// tests/migrations.test.ts goes red, and on a fresh box after `createdb`.
//
// It DROPS EVERYTHING in the target database. The only thing standing between
// that and production is resolveTestDatabaseUrl's hard `_test`-suffix throw
// (server/tests/test-db.ts) — the same guard truncateAll() relies on, reused
// rather than re-implemented so there is exactly one place to get it right.
// Helm copies the prod .env into every worktree, so this is not theoretical.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveTestDatabaseUrl, dbNameOf } from '../tests/test-db.js';
import { openSuiteLock } from '../tests/suite-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const url = resolveTestDatabaseUrl();
  const name = dbNameOf(url);

  // Same lock the suite holds (idea #4042). Every worktree resolves to this one
  // database, and dropping the schema out from under a sibling session's running
  // suite is the worst case of that contention — worse than the truncate races,
  // because the tables come back empty AND the journal is rewritten.
  const lock = await openSuiteLock(url);
  console.log(`Resetting test database "${name}" …`);

  const pool = new pg.Pool({ connectionString: url });
  try {
    // `drizzle` holds the journal table; dropping it too is what makes a
    // half-migrated database recoverable rather than something to hand-stamp.
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema if exists public cascade');
    await pool.query('create schema public');

    await migrate(drizzle(pool), {
      migrationsFolder: resolve(__dirname, '../drizzle'),
    });

    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from drizzle.__drizzle_migrations',
    );
    console.log(`Applied ${rows[0].n} migration(s). "${name}" is at head.`);
  } finally {
    await pool.end();
    await lock.release();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
