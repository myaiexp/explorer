// Shared fake Db and request helpers for the sections route unit tests
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { hashToken } from '../lib/token-hash.js';

// Captures the single insert/delete op a handler issues against the fake Db.
export interface RecordedOp {
  op: 'insert' | 'delete';
  table: unknown;
  row?: Record<string, unknown>;
  conf?: { target: unknown; set: Record<string, unknown> };
}

// Fake Db reproducing the exact drizzle call chains the handlers use:
//   auth:   db.select({...}).from(accounts).where(c)        -> rows[]
//   upsert: db.insert(t).values(row).onConflictDoUpdate     -> void
//   delete: db.delete(t).where(c)                           -> void
// `userExists` models whether the account row exists: true → the select returns
// the account (auth finds a matching token), false → [] (auth 401s). The handlers
// no longer re-check existence themselves — accountAuth is the sole gate.
export function makeFakeDb(opts: {
  userExists: boolean;
  rowCount?: number;
  hasExistingRow?: boolean;
  storedBytes?: number;
}) {
  const ops: RecordedOp[] = [];
  const db = {
    select(shape?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          return {
            where() {
              // Auth middleware hashes the presented bearer and compares to
              // `.token` (a SHA-256 digest) on row 0.
              if (table === schema.accounts) {
                return Promise.resolve(
                  opts.userExists ? [{ username: 'alice', token: hashToken('sekret') }] : []
                );
              }
              if (shape && 'n' in shape) {
                return Promise.resolve([{ n: opts.rowCount ?? 0 }]);
              }
              return Promise.resolve(opts.hasExistingRow ? [{ id: 'existing' }] : []);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          return {
            onConflictDoUpdate(conf: { target: unknown; set: Record<string, unknown> }) {
              ops.push({ op: 'insert', table, row, conf });
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          ops.push({ op: 'delete', table });
          return Promise.resolve();
        },
      };
    },
    execute() {
      // FOR UPDATE ignores the result; stored-bytes helpers read `.bytes`.
      return Promise.resolve([{ bytes: opts.storedBytes ?? 0 }]);
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db);
    },
  };
  return { db: db as unknown as Db, ops };
}

// Valid auth for the fake account (plaintext bearer; the fake row stores the hash).
export const AUTH = { Authorization: 'Bearer sekret' };

export function jsonReq(method: 'PUT', body: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...AUTH },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// A minimal valid trip body (visits/history share this shape).
export function validTrip(extra: Record<string, unknown> = {}) {
  return {
    date: '2026-06-02T10:00:00Z',
    startLat: 60.1,
    startLng: 24.9,
    destLat: 60.2,
    destLng: 25.0,
    distance: 1234,
    ...extra,
  };
}
