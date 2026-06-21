import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { createAccount } from '../username.js';
import { accountCreationRateLimit } from '../middleware/rate-limit.js';
import { accountAuth } from '../middleware/auth.js';

export function accountsRoutes(db: Db): Hono {
  const app = new Hono();

  // POST /accounts — create a new account. Returns the secret token (the only
  // time it is ever sent back); the client must persist it to retain access.
  app.post('/accounts', accountCreationRateLimit(), async (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    try {
      const { username, token } = await createAccount(db, ip);
      return c.json({ username, token }, 201);
    } catch (err) {
      if (err instanceof RangeError) {
        return c.json({ error: 'Could not generate unique username' }, 503);
      }
      throw err;
    }
  });

  // DELETE /:username — cascade deletes all child rows via FK
  app.delete('/:username', accountAuth(db), async (c) => {
    const username = c.req.param('username')!;
    const rows = await db
      .select({ username: schema.accounts.username })
      .from(schema.accounts)
      .where(eq(schema.accounts.username, username));
    if (rows.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }
    await db.delete(schema.accounts).where(eq(schema.accounts.username, username));
    return new Response(null, { status: 204 });
  });

  return app;
}
