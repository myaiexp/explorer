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
  VISIT_BODY,
} from './helpers.js';
import { schema } from '../src/db.js';
import { incomingJsonbBytes } from '../src/lib/snapshot-size.js';
import { MAX_STORED_BYTES } from '../src/lib/limits.js';

function bytesOf(result: unknown): number {
  const row = Array.isArray(result)
    ? result[0]
    : (result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: unknown[] }).rows[0]
      : undefined);
  const bytes = (row as { bytes?: unknown } | undefined)?.bytes;
  return typeof bytes === 'number' ? bytes : Number(bytes);
}

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

describe('stored jsonb byte estimate matches postgres (finding #11797)', () => {
  test('a PUT polyline\'s incomingJsonbBytes equals octet_length(::text)', async () => {
    const { username: u, token } = await createTestAccount();
    const routeCoords = [[24.94, 61.5], [24.95, 61.6], [24.96, 61.7]];
    const returnRouteCoords = [[24.96, 61.7], [24.95, 61.6]];
    const res = await app.request(`/api/${u}/visits/v-coords`, {
      method: 'PUT',
      body: JSON.stringify({ ...VISIT_BODY, routeCoords, returnRouteCoords }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const result = await db.execute(sql`
      SELECT octet_length(route_coords::text)
        + octet_length(return_route_coords::text) AS bytes
      FROM visits WHERE username = ${u} AND id = 'v-coords'
    `);
    expect(incomingJsonbBytes(schema.visits, { routeCoords, returnRouteCoords })).toBe(bytesOf(result));
  });
});

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
