import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import type { PgTable, PgColumn, PgInsertValue } from 'drizzle-orm/pg-core';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { isObject, isArray, type AnyRecord } from '../lib/type-guards.js';
import {
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_ROWS_PER_SECTION,
} from '../lib/validate-fields.js';
import { accountAuth } from '../middleware/auth.js';
import { sectionWriteRateLimit } from '../middleware/rate-limit.js';
import {
  validateTripRow,
  validateVisitRow,
  validateFavoriteRow,
  validateSavedLocationRow,
  type RowResult,
} from '../lib/validate-rows.js';

// The four import tables share only the columns this route touches: a username
// owner (delete key) — enough to drive the generic replace transaction below.
type UserTable = PgTable & { username: PgColumn };

// Bulk import wants a null short-circuit rather than an error string. Every
// section adapter is the same three steps over a shared validator
// (lib/validate-rows.ts): guard the row is an object, delegate with the row's own
// `id` as identity (per-row PUT uses the path id instead), and collapse any
// { error } to null. `nullable` names that pattern once, so deriving a validator
// for a fifth section is a one-liner. Coordinate-shape validation lives inside
// validateTripRow, so these no longer need the assertRouteCoords try/catch the
// import loops used to repeat.
function nullable<T>(
  validate: (id: unknown, username: string, body: AnyRecord) => RowResult<T>,
): (row: unknown, username: string) => T | null {
  return (row, username) => {
    if (!isObject(row)) return null;
    const res = validate(row.id, username, row);
    return 'error' in res ? null : res.row;
  };
}

export const validateRouteRow = nullable(validateTripRow);
export const validateVisit = nullable(validateVisitRow);
const validateFavorite = nullable(validateFavoriteRow);
const validateSavedLocation = nullable(validateSavedLocationRow);

// History rows are exactly the shared trip shape (no poiCategory) — same core.
export const validateHistoryRow = validateRouteRow;

export function importRoutes(db: Db): Hono {
  const app = new Hono();

  // Reject oversized bodies before c.req.json() buffers them (audit #1343).
  // Larger than the per-row PUT cap because a full-account backup is four
  // sections; still hard-bounded so memory can't grow with attacker intent.
  const importBodyLimit = bodyLimit({
    maxSize: MAX_IMPORT_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

  // POST /:username/import — replace all four sections atomically. Auth (token)
  // confirms account ownership; the write rate limit caps replace-all churn.
  app.post(
    '/:username/import',
    sectionWriteRateLimit(),
    accountAuth(db),
    importBodyLimit,
    async (c) => {
    const username = c.req.param('username')!;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!isObject(body)) {
      return c.json({ error: 'Body must be an object' }, 400);
    }

    const knownKeys = new Set(['visits', 'favorites', 'savedLocations', 'history']);
    for (const key of Object.keys(body)) {
      if (!knownKeys.has(key)) {
        return c.json({ error: `Unknown section: ${key}` }, 400);
      }
    }

    const rawVisits = body.visits ?? [];
    const rawFavorites = body.favorites ?? [];
    const rawSavedLocations = body.savedLocations ?? [];
    const rawHistory = body.history ?? [];

    if (!isArray(rawVisits) || !isArray(rawFavorites) || !isArray(rawSavedLocations) || !isArray(rawHistory)) {
      return c.json({ error: 'Each section must be an array' }, 400);
    }

    // One descriptor per section: the error key for a bad row, its table, the
    // raw rows to validate, and the adapter that turns a raw row into an insert
    // row (or null to reject). This single list drives both the validate loop
    // and the replace transaction, so the 400 shape and the delete/insert
    // structure each live in exactly one place.
    const sections: Array<{
      key: string;
      table: UserTable;
      raw: unknown[];
      validate: (row: unknown, username: string) => object | null;
    }> = [
      { key: 'visit', table: schema.visits, raw: rawVisits, validate: validateVisit },
      { key: 'favorite', table: schema.favorites, raw: rawFavorites, validate: validateFavorite },
      { key: 'savedLocation', table: schema.savedLocations, raw: rawSavedLocations, validate: validateSavedLocation },
      { key: 'history', table: schema.history, raw: rawHistory, validate: validateHistoryRow },
    ];

    // Validate every row up front — a single bad row 400s before any write.
    // Also reject duplicate ids within a section: the composite PK (username, id)
    // would abort the insert with an opaque 500 otherwise (idea #2485).
    // Per-section row cap (audit #1343) rejects huge arrays before we allocate
    // the validated-row buffers; routeCoords length is already capped inside
    // validateTripRow → assertRouteCoords.
    const collected: Array<{ table: UserTable; rows: object[] }> = [];
    for (const { key, table, raw, validate } of sections) {
      if (raw.length > MAX_IMPORT_ROWS_PER_SECTION) {
        return c.json(
          { error: `${key} section exceeds maximum of ${MAX_IMPORT_ROWS_PER_SECTION} rows` },
          400
        );
      }
      const rows: object[] = [];
      const seenIds = new Set<string>();
      for (const row of raw) {
        const validated = validate(row, username);
        if (!validated) return c.json({ error: `Invalid ${key} row` }, 400);
        const id = (validated as { id?: unknown }).id;
        if (typeof id === 'string') {
          if (seenIds.has(id)) {
            return c.json({ error: `Duplicate ${key} id: ${id}` }, 400);
          }
          seenIds.add(id);
        }
        rows.push(validated);
      }
      collected.push({ table, rows });
    }

    // Atomic replace: wipe all four sections, then re-insert (same table order).
    // The generic row type is opaque to TS at this boundary, hence the cast.
    await db.transaction(async (tx) => {
      for (const { table } of collected) {
        await tx.delete(table).where(eq(table.username, username));
      }
      for (const { table, rows } of collected) {
        if (rows.length > 0) await tx.insert(table).values(rows as PgInsertValue<UserTable>[]);
      }
    });

    return new Response(null, { status: 204 });
  });

  return app;
}
