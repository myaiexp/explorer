import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { assertRouteCoords, RouteCoordsError } from '../lib/route-coords.js';
import { isObject, isArray } from '../lib/type-guards.js';

// Shared validation + normalization for route-shaped rows. `visits` and `history` have an
// identical column shape except `visits` also carries `poiCategory`, so both call sites reuse
// this core and `validateVisit` grafts the extra field on top. Returns the common (history)
// insert shape, or null if any required field is missing/mistyped.
export function validateRouteRow(row: unknown, username: string): typeof schema.history.$inferInsert | null {
  if (!isObject(row)) return null;
  const { id, date, startLat, startLng, destLat, destLng, distance } = row;
  if (typeof id !== 'string' || !id) return null;
  if (typeof date !== 'string' || !date) return null;
  if (typeof startLat !== 'number') return null;
  if (typeof startLng !== 'number') return null;
  if (typeof destLat !== 'number') return null;
  if (typeof destLng !== 'number') return null;
  if (typeof distance !== 'number') return null;

  return {
    id,
    username,
    date,
    startLat,
    startLng,
    startLabel: typeof row.startLabel === 'string' ? row.startLabel : null,
    destLat,
    destLng,
    destName: typeof row.destName === 'string' ? row.destName : null,
    tripMode: typeof row.tripMode === 'string' ? row.tripMode : null,
    distance,
    routeCoords: row.routeCoords !== undefined ? row.routeCoords : null,
    routeDuration: typeof row.routeDuration === 'number' ? row.routeDuration : null,
    returnRouteCoords: row.returnRouteCoords !== undefined ? row.returnRouteCoords : null,
    returnRouteDuration: typeof row.returnRouteDuration === 'number' ? row.returnRouteDuration : null,
  };
}

export function validateVisit(row: unknown, username: string): typeof schema.visits.$inferInsert | null {
  const base = validateRouteRow(row, username);
  if (!base) return null;
  // base !== null guarantees row is an object; re-narrow to read the visit-only poiCategory.
  const poiCategory = isObject(row) && typeof row.poiCategory === 'string' ? row.poiCategory : null;
  return { ...base, poiCategory };
}

function validateFavorite(row: unknown, username: string): typeof schema.favorites.$inferInsert | null {
  if (!isObject(row)) return null;
  const { id, payload } = row;
  if (typeof id !== 'string' || !id) return null;
  if (payload === undefined || payload === null) return null;
  return { id, username, payload };
}

function validateSavedLocation(row: unknown, username: string): typeof schema.savedLocations.$inferInsert | null {
  if (!isObject(row)) return null;
  const { id, label, value } = row;
  if (typeof id !== 'string' || !id) return null;
  if (typeof label !== 'string') return null;
  if (typeof value !== 'string') return null;
  return { id, username, label, value };
}

// History rows are exactly the shared route-row shape (no poiCategory) — thin delegate.
export function validateHistoryRow(row: unknown, username: string): typeof schema.history.$inferInsert | null {
  return validateRouteRow(row, username);
}

export function importRoutes(db: Db): Hono {
  const app = new Hono();

  // POST /:username/import — replace all four sections atomically
  app.post('/:username/import', async (c) => {
    const username = c.req.param('username')!;

    const accountRows = await db
      .select({ username: schema.accounts.username })
      .from(schema.accounts)
      .where(eq(schema.accounts.username, username));
    if (accountRows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

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
      try {
        assertRouteCoords(validated.routeCoords, 'routeCoords');
        assertRouteCoords(validated.returnRouteCoords, 'returnRouteCoords');
      } catch (e) {
        if (e instanceof RouteCoordsError) return c.json({ error: e.message }, 400);
        throw e;
      }
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
      try {
        assertRouteCoords(validated.routeCoords, 'routeCoords');
        assertRouteCoords(validated.returnRouteCoords, 'returnRouteCoords');
      } catch (e) {
        if (e instanceof RouteCoordsError) return c.json({ error: e.message }, 400);
        throw e;
      }
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
