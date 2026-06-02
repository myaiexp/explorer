// Section CRUD routes — one generic PUT (upsert) + DELETE factory over the
// four user-scoped tables (visits / favorites / saved-locations / history).
import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { PgTable, PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { sectionWriteRateLimit } from '../middleware/rate-limit.js';
import { assertRouteCoords, RouteCoordsError } from '../lib/route-coords.js';
import { isObject, type AnyRecord } from '../lib/type-guards.js';

async function userExists(db: Db, username: string): Promise<boolean> {
  const rows = await db
    .select({ username: schema.accounts.username })
    .from(schema.accounts)
    .where(eq(schema.accounts.username, username));
  return rows.length > 0;
}

// A section's domain rule: turn a validated object body into the row to upsert,
// or a 400 error message. `id`/`username` come from the path.
type BuildRow<T extends PgTable> = (
  id: string,
  username: string,
  body: AnyRecord
) => { error: string } | { row: T['$inferInsert'] };

interface Section<T extends PgTable & { id: PgColumn; username: PgColumn }> {
  path: string;
  table: T;
  buildRow: BuildRow<T>;
}

// Wires PUT (upsert) + DELETE for one section. The PUT body flow — userExists →
// JSON parse → isObject guard → buildRow → upsert — and the DELETE flow are
// identical across sections; only `table`/`path`/`buildRow` differ.
function registerSection<T extends PgTable & { id: PgColumn; username: PgColumn }>(
  app: Hono,
  db: Db,
  rl: ReturnType<typeof sectionWriteRateLimit>,
  { path, table, buildRow }: Section<T>
): void {
  app.put(`/:username/${path}/:id`, rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const built = buildRow(id, username, body);
    if ('error' in built) return c.json({ error: built.error }, 400);

    // The conflict set updates every column except the conflict keys (id) and
    // the ownership key (username) — derived from the row itself, so there is
    // no second hand-maintained field list to drift from buildRow. (The generic
    // row type is opaque to TS at this boundary, hence the localized casts.)
    const { id: _id, username: _username, ...set } = built.row as AnyRecord;
    await db
      .insert(table)
      .values(built.row)
      .onConflictDoUpdate({ target: table.id, set: set as PgUpdateSetSource<T> });

    return new Response(null, { status: 204 });
  });

  app.delete(`/:username/${path}/:id`, rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db.delete(table).where(and(eq(table.id, id), eq(table.username, username)));

    return new Response(null, { status: 204 });
  });
}

// Validates the visit/history trip shape and extracts the columns common to both
// tables (history is the trip shape; visits adds poiCategory).
function buildTripBase(
  id: string,
  username: string,
  body: AnyRecord
): { error: string } | { base: typeof schema.history.$inferInsert } {
  const { date, startLat, startLng, destLat, destLng, distance } = body;
  if (typeof date !== 'string' || !date) return { error: 'Missing required field: date' };
  if (typeof startLat !== 'number') return { error: 'Missing required field: startLat' };
  if (typeof startLng !== 'number') return { error: 'Missing required field: startLng' };
  if (typeof destLat !== 'number') return { error: 'Missing required field: destLat' };
  if (typeof destLng !== 'number') return { error: 'Missing required field: destLng' };
  if (typeof distance !== 'number') return { error: 'Missing required field: distance' };

  try {
    assertRouteCoords(body.routeCoords, 'routeCoords');
    assertRouteCoords(body.returnRouteCoords, 'returnRouteCoords');
  } catch (e) {
    if (e instanceof RouteCoordsError) return { error: e.message };
    throw e;
  }

  return {
    base: {
      id,
      username,
      date,
      startLat,
      startLng,
      startLabel: typeof body.startLabel === 'string' ? body.startLabel : null,
      destLat,
      destLng,
      destName: typeof body.destName === 'string' ? body.destName : null,
      tripMode: typeof body.tripMode === 'string' ? body.tripMode : null,
      distance,
      routeCoords: body.routeCoords !== undefined ? body.routeCoords : null,
      routeDuration: typeof body.routeDuration === 'number' ? body.routeDuration : null,
      returnRouteCoords: body.returnRouteCoords !== undefined ? body.returnRouteCoords : null,
      returnRouteDuration:
        typeof body.returnRouteDuration === 'number' ? body.returnRouteDuration : null,
    },
  };
}

export function sectionsRoutes(db: Db): Hono {
  const app = new Hono();
  const rl = sectionWriteRateLimit();

  registerSection(app, db, rl, {
    path: 'visits',
    table: schema.visits,
    buildRow: (id, username, body) => {
      const r = buildTripBase(id, username, body);
      if ('error' in r) return r;
      return {
        row: {
          ...r.base,
          poiCategory: typeof body.poiCategory === 'string' ? body.poiCategory : null,
        },
      };
    },
  });

  registerSection(app, db, rl, {
    path: 'favorites',
    table: schema.favorites,
    buildRow: (id, username, body) => ({
      row: { id, username, payload: body.payload !== undefined ? body.payload : body },
    }),
  });

  registerSection(app, db, rl, {
    path: 'saved-locations',
    table: schema.savedLocations,
    buildRow: (id, username, body) => {
      const { label, value } = body;
      if (typeof label !== 'string') return { error: 'Missing required field: label' };
      if (typeof value !== 'string') return { error: 'Missing required field: value' };
      return { row: { id, username, label, value } };
    },
  });

  registerSection(app, db, rl, {
    path: 'history',
    table: schema.history,
    buildRow: (id, username, body) => {
      const r = buildTripBase(id, username, body);
      if ('error' in r) return r;
      return { row: r.base };
    },
  });

  return app;
}
