// Cursor-paged section reads for GET /:username/archive/:section
import { and, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { ARCHIVE_PAGE_MAX_BYTES } from './validate-fields.js';

export const ARCHIVE_SECTIONS = ['visits', 'history', 'favorites', 'savedLocations'] as const;
export type ArchiveSection = (typeof ARCHIVE_SECTIONS)[number];

export function isArchiveSection(v: string): v is ArchiveSection {
  return (ARCHIVE_SECTIONS as readonly string[]).includes(v);
}

// Physical table/column names and the per-row stored-jsonb expression, one entry
// per section. Every value here is a compile-time constant — none of it is ever
// built from request input — which is what makes the sql.raw() interpolation
// below safe (same rule as favorite-snapshot.ts's LIGHT_PAYLOAD_SQL).
const SECTION_SQL: Record<ArchiveSection, { table: string; sortColumn: string; bytes: string }> = {
  visits: {
    table: 'visits',
    sortColumn: 'date',
    bytes: 'COALESCE(octet_length(route_coords::text), 0) + COALESCE(octet_length(return_route_coords::text), 0)',
  },
  history: {
    table: 'history',
    sortColumn: 'date',
    bytes: 'COALESCE(octet_length(route_coords::text), 0) + COALESCE(octet_length(return_route_coords::text), 0)',
  },
  favorites: {
    table: 'favorites',
    sortColumn: 'updated_at',
    bytes: 'COALESCE(octet_length(payload::text), 0)',
  },
  // No jsonb column — the row count is the only bound that applies here.
  savedLocations: { table: 'saved_locations', sortColumn: 'updated_at', bytes: '0' },
};

// ── Cursor ───────────────────────────────────────────────────────────────────

// Keyset position: the sort timestamp plus the id that broke its tie. Both are
// needed — visits imported in one batch share a date, and a date-only cursor
// would then skip or repeat rows across the tie.
interface Cursor {
  k: string;
  i: string;
}

// The exact shape to_char emits below. Cursors are opaque and only ever produced
// by nextCursor, so anything else is a client that built one by hand: reject it
// here rather than letting Postgres raise 22007 out of the ::timestamptz cast.
const CURSOR_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(JSON.stringify({ k: sortKey, i: id }), 'utf8').toString('base64url');
}

// null on anything unparseable — the caller turns that into a 400.
export function decodeCursor(raw: string): Cursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { k, i } = parsed as { k?: unknown; i?: unknown };
  if (typeof k !== 'string' || typeof i !== 'string' || !i) return null;
  if (!CURSOR_STAMP.test(k)) return null;
  return { k, i };
}

// ── Page selection ───────────────────────────────────────────────────────────

interface KeyRow {
  id: string;
  sort_key: string;
  running: number;
}

function resultRows(result: unknown): KeyRow[] {
  if (Array.isArray(result)) return result as KeyRow[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as KeyRow[];
  }
  return [];
}

// The keys of one page, newest-first, WITHOUT touching the fat columns: the
// running byte total is computed in Postgres so the row that would blow the
// budget is never serialized into Node at all. Fetches limit+1 so the caller can
// tell a full page from the last one without a second round trip.
async function selectPageKeys(
  db: { execute: (q: SQLWrapper) => PromiseLike<unknown> },
  section: ArchiveSection,
  username: string,
  limit: number,
  cursor: Cursor | null,
): Promise<KeyRow[]> {
  const { table, sortColumn, bytes } = SECTION_SQL[section];
  const col = sql.raw(sortColumn);
  const after = cursor
    ? sql`AND (${col}, id) < (${cursor.k}::timestamptz, ${cursor.i})`
    : sql``;

  const result = await db.execute(sql`
    SELECT
      id,
      to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_key,
      SUM(${sql.raw(bytes)}) OVER (
        ORDER BY ${col} DESC, id DESC ROWS UNBOUNDED PRECEDING
      ) AS running
    FROM ${sql.raw(table)}
    WHERE username = ${username} ${after}
    ORDER BY ${col} DESC, id DESC
    LIMIT ${limit + 1}
  `);

  return resultRows(result).map((r) => ({
    id: String(r.id),
    sort_key: String(r.sort_key),
    running: Number(r.running) || 0,
  }));
}

// Full rows for a bounded id list, through drizzle so the response carries the
// same camelCase shape as GET /:username. The raw keys query above cannot be
// reused for this — it returns snake_case straight off the driver.
function selectRowsByIds(db: Db, section: ArchiveSection, username: string, ids: string[]) {
  switch (section) {
    case 'visits':
      return db.select().from(schema.visits)
        .where(and(eq(schema.visits.username, username), inArray(schema.visits.id, ids)));
    case 'history':
      return db.select().from(schema.history)
        .where(and(eq(schema.history.username, username), inArray(schema.history.id, ids)));
    case 'favorites':
      return db.select().from(schema.favorites)
        .where(and(eq(schema.favorites.username, username), inArray(schema.favorites.id, ids)));
    case 'savedLocations':
      return db.select().from(schema.savedLocations)
        .where(and(eq(schema.savedLocations.username, username), inArray(schema.savedLocations.id, ids)));
  }
}

export interface ArchivePage {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

// One page of a section, newest-first, with stored geometry intact.
export async function selectArchivePage(
  db: Db,
  section: ArchiveSection,
  username: string,
  limit: number,
  cursor: Cursor | null,
): Promise<ArchivePage> {
  const keys = await selectPageKeys(db, section, username, limit, cursor);
  if (keys.length === 0) return { rows: [], nextCursor: null };

  // Cut at whichever bound binds first. The first row is taken unconditionally:
  // a row on its own over the budget must still come back, or the walk stalls on
  // it forever and the archive below it is unreachable.
  const kept: KeyRow[] = [];
  for (const k of keys) {
    if (kept.length === 0) { kept.push(k); continue; }
    if (kept.length >= limit || k.running > ARCHIVE_PAGE_MAX_BYTES) break;
    kept.push(k);
  }

  const order = new Map(kept.map((k, i) => [k.id, i]));
  const rows = await selectRowsByIds(db, section, username, kept.map((k) => k.id));
  const ordered = (rows as Array<Record<string, unknown>>)
    .slice()
    .sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);

  const last = kept[kept.length - 1]!;
  return {
    rows: ordered,
    // More below iff something was left uncut — either the byte bound stopped us
    // short or the limit+1 probe row came back.
    nextCursor: kept.length < keys.length ? encodeCursor(last.sort_key, last.id) : null,
  };
}
