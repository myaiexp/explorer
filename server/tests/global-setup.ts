// Hold the wander_test lock for the whole vitest run (idea #4042).
//
// fileParallelism:false serializes files inside ONE process. This serializes the
// PROCESSES, which is the half that was missing: every worktree carries a copy of
// the same server/.env, so four parallel grind sessions all truncate the same
// wander_test in each other's beforeEach. Green code reported 27 failures on
// 2026-09-01 and 367/367 on the retry.
//
// globalSetup runs once per `vitest run`, before any file, and its returned
// teardown runs after the last one — exactly the span the lock has to cover.
//
// Setting TEST_DATABASE_URL to a database of your own needs no opt-out: the lock
// is taken on whatever database the run resolves to, so a private one is
// uncontended by construction.
import { openSuiteLock } from './suite-lock.js';
import { resolveTestDatabaseUrl, dbNameOf } from './test-db.js';

export default async function setup(): Promise<() => Promise<void>> {
  const url = resolveTestDatabaseUrl();
  const lock = await openSuiteLock(url);
  // Only when the wait was real. Acquiring costs a few ms even uncontended, and
  // "after 0.0s" on every run is the kind of line people stop reading.
  if (lock.waitedMs >= 1000) {
    console.log(`Acquired ${dbNameOf(url)} after ${(lock.waitedMs / 1000).toFixed(1)}s.`);
  }
  return () => lock.release();
}
