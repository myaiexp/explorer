// Cross-process mutex on the shared wander_test database (idea #4042).
//
// Helm copies server/.env verbatim into every worktree, so every session's
// resolveTestDatabaseUrl() resolves to the SAME wander_test. truncateAll() runs
// in each file's beforeEach and scripts/reset-test-db.ts drops the schema
// outright, while vitest's fileParallelism:false only serializes files within
// ONE process. Two sessions running the server suite therefore truncate each
// other's rows mid-test — observed 2026-09-01 as 27 failed / 340 passed, then
// 367/367 on the immediate retry with no code change. Green code reporting
// failures is worse than a slow suite: a session cannot tell a collision from a
// regression without racing for an idle window.
//
// A Postgres advisory lock, not a lockfile, because it is held by the
// CONNECTION: a SIGKILLed session drops its socket and Postgres frees the lock,
// where a lockfile wedges every later run until someone deletes it by hand. It
// also lives in the very database being contended for, so it cannot disagree
// with what it protects.
//
// pg_TRY_advisory_lock in a poll loop rather than the blocking pg_advisory_lock:
// blocking forever on a wedged sibling is indistinguishable from a hung suite,
// and the bounded wait can say what is going on and how to get out of it.
import pg from 'pg';

// Stable 32-bit key: 0x77616e64 is 'wand' in ASCII. Any session locking the same
// database with the same key excludes the others; nothing else on this box uses
// advisory locks, but a namespaced key costs nothing.
export const SUITE_LOCK_KEY = 0x77616e64;

export interface AcquireDeps {
  /** One attempt. `true` when the lock is now held by us. */
  tryLock: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called at most once, when the wait gets long enough to look like a hang. */
  notify?: (message: string) => void;
}

export interface AcquireOpts {
  /** How long to keep retrying before giving up. */
  timeoutMs?: number;
  /** Gap between attempts. */
  pollMs?: number;
  /** Say something once the wait passes this. */
  noticeAfterMs?: number;
}

const DEFAULTS = {
  // Longer than any realistic server-suite run (~20 s), short enough that a
  // genuinely stuck lock surfaces inside a session rather than eating it.
  timeoutMs: 10 * 60_000,
  pollMs: 500,
  noticeAfterMs: 3_000,
};

/**
 * Retry `tryLock` until it succeeds. Returns how long it waited, in ms.
 * Throws with an actionable message rather than hanging when the timeout passes.
 */
export async function acquireLock(deps: AcquireDeps, opts: AcquireOpts = {}): Promise<number> {
  const { timeoutMs, pollMs, noticeAfterMs } = { ...DEFAULTS, ...opts };
  const started = deps.now();
  let notified = false;

  for (;;) {
    if (await deps.tryLock()) return deps.now() - started;

    const waited = deps.now() - started;
    if (waited >= timeoutMs) {
      throw new Error(
        `Timed out after ${Math.round(waited / 1000)}s waiting for the wander_test database lock.\n` +
          'Another session or process is running the server suite against the same database ' +
          '(every worktree shares one wander_test), and has not released it.\n' +
          'Point this run at a database of its own with TEST_DATABASE_URL=…_test, or find ' +
          'the holder with: select pid, query from pg_stat_activity where datname = \'wander_test\';',
      );
    }
    if (!notified && waited >= noticeAfterMs && deps.notify) {
      notified = true;
      deps.notify(
        `wander_test is busy — waiting for another session's server suite to finish. ` +
          `Every worktree shares this database; set TEST_DATABASE_URL to skip the wait.`,
      );
    }
    await deps.sleep(pollMs);
  }
}

export interface HeldSuiteLock {
  /** Postgres backend pid holding the lock — the handle for diagnosing a wedge. */
  backendPid: number;
  /** How long acquiring took, in ms. */
  waitedMs: number;
  /** Idempotent, and safe once the connection is already gone. */
  release: () => Promise<void>;
}

/**
 * Take the suite lock on `url` and hold it until `release()`.
 *
 * The lock lives on this one dedicated connection, so it is released by
 * `release()`, by the process exiting, or by the backend dying — whichever comes
 * first. Callers never have to clean up after a crash.
 */
export async function openSuiteLock(url: string, key = SUITE_LOCK_KEY): Promise<HeldSuiteLock> {
  const client = new pg.Client({ connectionString: url });
  // A dropped connection is an expected end for this client, not a crash: the
  // lock is SUPPOSED to die with it. Without a listener pg re-emits that as an
  // unhandled 'error' event, which takes the whole run down — so a Postgres
  // restart mid-suite would look like a test failure rather than a lost lock.
  client.on('error', () => {
    /* the lock went with the connection; nothing here to recover */
  });
  await client.connect();

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    // Best effort: the backend may already be gone (that is the whole point of
    // using a connection-scoped lock), and throwing in a teardown would mask the
    // failure that actually matters.
    try {
      await client.end();
    } catch {
      /* connection already closed — the lock went with it */
    }
  };

  try {
    const waitedMs = await acquireLock({
      tryLock: async () => {
        const res = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
          key,
        ]);
        return res.rows[0].ok;
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      notify: (m) => console.warn(`⏳ ${m}`),
    });

    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    return { backendPid: rows[0].pid, waitedMs, release };
  } catch (err) {
    await release();
    throw err;
  }
}
