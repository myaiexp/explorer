import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';

export function fetchRoutes(db: Db): Hono {
  const app = new Hono();

  // GET /:username — return all four sections
  app.get('/:username', async (c) => {
    const username = c.req.param('username')!;

    const accountRows = await db
      .select({ username: schema.accounts.username })
      .from(schema.accounts)
      .where(eq(schema.accounts.username, username));
    if (accountRows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

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
