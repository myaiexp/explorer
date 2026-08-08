import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { createAccount } from '../username.js';
import { clientIpForStorage } from '../lib/client-ip.js';
import { accountCreationRateLimit } from '../middleware/rate-limit.js';
import { accountAuth } from '../middleware/auth.js';

export function accountsRoutes(db: Db): Hono {
  const app = new Hono();

  // POST /accounts — create a new account. Returns the secret token (the only
  // time it is ever sent back); the client must persist it to retain access.
  app.post('/accounts', accountCreationRateLimit(), async (c) => {
    // Only records the client hop when the peer is a trusted proxy (nginx).
    // Raw client XFF from untrusted peers is ignored — see lib/client-ip.ts.
    const ip = clientIpForStorage(c);
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

  // DELETE /:username — cascade deletes all child rows via FK.
  // accountAuth already 401s any missing account (identical to a wrong token, by
  // the anti-enumeration design), so the handler may assume :username exists —
  // same convention as sections.ts. No existence re-check here.
  app.delete('/:username', accountAuth(db), async (c) => {
    const username = c.req.param('username')!;
    await db.delete(schema.accounts).where(eq(schema.accounts.username, username));
    return new Response(null, { status: 204 });
  });

  return app;
}
