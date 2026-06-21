import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { accountAuth } from '../middleware/auth.js';
import { readRateLimit } from '../middleware/rate-limit.js';

export function fetchRoutes(db: Db): Hono {
  const app = new Hono();

  // GET /:username — return all four sections. IP rate limit runs first
  // (throttles probing), then per-account token auth.
  app.get('/:username', readRateLimit(), accountAuth(db), async (c) => {
    const username = c.req.param('username')!;

    const [visits, favorites, savedLocations, history] = await Promise.all([
      db.select().from(schema.visits).where(eq(schema.visits.username, username)),
      db.select().from(schema.favorites).where(eq(schema.favorites.username, username)),
      db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, username)),
      db.select().from(schema.history).where(eq(schema.history.username, username)),
    ]);

    return c.json({ visits, favorites, savedLocations, history });
  });

  return app;
}
