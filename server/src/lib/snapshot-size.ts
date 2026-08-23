// Stored-JSONB size estimate for GET /:username ?geometry=full
import { sql } from 'drizzle-orm';
import type { Db } from '../db.js';

// Uncompressed JSON-text bytes of the fat columns GET would serialize under
// `?geometry=full`. octet_length(::text) matches JSON.stringify better than
// pg_column_size (which is TOAST-compressed and would under-count a repeat-char
// blob). Saved-location rows are skipped — they are already length-capped text.
export async function estimateStoredSnapshotBytes(db: Db, username: string): Promise<number> {
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
  const row = firstRow(result);
  const bytes = row?.bytes;
  const n = typeof bytes === 'number' ? bytes : Number(bytes);
  return Number.isFinite(n) ? n : 0;
}

function firstRow(result: unknown): { bytes?: unknown } | undefined {
  if (Array.isArray(result)) return result[0] as { bytes?: unknown };
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows[0] as { bytes?: unknown };
  }
  return undefined;
}
