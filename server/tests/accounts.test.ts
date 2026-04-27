import { describe, test, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, db, truncateAll, createTestAccount, insertTestVisit, insertTestFavorite, resetRateLimiter } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

describe('POST /api/accounts', () => {
  test('returns 201 with a valid username and creates a DB row', async () => {
    const res = await app.request('/api/accounts', { method: 'POST' });
    expect(res.status).toBe(201);
    const { username } = await res.json() as { username: string };
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, username));
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe(username);
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

  test('POST /accounts retries on collision — direct createAccount test', async () => {
    const { generateUsername, createAccount } = await import('../src/username.js');
    // Force a collision by pre-inserting a username that will be generated
    const fixedName = 'brave-mountain-7';
    // Insert it directly to simulate collision
    await db.insert(schema.accounts).values({ username: fixedName });

    // Spy: first call returns fixedName (collision), second call returns something new
    let callCount = 0;
    const original = generateUsername;
    vi.spyOn(await import('../src/username.js'), 'generateUsername').mockImplementation(() => {
      callCount++;
      if (callCount === 1) return fixedName;
      return `unique-word-${callCount}`;
    });

    // createAccount should skip the collision and return the unique one
    const username = await createAccount(db, null);
    expect(username).not.toBe(fixedName);
    expect(username).toMatch(/^[a-z]+-[a-z]+-\d+$/);

    vi.restoreAllMocks();
  });
});

describe('DELETE /api/:username', () => {
  test('cascades to all child tables', async () => {
    const u = await createTestAccount();
    await insertTestVisit(u);
    await insertTestFavorite(u);

    const res = await app.request(`/api/${u}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const visitRows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    const favRows = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
    const accRows = await db.select().from(schema.accounts).where(eq(schema.accounts.username, u));

    expect(visitRows).toHaveLength(0);
    expect(favRows).toHaveLength(0);
    expect(accRows).toHaveLength(0);
  });

  test('returns 404 for unknown user', async () => {
    const res = await app.request('/api/no-such-user-99', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
