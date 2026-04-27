import { describe, test, expect, beforeEach } from 'vitest';
import { app, db, truncateAll, createTestAccount, insertTestVisit, insertTestFavorite, resetRateLimiter, VISIT_BODY } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

describe('GET /api/:username', () => {
  test('returns all four sections with camelCase keys', async () => {
    const u = await createTestAccount();
    await insertTestVisit(u);

    const res = await app.request(`/api/${u}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      visits: unknown[];
      favorites: unknown[];
      savedLocations: unknown[];
      history: unknown[];
    };

    expect(body).toHaveProperty('visits');
    expect(body).toHaveProperty('favorites');
    expect(body).toHaveProperty('savedLocations');
    expect(body).toHaveProperty('history');

    expect(body.visits).toHaveLength(1);
    expect(body.favorites).toHaveLength(0);
    expect(body.savedLocations).toHaveLength(0);
    expect(body.history).toHaveLength(0);

    // Verify camelCase keys on visit row
    const visit = body.visits[0] as Record<string, unknown>;
    expect(visit).toHaveProperty('startLat');
    expect(visit).toHaveProperty('startLng');
    expect(visit).toHaveProperty('destLat');
    expect(visit).toHaveProperty('destLng');
    expect(visit).toHaveProperty('username');
  });

  test('returns 404 for missing user', async () => {
    const res = await app.request('/api/no-such-user-99');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
  });

  test('returns empty arrays when user has no data', async () => {
    const u = await createTestAccount();
    const res = await app.request(`/api/${u}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      visits: unknown[];
      favorites: unknown[];
      savedLocations: unknown[];
      history: unknown[];
    };
    expect(body.visits).toEqual([]);
    expect(body.favorites).toEqual([]);
    expect(body.savedLocations).toEqual([]);
    expect(body.history).toEqual([]);
  });

  test('returns all sections with data', async () => {
    const u = await createTestAccount();
    await insertTestVisit(u, 'v-fetch-1');
    await insertTestFavorite(u, 'f-fetch-1');
    await db.insert(schema.savedLocations).values({ id: 'sl-fetch-1', username: u, label: 'Home', value: '60,25' });
    await db.insert(schema.history).values({
      id: 'h-fetch-1', username: u, date: VISIT_BODY.date,
      startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5,
    });

    const res = await app.request(`/api/${u}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      visits: unknown[];
      favorites: unknown[];
      savedLocations: unknown[];
      history: unknown[];
    };
    expect(body.visits).toHaveLength(1);
    expect(body.favorites).toHaveLength(1);
    expect(body.savedLocations).toHaveLength(1);
    expect(body.history).toHaveLength(1);
  });
});
