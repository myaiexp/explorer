// Pins the cross-process mutex on the shared wander_test database (idea #4042).
//
// Every worktree gets a verbatim copy of server/.env, so every session's
// resolveTestDatabaseUrl() lands on the ONE wander_test database. truncateAll()
// runs in each file's beforeEach and reset-test-db.ts drops the schema outright,
// while vitest's fileParallelism:false only serializes files WITHIN one process.
// Two sessions therefore truncate each other's rows mid-test: 27 failed / 340
// passed on 2026-09-01, then 367/367 on the immediate retry with no code change.
// A session cannot tell a real regression from a collision without racing for an
// idle window.
//
// Two halves, matching the two things that can go wrong:
//  - the wait policy (pure, fake clock): acquire, retry, notify once, give up
//    with an actionable message rather than hanging forever.
//  - the lock itself, against the real database: two connections, and the second
//    genuinely cannot take what the first holds.
import { describe, test, expect, vi } from 'vitest';
import pg from 'pg';
import { acquireLock, openSuiteLock, SUITE_LOCK_KEY } from './suite-lock.js';
import { resolveTestDatabaseUrl } from './test-db.js';

// A fake clock: sleep() advances time instead of waiting, so the retry policy is
// tested in microseconds and the assertions are exact rather than approximate.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('acquireLock — the wait policy', () => {
  test('an uncontended lock is taken immediately, with no sleeping', async () => {
    const clock = fakeClock();
    const tryLock = vi.fn(async () => true);
    const sleep = vi.fn(clock.sleep);

    const waited = await acquireLock({ tryLock, sleep, now: clock.now });

    expect(waited).toBe(0);
    expect(tryLock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  test('a held lock is retried until it frees, and reports how long it waited', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const tryLock = vi.fn(async () => ++attempts >= 4);

    const waited = await acquireLock(
      { tryLock, sleep: clock.sleep, now: clock.now },
      { pollMs: 250 },
    );

    expect(tryLock).toHaveBeenCalledTimes(4);
    expect(waited).toBe(750); // three sleeps between the four attempts
  });

  // Hanging forever is the failure mode a naive pg_advisory_lock() would have:
  // a wedged sibling session would look exactly like a hung test suite.
  test('gives up after the timeout rather than blocking forever', async () => {
    const clock = fakeClock();
    const tryLock = vi.fn(async () => false);

    await expect(
      acquireLock({ tryLock, sleep: clock.sleep, now: clock.now }, { pollMs: 100, timeoutMs: 500 }),
    ).rejects.toThrow(/wander_test/);
  });

  test('the give-up message says what is holding it and what to do', async () => {
    const clock = fakeClock();
    const err: unknown = await acquireLock(
      { tryLock: async () => false, sleep: clock.sleep, now: clock.now },
      { pollMs: 100, timeoutMs: 300 },
    ).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/another/i); // another session/process holds it
    expect((err as Error).message).toMatch(/TEST_DATABASE_URL/); // the escape: your own DB
  });

  // Silence during a 40s wait reads as a hang; a line every poll is noise.
  test('notifies once when the wait gets long, not on every poll', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const notify = vi.fn();

    await acquireLock(
      { tryLock: async () => ++attempts >= 10, sleep: clock.sleep, now: clock.now, notify },
      { pollMs: 100, noticeAfterMs: 200 },
    );

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/wait/i);
  });

  test('says nothing at all when the lock was free', async () => {
    const clock = fakeClock();
    const notify = vi.fn();
    await acquireLock({ tryLock: async () => true, sleep: clock.sleep, now: clock.now, notify });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('openSuiteLock — against the real database', () => {
  // A key of its own: globalSetup already holds SUITE_LOCK_KEY for the whole run,
  // so testing exclusion on that key would only observe our own setup.
  const PROBE_KEY = SUITE_LOCK_KEY + 1;

  test('a second connection cannot take a held lock, and can once it is released', async () => {
    const url = resolveTestDatabaseUrl();
    const held = await openSuiteLock(url, PROBE_KEY);

    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      const before = await other.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
        PROBE_KEY,
      ]);
      expect(before.rows[0].ok).toBe(false);

      await held.release();

      const after = await other.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
        PROBE_KEY,
      ]);
      expect(after.rows[0].ok).toBe(true);
      await other.query('select pg_advisory_unlock($1)', [PROBE_KEY]);
    } finally {
      await other.end();
    }
  });

  // The reason an advisory lock beats a lockfile: there is no stale state to
  // clean up. A SIGKILLed session drops its connection and Postgres releases the
  // lock, where a lockfile would wedge every later run until someone deleted it.
  test('the lock dies with its connection, so a killed session cannot wedge the next one', async () => {
    const url = resolveTestDatabaseUrl();
    const held = await openSuiteLock(url, PROBE_KEY);

    // Kill the backend from another connection — the crash case, without a crash.
    const other = new pg.Client({ connectionString: url });
    await other.connect();
    try {
      await other.query('select pg_terminate_backend($1)', [held.backendPid]);
      const taken = await other.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
        PROBE_KEY,
      ]);
      expect(taken.rows[0].ok).toBe(true);
      await other.query('select pg_advisory_unlock($1)', [PROBE_KEY]);
    } finally {
      await other.end();
      // release() must survive its connection already being gone — teardown runs
      // after a crash too, and throwing there would mask the real failure.
      await expect(held.release()).resolves.toBeUndefined();
    }
  });
});
