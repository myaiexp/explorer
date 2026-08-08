import { describe, test, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  app,
  db,
  truncateAll,
  createTestAccount,
  insertTestVisit,
  insertTestFavorite,
  resetRateLimiter,
  authHeaders,
  TRUSTED_PROXY_ENV,
} from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

describe('POST /api/accounts', () => {
  test('returns 201 with a valid username + secret token and creates a DB row', async () => {
    const res = await app.request('/api/accounts', { method: 'POST' });
    expect(res.status).toBe(201);
    const { username, token } = await res.json() as { username: string; token: string };
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    // base64url token of 32 random bytes ≈ 43 chars, high-entropy
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(40);
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe(username);
    expect(rows[0].token).toBe(token);
  });

  test('each call returns a different username', async () => {
    const r1 = await app.request('/api/accounts', { method: 'POST' });
    const r2 = await app.request('/api/accounts', { method: 'POST' });
    const { username: u1 } = await r1.json() as { username: string };
    const { username: u2 } = await r2.json() as { username: string };
    // Almost certainly different; same would be astronomically unlikely
    const rows = await db.select().from(schema.accounts);
    expect(rows).toHaveLength(2);
    // usernames are valid format
    expect(u1).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    expect(u2).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  });

  test('createAccount skips a PK collision and creates a new, distinct account', async () => {
    const { createAccount } = await import('../src/username.js');
    // Pre-insert the name the first generator call will produce, to force a collision.
    const fixedName = 'brave-mountain-7';
    await db.insert(schema.accounts).values({ username: fixedName, token: 'preexisting-token' });

    // Inject a deterministic generator: first call collides, second is unique.
    let callCount = 0;
    const genUsername = () => {
      callCount++;
      return callCount === 1 ? fixedName : `unique-word-${callCount}`;
    };

    const { username } = await createAccount(db, null, genUsername);

    // Observable behaviour: a new account exists under the retried name, distinct
    // from the collision row, which is left untouched — two rows total.
    expect(username).not.toBe(fixedName);
    const created = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(created).toHaveLength(1);
    const all = await db.select().from(schema.accounts);
    expect(all).toHaveLength(2);
  });

  test('createAccount throws RangeError after exactly 10 collisions and creates no row', async () => {
    const { createAccount } = await import('../src/username.js');
    // Pre-insert the one name the generator will ever produce, so every attempt
    // collides on the PK — the retry loop can never find a free username.
    const fixedName = 'always-collide-1';
    await db.insert(schema.accounts).values({ username: fixedName, token: 'preexisting-token' });

    let callCount = 0;
    const genUsername = () => {
      callCount++;
      return fixedName;
    };

    await expect(createAccount(db, null, genUsername)).rejects.toThrow(RangeError);
    // The loop is capped at 10 attempts; a regression in the cap is caught here.
    expect(callCount).toBe(10);
    // No new account was created — only the pre-inserted collision row remains.
    const all = await db.select().from(schema.accounts);
    expect(all).toHaveLength(1);
    expect(all[0].username).toBe(fixedName);
  });

  test('returns 503 when every username generation collides (retries exhausted)', async () => {
    // Force the route's default generator path to collide on every insert by
    // making the DB raise a unique-violation (SQLSTATE 23505) each time. After
    // 10 exhausted attempts createAccount throws RangeError, which the handler
    // maps to a 503.
    const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const insertSpy = vi.spyOn(db, 'insert').mockReturnValue({
      values: () => Promise.reject(uniqueViolation),
    } as unknown as ReturnType<typeof db.insert>);

    try {
      const res = await app.request('/api/accounts', { method: 'POST' });
      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Could not generate unique username');
      // 10 insert attempts were made before giving up.
      expect(insertSpy).toHaveBeenCalledTimes(10);
    } finally {
      insertSpy.mockRestore();
    }
    // No account row leaked through the failed attempts.
    const all = await db.select().from(schema.accounts);
    expect(all).toHaveLength(0);
  });
});

