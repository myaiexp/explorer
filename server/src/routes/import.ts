import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { PgTable, PgColumn, PgInsertValue } from 'drizzle-orm/pg-core';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { isObject, isArray } from '../lib/type-guards.js';
import { accountAuth } from '../middleware/auth.js';
import { sectionWriteRateLimit } from '../middleware/rate-limit.js';
import {
  validateTripRow,
  validateVisitRow,
  validateFavoriteRow,
  validateSavedLocationRow,
} from '../lib/validate-rows.js';

// The four import tables share only the columns this route touches: a username
// owner (delete key) — enough to drive the generic replace transaction below.
type UserTable = PgTable & { username: PgColumn };

// Bulk import wants a null short-circuit rather than an error string, so each
// section is a thin adapter over the shared validator (lib/validate-rows.ts):
// guard the row is an object, delegate, and collapse any { error } to null. The
// row's own `id` is the identity here (per-row PUT uses the path id instead).
// Coordinate-shape validation lives inside validateTripRow, so these no longer
// need the assertRouteCoords try/catch the import loops used to repeat.
export function validateRouteRow(row: unknown, username: string): typeof schema.history.$inferInsert | null {
  if (!isObject(row)) return null;
  const res = validateTripRow(row.id, username, row);
  return 'error' in res ? null : res.row;
}

export function validateVisit(row: unknown, username: string): typeof schema.visits.$inferInsert | null {
  if (!isObject(row)) return null;
  const res = validateVisitRow(row.id, username, row);
  return 'error' in res ? null : res.row;
}

function validateFavorite(row: unknown, username: string): typeof schema.favorites.$inferInsert | null {
  if (!isObject(row)) return null;
  const res = validateFavoriteRow(row.id, username, row);
  return 'error' in res ? null : res.row;
}

function validateSavedLocation(row: unknown, username: string): typeof schema.savedLocations.$inferInsert | null {
  if (!isObject(row)) return null;
  const res = validateSavedLocationRow(row.id, username, row);
  return 'error' in res ? null : res.row;
}

// History rows are exactly the shared trip shape (no poiCategory) — thin delegate.
export function validateHistoryRow(row: unknown, username: string): typeof schema.history.$inferInsert | null {
  return validateRouteRow(row, username);
}

export function importRoutes(db: Db): Hono {
  const app = new Hono();

  // POST /:username/import — replace all four sections atomically. Auth (token)
  // confirms account ownership; the write rate limit caps replace-all churn.
  app.post('/:username/import', sectionWriteRateLimit(), accountAuth(db), async (c) => {
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
    const collected: Array<{ table: UserTable; rows: object[] }> = [];
    for (const { key, table, raw, validate } of sections) {
      const rows: object[] = [];
      for (const row of raw) {
        const validated = validate(row, username);
        if (!validated) return c.json({ error: `Invalid ${key} row` }, 400);
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
