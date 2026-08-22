// GET /:username — four-section account snapshot (cloud-backup read)
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { accountAuth } from '../middleware/auth.js';
import { readRateLimit } from '../middleware/rate-limit.js';
import { selectTripSection } from '../lib/trip-snapshot.js';

export function accountDataRoutes(db: Db): Hono {
  const app = new Hono();

  // GET /:username — return all four sections. IP rate limit runs first
  // (throttles probing), then per-account token auth. Visit/history polylines
  // are omitted on rows older than GET_GEOMETRY_KEEP so the init-path merge
  // (sync.js Case 2) stays bounded; `?geometry=full` returns the archive.
  app.get('/:username', readRateLimit(), accountAuth(db), async (c) => {
    const username = c.req.param('username')!;
    const fullGeometry = c.req.query('geometry') === 'full';

    const [visits, favorites, savedLocations, history] = await Promise.all([
      selectTripSection(db, schema.visits, username, fullGeometry),
      db.select().from(schema.favorites).where(eq(schema.favorites.username, username)),
      db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, username)),
      selectTripSection(db, schema.history, username, fullGeometry),
    ]);

    return c.json({ visits, favorites, savedLocations, history });
  });

  return app;
}
