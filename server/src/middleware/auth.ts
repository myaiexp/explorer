// Per-account bearer-token auth — gates every read/write on the :username param.
import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';

// Pull the token from `Authorization: Bearer <token>` (preferred) or the
// `X-Account-Token` fallback header. Returns null when neither is present.
function extractToken(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (auth) {
    const m = auth.trim().match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return c.req.header('x-account-token') ?? null;
}

// Constant-time string compare. Different lengths → false without leaking via a
// short-circuit; equal lengths are compared with timingSafeEqual.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Requires a valid token for the account named in the :username path param.
// Returns an identical 401 whether the account is missing OR the token is wrong,
// so the endpoint cannot be used as an account-existence oracle.
export function accountAuth(db: Db) {
  return async (c: Context, next: Next) => {
    const username = c.req.param('username');
    const provided = extractToken(c);
    if (!username || !provided) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const rows = await db
      .select({ token: schema.accounts.token })
      .from(schema.accounts)
      .where(eq(schema.accounts.username, username));

    const stored = rows[0]?.token;
    if (!stored || !safeEqual(provided, stored)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    await next();
  };
}
