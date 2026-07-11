// Section CRUD routes — one generic PUT (upsert) + DELETE factory over the
// four user-scoped tables (visits / favorites / saved-locations / history).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq, and } from 'drizzle-orm';
import type { PgTable, PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { sectionWriteRateLimit } from '../middleware/rate-limit.js';
import { accountAuth } from '../middleware/auth.js';
import { assertRouteCoords, RouteCoordsError } from '../lib/route-coords.js';
import { isObject, type AnyRecord } from '../lib/type-guards.js';
import {
  MAX_LABEL_LEN,
  MAX_NAME_LEN,
  MAX_FAVORITE_PAYLOAD_LEN,
  MAX_WRITE_BODY_BYTES,
  isIsoDate,
  tooLong,
  payloadLength,
} from '../lib/validate-fields.js';

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

// Wires PUT (upsert) + DELETE for one section. The PUT body flow — JSON parse →
// isObject guard → buildRow → upsert — and the DELETE flow are identical across
// sections; only `table`/`path`/`buildRow` differ. The `auth` (accountAuth)
// middleware runs first and 401s when the account is missing, so both handlers
// can assume :username names an existing account — no re-check needed here.
function registerSection<T extends PgTable & { id: PgColumn; username: PgColumn }>(
  app: Hono,
  db: Db,
  rl: ReturnType<typeof sectionWriteRateLimit>,
  auth: ReturnType<typeof accountAuth>,
  writeBodyLimit: ReturnType<typeof bodyLimit>,
  { path, table, buildRow }: Section<T>
): void {
  // bodyLimit only on PUT (DELETE carries no body) — rejects oversized bodies,
  // including giant unknown keys, before c.req.json() buffers them in memory.
  app.put(`/:username/${path}/:id`, rl, auth, writeBodyLimit, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

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

  app.delete(`/:username/${path}/:id`, rl, auth, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

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
  if (!isIsoDate(date)) return { error: 'date must be an ISO-8601 timestamp' };
  if (typeof startLat !== 'number') return { error: 'Missing required field: startLat' };
  if (typeof startLng !== 'number') return { error: 'Missing required field: startLng' };
  if (typeof destLat !== 'number') return { error: 'Missing required field: destLat' };
  if (typeof destLng !== 'number') return { error: 'Missing required field: destLng' };
  if (typeof distance !== 'number') return { error: 'Missing required field: distance' };
  if (tooLong(body.startLabel, MAX_LABEL_LEN))
    return { error: `startLabel exceeds maximum length of ${MAX_LABEL_LEN}` };
  if (tooLong(body.destName, MAX_NAME_LEN))
    return { error: `destName exceeds maximum length of ${MAX_NAME_LEN}` };
  if (tooLong(body.tripMode, MAX_LABEL_LEN))
    return { error: `tripMode exceeds maximum length of ${MAX_LABEL_LEN}` };

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
  const auth = accountAuth(db);
  const writeBodyLimit = bodyLimit({
    maxSize: MAX_WRITE_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

  registerSection(app, db, rl, auth, writeBodyLimit, {
    path: 'visits',
    table: schema.visits,
    buildRow: (id, username, body) => {
      if (tooLong(body.poiCategory, MAX_LABEL_LEN))
        return { error: `poiCategory exceeds maximum length of ${MAX_LABEL_LEN}` };
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

  registerSection(app, db, rl, auth, writeBodyLimit, {
    path: 'favorites',
    table: schema.favorites,
    // The client PUTs the favorite object directly, with no `payload` wrapper
    // (see toggleFavorite in app.js), so fall back to the whole body as the
    // stored JSONB. Either way, size-cap it so an arbitrarily-large object can't
    // be persisted (the bodyLimit middleware is a coarser outer bound on top).
    buildRow: (id, username, body) => {
      const payload = body.payload !== undefined ? body.payload : body;
      if (payloadLength(payload) > MAX_FAVORITE_PAYLOAD_LEN)
        return { error: `payload exceeds maximum size of ${MAX_FAVORITE_PAYLOAD_LEN}` };
      return { row: { id, username, payload } };
    },
  });

  registerSection(app, db, rl, auth, writeBodyLimit, {
    path: 'saved-locations',
    table: schema.savedLocations,
    buildRow: (id, username, body) => {
      const { label, value } = body;
      if (typeof label !== 'string') return { error: 'Missing required field: label' };
      if (typeof value !== 'string') return { error: 'Missing required field: value' };
      if (label.length > MAX_LABEL_LEN)
        return { error: `label exceeds maximum length of ${MAX_LABEL_LEN}` };
      if (value.length > MAX_LABEL_LEN)
        return { error: `value exceeds maximum length of ${MAX_LABEL_LEN}` };
      return { row: { id, username, label, value } };
    },
  });

  registerSection(app, db, rl, auth, writeBodyLimit, {
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
