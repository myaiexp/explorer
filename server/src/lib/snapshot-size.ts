// Stored-JSONB size estimate for GET /:username ?geometry=full and the
// per-account write budget (finding #7756).
import { sql, type SQLWrapper } from 'drizzle-orm';
import { schema } from '../db.js';
import { FAVORITE_PAYLOAD_BYTES_SQL, ROUTE_PAIR_BYTES_SQL } from './jsonb-bytes-sql.js';
import { MAX_STORED_BYTES } from './limits.js';

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
// `?geometry=full`. octet_length(::text) is the on-disk text, which is larger
// than compact JSON.stringify (spaces, key order). pg_column_size is
// TOAST-compressed and would under-count a repeat-char blob. Saved-location
// rows are skipped — they are already length-capped text.
export async function estimateStoredSnapshotBytes(
  db: Executor,
  username: string,
): Promise<number> {
  const result = await db.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(${sql.raw(ROUTE_PAIR_BYTES_SQL)})
        FROM visits WHERE username = ${username}
      ), 0)
      + COALESCE((
        SELECT SUM(${sql.raw(ROUTE_PAIR_BYTES_SQL)})
        FROM history WHERE username = ${username}
      ), 0)
      + COALESCE((
        SELECT SUM(${sql.raw(FAVORITE_PAYLOAD_BYTES_SQL)})
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
          SELECT ${sql.raw(FAVORITE_PAYLOAD_BYTES_SQL)} AS bytes
          FROM favorites WHERE username = ${username} AND id = ${id}
        `)
      : table === schema.history
        ? await db.execute(sql`
            SELECT ${sql.raw(ROUTE_PAIR_BYTES_SQL)} AS bytes
            FROM history WHERE username = ${username} AND id = ${id}
          `)
        : await db.execute(sql`
            SELECT ${sql.raw(ROUTE_PAIR_BYTES_SQL)} AS bytes
            FROM visits WHERE username = ${username} AND id = ${id}
          `);
  return bytesFrom(result);
}

// Postgres jsonb::text is not JSON.stringify. It inserts a space after ',' and
// ':', and orders object keys by byte length then memcmp. Compact JSON
// under-counts a coordinate array by about a tenth, which makes the 32 MiB
// cap soft. null/undefined/unserializable → 0, matching COALESCE(octet_length(...), 0).
function cmpJsonbKey(a: string, b: string): number {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return ab.length - bb.length;
  return Buffer.compare(ab, bb);
}

function jsonbText(value: unknown): string | null {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((el) => jsonbText(el) ?? 'null');
    return `[${parts.join(', ')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((key) => jsonbText(obj[key]) !== null);
    keys.sort(cmpJsonbKey);
    const parts = keys.map((key) => `${JSON.stringify(key)}: ${jsonbText(obj[key])}`);
    return `{${parts.join(', ')}}`;
  }
  return null;
}

export function storedJsonbBytes(value: unknown): number {
  // A missing column is SQL NULL, and COALESCE(octet_length(NULL), 0) is 0 —
  // not the 4 bytes of a JSON null literal stored inside a document.
  if (value === undefined || value === null) return 0;
  const text = jsonbText(value);
  if (text === null) return 0;
  return Buffer.byteLength(text, 'utf8');
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
