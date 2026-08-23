// GET /:username favorite-payload keep window + geometry=full size cap
import { describe, test, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { app, db, truncateAll, createTestAccount, resetRateLimiter, authHeaders } from './helpers.js';
import { schema } from '../src/db.js';
import { FAVORITE_LIGHT_KEYS, GET_GEOMETRY_KEEP } from '../src/lib/validate-fields.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

const COORDS = [[60.0, 25.0], [60.1, 25.1]] as [number, number][];
const FAT_BLOB = 'x'.repeat(400_000);
const FAT_PAYLOAD = {
  destLat: 60.2,
  destLng: 25.2,
  destName: 'Fat park',
  routeCoords: COORDS,
  blob: FAT_BLOB,
};

function dayStamp(i: number): string {
  return new Date(Date.UTC(2026, 0, i + 1)).toISOString();
}

async function insertFavoriteWithPayload(
  username: string,
  id: string,
  payload: Record<string, unknown>,
  updatedAt: string,
): Promise<void> {
  await db.insert(schema.favorites).values({
    id,
    username,
    payload,
    updatedAt: new Date(updatedAt),
  });
}

describe('GET /api/:username favorite payload budget (finding #7558)', () => {
  test('light keys are bookmark scalars — no route geometry, no catch-all blob', () => {
    expect(FAVORITE_LIGHT_KEYS).toContain('destLat');
    expect(FAVORITE_LIGHT_KEYS).not.toContain('routeCoords');
    expect(FAVORITE_LIGHT_KEYS).not.toContain('returnRouteCoords');
    expect(FAVORITE_LIGHT_KEYS).not.toContain('blob');
  });

  test('omits fat keys on favorites older than GET_GEOMETRY_KEEP, keeps them on the newest', async () => {
    const { username: u, token } = await createTestAccount();
    const total = GET_GEOMETRY_KEEP + 2;
    for (let i = 0; i < total; i++) {
      await insertFavoriteWithPayload(u, `f-geo-${i}`, FAT_PAYLOAD, dayStamp(i));
    }

    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      favorites: Array<{ id: string; payload: Record<string, unknown> | null }>;
    };
    expect(body.favorites).toHaveLength(total);

    const byId = Object.fromEntries(body.favorites.map((f) => [f.id, f]));
    const newest = byId[`f-geo-${total - 1}`];
    expect(newest.payload).toMatchObject({ destName: 'Fat park', routeCoords: COORDS });
    expect(newest.payload?.blob).toBe(FAT_BLOB);

    const oldest = byId['f-geo-0'];
    expect(oldest.payload).toMatchObject({ destLat: 60.2, destLng: 25.2, destName: 'Fat park' });
    expect(oldest.payload).not.toHaveProperty('routeCoords');
    expect(oldest.payload).not.toHaveProperty('blob');
    expect(JSON.stringify(oldest.payload || {}).length).toBeLessThan(500);
  });

  test('a favorites section at or under GET_GEOMETRY_KEEP keeps every payload', async () => {
    const { username: u, token } = await createTestAccount();
    await insertFavoriteWithPayload(u, 'f-few-1', FAT_PAYLOAD, '2026-04-01T10:00:00.000Z');
    await insertFavoriteWithPayload(u, 'f-few-2', FAT_PAYLOAD, '2026-04-02T10:00:00.000Z');

    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
    const body = await res.json() as { favorites: Array<{ payload: Record<string, unknown> }> };
    expect(body.favorites).toHaveLength(2);
    expect(body.favorites.every((f) => f.payload.blob === FAT_BLOB)).toBe(true);
  });

  test('?geometry=full with a small account still returns every favorite payload', async () => {
    const { username: u, token } = await createTestAccount();
    await insertFavoriteWithPayload(u, 'f-full-1', FAT_PAYLOAD, '2026-04-01T10:00:00.000Z');

    const res = await app.request(`/api/${u}?geometry=full`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { favorites: Array<{ payload: Record<string, unknown> }> };
    expect(body.favorites[0].payload.blob).toBe(FAT_BLOB);
    expect(body.favorites[0].payload.routeCoords).toEqual(COORDS);
  });

  test('?geometry=full returns 413 when stored jsonb exceeds GET_SNAPSHOT_MAX_BYTES', async () => {
    const { username: u, token } = await createTestAccount();
    // 25 × ~400 KB uncompressed JSON > 8 MiB, without going through drizzle row-by-row.
    await db.execute(sql`
      INSERT INTO favorites (id, username, payload)
      SELECT 'fat-' || g::text, ${u}, jsonb_build_object('blob', repeat('x', 400000))
      FROM generate_series(1, 25) AS g
    `);

    const res = await app.request(`/api/${u}?geometry=full`, { headers: authHeaders(token) });
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/exceeds maximum size/i);

    // Default GET must still succeed — the init path cannot 413 a bound account.
    const light = await app.request(`/api/${u}`, { headers: authHeaders(token) });
    expect(light.status).toBe(200);
    const lightBody = await light.json() as { favorites: unknown[] };
    expect(lightBody.favorites).toHaveLength(25);
  });
});
