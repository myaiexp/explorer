// @vitest-environment node
// A Postgres restart kills every connection, idle or checked out. The pool must
// drop them and keep serving: an 'error' event with no listener takes the whole
// process down.
import { afterAll, afterEach, beforeEach, describe, test, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { createDb } from '../src/db.js';
import { resolveTestDatabaseUrl } from './test-db.js';

const url = resolveTestDatabaseUrl();
const db = createDb(url);
const killer = new pg.Pool({ connectionString: url });

function terminate(pid: unknown) {
  return killer.query('select pg_terminate_backend($1)', [pid]);
}

async function expectPoolServes() {
  const { rows } = await db.$client.query<{ ok: number }>('select 1 as ok');
  expect(rows[0]!.ok).toBe(1);
}

describe('createDb pool', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logged.mockRestore();
  });

  afterAll(async () => {
    await db.$client.end();
    await killer.end();
  });

  test('survives an idle connection dying and serves the next query', async () => {
    const { rows } = await db.$client.query('select pg_backend_pid() as pid');

    await terminate(rows[0].pid);

    await vi.waitFor(() =>
      expect(logged).toHaveBeenCalledWith('pg pool idle client error:', expect.any(String)));
    await expectPoolServes();
  });

  test('survives a connection dying inside a transaction', async () => {
    const transaction = db.transaction(async (tx) => {
      const { rows } = await tx.execute(sql`select pg_backend_pid() as pid`);
      await terminate(rows[0]!.pid);
      await vi.waitFor(() =>
        expect(logged).toHaveBeenCalledWith('pg client error:', expect.any(String)));
      await tx.execute(sql`select 1`);
    });

    await expect(transaction).rejects.toThrow();
    await expectPoolServes();
  });
});
