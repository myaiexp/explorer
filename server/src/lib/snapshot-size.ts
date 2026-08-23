// Stored-JSONB size estimate for GET /:username ?geometry=full and the
// per-account write budget (finding #7756).
import { sql, type SQLWrapper } from 'drizzle-orm';
import { schema } from '../db.js';
import { MAX_STORED_BYTES } from './validate-fields.js';

// drizzle `db` and `tx` both expose execute(); this is the overlap so the PUT
// transaction can reuse the same estimator under the account-row lock.
type Executor = { execute: (query: SQLWrapper) => PromiseLike<unknown> };

function firstRow(result: unknown): { bytes?: unknown } | undefined {
  if (Array.isArray(result)) return result[0] as { bytes?: unknown };
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows[0] as { bytes?: unknown };
  }
  return undefined;
}

function bytesFrom(result: unknown): number {
  const bytes = firstRow(result)?.bytes;
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  return Number.isFinite(n) ? n : 0;
}

// Uncompressed JSON-text bytes of the fat columns GET would serialize under
// `?geometry=full`. octet_length(::text) matches JSON.stringify better than
// pg_column_size (which is TOAST-compressed and would under-count a repeat-char
// blob). Saved-location rows are skipped — they are already length-capped text.
export async function estimateStoredSnapshotBytes(
  db: Executor,
  username: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(
          COALESCE(octet_length(route_coords::text), 0)
          + COALESCE(octet_length(return_route_coords::text), 0)
        ) FROM visits WHERE username = ${username}
      ), 0)
      + COALESCE((
        SELECT SUM(
          COALESCE(octet_length(route_coords::text), 0)
          + COALESCE(octet_length(return_route_coords::text), 0)
        ) FROM history WHERE username = ${username}
      ), 0)
      + COALESCE((
        SELECT SUM(COALESCE(octet_length(payload::text), 0))
        FROM favorites WHERE username = ${username}
      ), 0)
      AS bytes
  `);
  return bytesFrom(result);
}

// octet_length of one existing row's fat columns. 0 if the row is missing or
// the table has no jsonb (saved_locations). Used so a PUT update is charged
// the delta, not the whole new payload on top of the old one.
export async function estimateRowStoredBytes(
  db: Executor,
  table: unknown,
  username: string,
  id: string,
): Promise<number> {
  if (table === schema.savedLocations) return 0;
  const result =
    table === schema.favorites
      ? await db.execute(sql`
          SELECT COALESCE(octet_length(payload::text), 0) AS bytes
          FROM favorites WHERE username = ${username} AND id = ${id}
        `)
      : table === schema.history
        ? await db.execute(sql`
            SELECT
              COALESCE(octet_length(route_coords::text), 0)
              + COALESCE(octet_length(return_route_coords::text), 0) AS bytes
            FROM history WHERE username = ${username} AND id = ${id}
          `)
        : await db.execute(sql`
            SELECT
              COALESCE(octet_length(route_coords::text), 0)
              + COALESCE(octet_length(return_route_coords::text), 0) AS bytes
            FROM visits WHERE username = ${username} AND id = ${id}
          `);
  return bytesFrom(result);
}

// UTF-8 byte length of JSON.stringify — the write-path twin of
// octet_length(::text). null/undefined/unserializable → 0, matching
// COALESCE(octet_length(...), 0).
export function storedJsonbBytes(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const s = JSON.stringify(value);
  if (typeof s !== 'string') return 0;
  return Buffer.byteLength(s, 'utf8');
}

export function incomingJsonbBytes(table: unknown, row: object): number {
  const r = row as { payload?: unknown; routeCoords?: unknown; returnRouteCoords?: unknown };
  if (table === schema.favorites) return storedJsonbBytes(r.payload);
  if (table === schema.visits || table === schema.history) {
    return storedJsonbBytes(r.routeCoords) + storedJsonbBytes(r.returnRouteCoords);
  }
  return 0;
}

// True when a write grows stored jsonb AND the result would sit above the
// per-account budget. Shrinks and no-ops pass even if the account is already
// over (so a legacy fill can still be repaired). Exact equality is allowed.
export function wouldExceedStoredBudget(
  incomingBytes: number,
  currentBytes = 0,
  oldRowBytes = 0,
): boolean {
  const projected = currentBytes - oldRowBytes + incomingBytes;
  return projected > MAX_STORED_BYTES && incomingBytes > oldRowBytes;
}
