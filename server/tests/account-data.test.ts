import { describe, test, expect, beforeEach } from 'vitest';
import { app, db, truncateAll, createTestAccount, insertTestVisit, insertTestFavorite, resetRateLimiter, authHeaders, VISIT_BODY } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

describe('GET /api/:username', () => {
  test('returns all four sections with camelCase keys', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u);

    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
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

  // A fully-populated visit pins the COMPLETE response shape: every column in
  // schema.ts's visits table round-trips with its stored value, and the row has
  // exactly those keys — so a DB column rename or a dropped select() field fails
  // here instead of silently shipping a partial row (audit).
  test('a visit row returns every schema.visits column with the stored value', async () => {
    const { username: u, token } = await createTestAccount();
    const full = {
      id: 'full-visit-1',
      username: u,
      date: '2026-04-27T10:00:00.000Z',
      startLat: 60.1699,
      startLng: 24.9384,
      startLabel: 'Home',
      destLat: 60.2055,
      destLng: 24.6559,
      destName: 'Forest trail',
      poiCategory: 'nature',
      tripMode: 'loop',
      distance: 7.5,
      routeCoords: [[60.1699, 24.9384], [60.2055, 24.6559]],
      routeDuration: 5400,
      returnRouteCoords: [[60.2055, 24.6559], [60.1699, 24.9384]],
      returnRouteDuration: 5200,
    };
    await db.insert(schema.visits).values(full);

    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { visits: Record<string, unknown>[] };
    expect(body.visits).toHaveLength(1);
    const v = body.visits[0];

    expect(v.id).toBe(full.id);
    expect(v.username).toBe(u);
    // date/updatedAt are timestamptz columns — compare by instant, not by the
    // exact string the pg driver formats them as.
    expect(new Date(v.date as string).getTime()).toBe(new Date(full.date).getTime());
    expect(v.startLat).toBe(full.startLat);
    expect(v.startLng).toBe(full.startLng);
    expect(v.startLabel).toBe(full.startLabel);
    expect(v.destLat).toBe(full.destLat);
    expect(v.destLng).toBe(full.destLng);
    expect(v.destName).toBe(full.destName);
    expect(v.poiCategory).toBe(full.poiCategory);
    expect(v.tripMode).toBe(full.tripMode);
    expect(v.distance).toBe(full.distance);
    expect(v.routeCoords).toEqual(full.routeCoords);
    expect(v.routeDuration).toBe(full.routeDuration);
    expect(v.returnRouteCoords).toEqual(full.returnRouteCoords);
    expect(v.returnRouteDuration).toBe(full.returnRouteDuration);
    expect(typeof v.updatedAt).toBe('string');
    expect(Number.isNaN(new Date(v.updatedAt as string).getTime())).toBe(false);

    // Exact key set — adding/renaming/dropping a visits column breaks this.
    expect(Object.keys(v).sort()).toEqual([
      'date', 'destLat', 'destLng', 'destName', 'distance', 'id',
      'poiCategory', 'returnRouteCoords', 'returnRouteDuration', 'routeCoords',
      'routeDuration', 'startLabel', 'startLat', 'startLng', 'tripMode',
      'updatedAt', 'username',
    ]);
  });

  test('returns empty arrays when user has no data', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
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
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u, 'v-fetch-1');
    await insertTestFavorite(u, 'f-fetch-1');
    await db.insert(schema.savedLocations).values({ id: 'sl-fetch-1', username: u, label: 'Home', value: '60,25' });
    await db.insert(schema.history).values({
      id: 'h-fetch-1', username: u, date: VISIT_BODY.date,
      startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5,
    });

    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
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

describe('GET /api/:username auth', () => {
  test('401 when no Authorization header is sent', async () => {
    const { username: u } = await createTestAccount();
    const res = await app.request(`/api/${u}`);
    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
  });

  test('401 when the token is wrong', async () => {
    const { username: u } = await createTestAccount();
    const res = await app.request(`/api/${u}`, { headers: authHeaders('not-the-real-token') });
    expect(res.status).toBe(401);
  });

  test('401 (not 404) for a non-existent account — no existence oracle', async () => {
    // A missing account and a wrong token must be indistinguishable, so the
    // endpoint cannot be used to enumerate which usernames exist.
    const res = await app.request('/api/no-such-user-99', { headers: authHeaders('any-token') });
    expect(res.status).toBe(401);

    const { username: u, token } = await createTestAccount();
    const wrongTokenRealUser = await app.request(`/api/${u}`, { headers: authHeaders('wrong') });
    const missingUser = await app.request('/api/also-missing-12', { headers: authHeaders(token) });
    expect(wrongTokenRealUser.status).toBe(missingUser.status);
    expect(wrongTokenRealUser.status).toBe(401);
  });

  test('accepts the token via the X-Account-Token fallback header', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}`, { headers: { 'X-Account-Token': token } });
    expect(res.status).toBe(200);
  });
});