describe('ipFirstSeen storage', () => {
  // XFF is only honoured when the TCP peer is a trusted proxy (nginx on
  // loopback). Inject that peer via TRUSTED_PROXY_ENV — see lib/client-ip.ts.
  test('stores the x-forwarded-for IP on account creation', async () => {
    const res = await app.request(
      '/api/accounts',
      { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.5' } },
      TRUSTED_PROXY_ENV
    );
    expect(res.status).toBe(201);
    const { username } = await res.json() as { username: string };
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows).toHaveLength(1);
    expect(rows[0].ipFirstSeen).toBe('203.0.113.5');
  });

  test('records only the first hop of x-forwarded-for, trimmed', async () => {
    const res = await app.request(
      '/api/accounts',
      { method: 'POST', headers: { 'x-forwarded-for': '  198.51.100.7 , 10.0.0.1, 10.0.0.2' } },
      TRUSTED_PROXY_ENV
    );
    expect(res.status).toBe(201);
    const { username } = await res.json() as { username: string };
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows[0].ipFirstSeen).toBe('198.51.100.7');
  });

  test('stores null when no x-forwarded-for header is present', async () => {
    const res = await app.request('/api/accounts', { method: 'POST' }, TRUSTED_PROXY_ENV);
    expect(res.status).toBe(201);
    const { username } = await res.json() as { username: string };
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows[0].ipFirstSeen).toBeNull();
  });

  test('ignores x-forwarded-for from an untrusted peer (no plant into ipFirstSeen)', async () => {
    const res = await app.request(
      '/api/accounts',
      { method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' } },
      { incoming: { socket: { remoteAddress: '203.0.113.9' } } }
    );
    expect(res.status).toBe(201);
    const { username } = await res.json() as { username: string };
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows[0].ipFirstSeen).toBeNull();
  });

  test('persists the IP on the retry-succeeded insert and never overwrites an existing row', async () => {
    const { createAccount } = await import('../src/username.js');
    // Pre-insert the name the first attempt will generate, with no IP recorded.
    const fixedName = 'brave-mountain-7';
    await db.insert(schema.accounts).values({ username: fixedName, token: 'preexisting-token' });

    let callCount = 0;
    const genUsername = () => {
      callCount++;
      return callCount === 1 ? fixedName : `unique-word-${callCount}`; // first attempt collides on the PK
    };

    const { username } = await createAccount(db, '192.0.2.50', genUsername);
    expect(username).not.toBe(fixedName);

    // The IP is stored on the second (successful) insert, not lost during retry.
    const created = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(created[0].ipFirstSeen).toBe('192.0.2.50');

    // The colliding pre-existing row keeps its original (null) ip_first_seen —
    // a later creation attempt never overwrites an account's first-seen IP.
    const collided = await db.select().from(schema.accounts).where(eq(schema.accounts.username, fixedName));
    expect(collided[0].ipFirstSeen).toBeNull();
  });
});

describe('DELETE /api/:username', () => {
  test('cascades to all child tables', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u);
    await insertTestFavorite(u);

    const res = await app.request(`/api/${u}`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);

    const visitRows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    const favRows = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
    const accRows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, u));

    expect(visitRows).toHaveLength(0);
    expect(favRows).toHaveLength(0);
    expect(accRows).toHaveLength(0);
  });

  test('returns 401 without a token', async () => {
    const { username: u } = await createTestAccount();
    const res = await app.request(`/api/${u}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
    // The account must survive an unauthenticated delete attempt.
    const accRows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, u));
    expect(accRows).toHaveLength(1);
  });

  test('returns 401 with a wrong token (cannot delete another account)', async () => {
    const { username: u } = await createTestAccount();
    const res = await app.request(`/api/${u}`, { method: 'DELETE', headers: authHeaders('wrong') });
    expect(res.status).toBe(401);
    const accRows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, u));
    expect(accRows).toHaveLength(1);
  });

  test('returns 401 (not 404) for an unknown user — no existence oracle', async () => {
    const res = await app.request('/api/no-such-user-99', { method: 'DELETE', headers: authHeaders('any') });
    expect(res.status).toBe(401);
  });
});
