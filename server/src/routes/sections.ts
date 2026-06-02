import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { sectionWriteRateLimit } from '../middleware/rate-limit.js';
import { assertRouteCoords, RouteCoordsError } from '../lib/route-coords.js';

type AnyRecord = Record<string, unknown>;

function isObject(v: unknown): v is AnyRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function userExists(db: Db, username: string): Promise<boolean> {
  const rows = await db
    .select({ username: schema.accounts.username })
    .from(schema.accounts)
    .where(eq(schema.accounts.username, username));
  return rows.length > 0;
}

export function sectionsRoutes(db: Db): Hono {
  const app = new Hono();

  const rl = sectionWriteRateLimit();

  // ── visits ──────────────────────────────────────────────────────────────

  app.put('/:username/visits/:id', rl, async (c) => {
    const username = c.req.param('username')!!;
    const id = c.req.param('id')!!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const { date, startLat, startLng, destLat, destLng, distance } = body;
    if (typeof date !== 'string' || !date) return c.json({ error: 'Missing required field: date' }, 400);
    if (typeof startLat !== 'number') return c.json({ error: 'Missing required field: startLat' }, 400);
    if (typeof startLng !== 'number') return c.json({ error: 'Missing required field: startLng' }, 400);
    if (typeof destLat !== 'number') return c.json({ error: 'Missing required field: destLat' }, 400);
    if (typeof destLng !== 'number') return c.json({ error: 'Missing required field: destLng' }, 400);
    if (typeof distance !== 'number') return c.json({ error: 'Missing required field: distance' }, 400);

    try {
      assertRouteCoords(body.routeCoords, 'routeCoords');
      assertRouteCoords(body.returnRouteCoords, 'returnRouteCoords');
    } catch (e) {
      if (e instanceof RouteCoordsError) return c.json({ error: e.message }, 400);
      throw e;
    }

    const row: typeof schema.visits.$inferInsert = {
      id,
      username,
      date,
      startLat,
      startLng,
      startLabel: typeof body.startLabel === 'string' ? body.startLabel : null,
      destLat,
      destLng,
      destName: typeof body.destName === 'string' ? body.destName : null,
      poiCategory: typeof body.poiCategory === 'string' ? body.poiCategory : null,
      tripMode: typeof body.tripMode === 'string' ? body.tripMode : null,
      distance,
      routeCoords: body.routeCoords !== undefined ? body.routeCoords : null,
      routeDuration: typeof body.routeDuration === 'number' ? body.routeDuration : null,
      returnRouteCoords: body.returnRouteCoords !== undefined ? body.returnRouteCoords : null,
      returnRouteDuration: typeof body.returnRouteDuration === 'number' ? body.returnRouteDuration : null,
    };

    await db
      .insert(schema.visits)
      .values(row)
      .onConflictDoUpdate({
        target: schema.visits.id,
        set: {
          date: row.date,
          startLat: row.startLat,
          startLng: row.startLng,
          startLabel: row.startLabel,
          destLat: row.destLat,
          destLng: row.destLng,
          destName: row.destName,
          poiCategory: row.poiCategory,
          tripMode: row.tripMode,
          distance: row.distance,
          routeCoords: row.routeCoords,
          routeDuration: row.routeDuration,
          returnRouteCoords: row.returnRouteCoords,
          returnRouteDuration: row.returnRouteDuration,
        },
      });

    return new Response(null, { status: 204 });
  });

  app.delete('/:username/visits/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db
      .delete(schema.visits)
      .where(and(eq(schema.visits.id, id), eq(schema.visits.username, username)));

    return new Response(null, { status: 204 });
  });

  // ── favorites ────────────────────────────────────────────────────────────

  app.put('/:username/favorites/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const payload = body.payload !== undefined ? body.payload : body;

    const row: typeof schema.favorites.$inferInsert = { id, username, payload };

    await db
      .insert(schema.favorites)
      .values(row)
      .onConflictDoUpdate({
        target: schema.favorites.id,
        set: { payload: row.payload },
      });

    return new Response(null, { status: 204 });
  });

  app.delete('/:username/favorites/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db
      .delete(schema.favorites)
      .where(and(eq(schema.favorites.id, id), eq(schema.favorites.username, username)));

    return new Response(null, { status: 204 });
  });

  // ── saved-locations ──────────────────────────────────────────────────────

  app.put('/:username/saved-locations/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const { label, value } = body;
    if (typeof label !== 'string') return c.json({ error: 'Missing required field: label' }, 400);
    if (typeof value !== 'string') return c.json({ error: 'Missing required field: value' }, 400);

    const row: typeof schema.savedLocations.$inferInsert = { id, username, label, value };

    await db
      .insert(schema.savedLocations)
      .values(row)
      .onConflictDoUpdate({
        target: schema.savedLocations.id,
        set: { label: row.label, value: row.value },
      });

    return new Response(null, { status: 204 });
  });

  app.delete('/:username/saved-locations/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db
      .delete(schema.savedLocations)
      .where(and(eq(schema.savedLocations.id, id), eq(schema.savedLocations.username, username)));

    return new Response(null, { status: 204 });
  });

  // ── history ──────────────────────────────────────────────────────────────

  app.put('/:username/history/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const { date, startLat, startLng, destLat, destLng, distance } = body;
    if (typeof date !== 'string' || !date) return c.json({ error: 'Missing required field: date' }, 400);
    if (typeof startLat !== 'number') return c.json({ error: 'Missing required field: startLat' }, 400);
    if (typeof startLng !== 'number') return c.json({ error: 'Missing required field: startLng' }, 400);
    if (typeof destLat !== 'number') return c.json({ error: 'Missing required field: destLat' }, 400);
    if (typeof destLng !== 'number') return c.json({ error: 'Missing required field: destLng' }, 400);
    if (typeof distance !== 'number') return c.json({ error: 'Missing required field: distance' }, 400);

    try {
      assertRouteCoords(body.routeCoords, 'routeCoords');
      assertRouteCoords(body.returnRouteCoords, 'returnRouteCoords');
    } catch (e) {
      if (e instanceof RouteCoordsError) return c.json({ error: e.message }, 400);
      throw e;
    }

    const row: typeof schema.history.$inferInsert = {
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
      returnRouteDuration: typeof body.returnRouteDuration === 'number' ? body.returnRouteDuration : null,
    };

    await db
      .insert(schema.history)
      .values(row)
      .onConflictDoUpdate({
        target: schema.history.id,
        set: {
          date: row.date,
          startLat: row.startLat,
          startLng: row.startLng,
          startLabel: row.startLabel,
          destLat: row.destLat,
          destLng: row.destLng,
          destName: row.destName,
          tripMode: row.tripMode,
          distance: row.distance,
          routeCoords: row.routeCoords,
          routeDuration: row.routeDuration,
          returnRouteCoords: row.returnRouteCoords,
          returnRouteDuration: row.returnRouteDuration,
        },
      });

    return new Response(null, { status: 204 });
  });

  app.delete('/:username/history/:id', rl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    if (!(await userExists(db, username))) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db
      .delete(schema.history)
      .where(and(eq(schema.history.id, id), eq(schema.history.username, username)));

    return new Response(null, { status: 204 });
  });

  return app;
}
