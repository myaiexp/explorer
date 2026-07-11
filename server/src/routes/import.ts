import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
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

    // Validate all rows before writing
    const visitRows: (typeof schema.visits.$inferInsert)[] = [];
    for (const row of rawVisits) {
      const validated = validateVisit(row, username);
      if (!validated) return c.json({ error: 'Invalid visit row' }, 400);
      visitRows.push(validated);
    }

    const favoriteRows: (typeof schema.favorites.$inferInsert)[] = [];
    for (const row of rawFavorites) {
      const validated = validateFavorite(row, username);
      if (!validated) return c.json({ error: 'Invalid favorite row' }, 400);
      favoriteRows.push(validated);
    }

    const savedLocationRows: (typeof schema.savedLocations.$inferInsert)[] = [];
    for (const row of rawSavedLocations) {
      const validated = validateSavedLocation(row, username);
      if (!validated) return c.json({ error: 'Invalid savedLocation row' }, 400);
      savedLocationRows.push(validated);
    }

    const historyRows: (typeof schema.history.$inferInsert)[] = [];
    for (const row of rawHistory) {
      const validated = validateHistoryRow(row, username);
      if (!validated) return c.json({ error: 'Invalid history row' }, 400);
      historyRows.push(validated);
    }

    // Atomic replace inside a transaction
    await db.transaction(async (tx) => {
      await tx.delete(schema.visits).where(eq(schema.visits.username, username));
      await tx.delete(schema.favorites).where(eq(schema.favorites.username, username));
      await tx.delete(schema.savedLocations).where(eq(schema.savedLocations.username, username));
      await tx.delete(schema.history).where(eq(schema.history.username, username));

      if (visitRows.length > 0) await tx.insert(schema.visits).values(visitRows);
      if (favoriteRows.length > 0) await tx.insert(schema.favorites).values(favoriteRows);
      if (savedLocationRows.length > 0) await tx.insert(schema.savedLocations).values(savedLocationRows);
      if (historyRows.length > 0) await tx.insert(schema.history).values(historyRows);
    });

    return new Response(null, { status: 204 });
  });

  return app;
}
