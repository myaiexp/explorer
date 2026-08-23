// PUT / import per-account stored-jsonb budget (finding #7756)
import { describe, test, expect, beforeEach } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import {
  app,
  db,
  truncateAll,
  createTestAccount,
  resetRateLimiter,
  authHeaders,
} from './helpers.js';
import { schema } from '../src/db.js';
import { MAX_STORED_BYTES } from '../src/lib/validate-fields.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

async function fillStoredBytes(username: string, id = 'fat-fill'): Promise<void> {
  // Bypass PUT row/payload caps so the account sits on the stored-bytes budget.
  // jsonb_build_object('blob', repeat('x', N)) is N plus a few wrapper bytes.
  await db.execute(sql`
    INSERT INTO favorites (id, username, payload)
    VALUES (${id}, ${username}, jsonb_build_object('blob', repeat('x', ${MAX_STORED_BYTES})))
  `);
}

describe('PUT per-account stored-bytes budget (finding #7756)', () => {
  test('rejects a new favorite once stored jsonb is at MAX_STORED_BYTES', async () => {
    const { username: u, token } = await createTestAccount();
    await fillStoredBytes(u);

    const res = await app.request(`/api/${u}/favorites/f-new`, {
      method: 'PUT',
      body: JSON.stringify({ destName: 'park', destLat: 60.2, destLng: 25.2 }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/stored size/i);
    expect(body.error).toMatch(String(MAX_STORED_BYTES));

    const rows = await db
      .select({ id: schema.favorites.id })
      .from(schema.favorites)
      .where(eq(schema.favorites.username, u));
    expect(rows.map((r) => r.id)).toEqual(['fat-fill']);
  });

  test('still replaces an over-budget row with a smaller payload', async () => {
    const { username: u, token } = await createTestAccount();
    await fillStoredBytes(u);

    const res = await app.request(`/api/${u}/favorites/fat-fill`, {
      method: 'PUT',
      body: JSON.stringify({ destName: 'tiny' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const [row] = await db
      .select()
      .from(schema.favorites)
      .where(and(eq(schema.favorites.username, u), eq(schema.favorites.id, 'fat-fill')));
    expect(row.payload).toEqual({ destName: 'tiny' });
  });

  test("one account at the budget does not block another account's insert", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    await fillStoredBytes(a.username);

    const res = await app.request(`/api/${b.username}/favorites/b-1`, {
      method: 'PUT',
      body: JSON.stringify({ destName: 'other' }),
      headers: { 'content-type': 'application/json', ...authHeaders(b.token) },
    });
    expect(res.status).toBe(204);
  });

  test('still inserts a saved-location at the budget (no jsonb contribution)', async () => {
    const { username: u, token } = await createTestAccount();
    await fillStoredBytes(u);

    const res = await app.request(`/api/${u}/saved-locations/home`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Home', value: '60.1,24.9' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);
  });
});

describe('POST /api/:username/import stored-bytes budget (finding #7756)', () => {
  test('a small import still replaces an over-budget account (replace, not add)', async () => {
    const { username: u, token } = await createTestAccount();
    await fillStoredBytes(u);

    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify({
        visits: [],
        favorites: [{ id: 'f-1', destName: 'park' }],
        savedLocations: [],
        history: [],
      }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const rows = await db
      .select({ id: schema.favorites.id })
      .from(schema.favorites)
      .where(eq(schema.favorites.username, u));
    expect(rows.map((r) => r.id)).toEqual(['f-1']);
  });
});
