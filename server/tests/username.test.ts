// Unit tests for createAccount's catch-branch contract — DB-free (stubbed db).
import { describe, test, expect } from 'vitest';
import type { Db } from '../src/db.js';
import { createAccount } from '../src/username.js';

// Minimal db stub: createAccount only ever calls db.insert(...).values(...).
// `values` is the awaited insert; we control whether it resolves or rejects.
function stubDb(values: () => Promise<unknown>): Db {
  return { insert: () => ({ values }) } as unknown as Db;
}

// A Postgres-shaped error carrying a SQLSTATE code, like node-postgres throws.
function pgError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('createAccount catch-branch contract', () => {
  test('propagates a non-23505 DB error instead of swallowing it', async () => {
    // 08006 = connection_failure — must surface to the caller, not vanish.
    const boom = pgError('connection terminated unexpectedly', '08006');
    const db = stubDb(() => Promise.reject(boom));

    await expect(createAccount(db, null)).rejects.toBe(boom);
  });

  test('propagates a non-23505 error even when it carries no .code', async () => {
    // A bare Error (no SQLSTATE) is still not a unique-violation, so it propagates.
    const boom = new Error('something else broke');
    const db = stubDb(() => Promise.reject(boom));

    await expect(createAccount(db, null)).rejects.toBe(boom);
  });

  test('treats a 23505 unique violation as a retry, not a failure (unchanged path)', async () => {
    // First attempt collides on the PK; second succeeds. createAccount must
    // swallow ONLY the 23505 and return the eventually-unique username.
    let calls = 0;
    const db = stubDb(() => {
      calls++;
      if (calls === 1) return Promise.reject(pgError('duplicate key value', '23505'));
      return Promise.resolve();
    });

    const username = await createAccount(db, null);
    expect(calls).toBe(2);
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  });
});
