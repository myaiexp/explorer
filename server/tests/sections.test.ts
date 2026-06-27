import { describe, test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, db, truncateAll, createTestAccount, authHeaders, VISIT_BODY, resetRateLimiter } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

const visitPayload = (id: string, distance = 5) => ({
  id,
  ...VISIT_BODY,
  distance,
});

describe('PUT /:username/visits/:id', () => {
  test('upserts (insert then update)', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'v-uuid-1';

    await app.request(`/api/${u}/visits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(visitPayload(id, 5)),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });

    await app.request(`/api/${u}/visits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(visitPayload(id, 7)),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });

    const rows = await db.select().from(schema.visits).where(eq(schema.visits.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].distance).toBe(7);
  });

  test('returns 204', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'v-uuid-2';
    const res = await app.request(`/api/${u}/visits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(visitPayload(id)),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);
  });

  test('returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/visits/v-1', {
      method: 'PUT',
      body: JSON.stringify(visitPayload('v-1')),
      headers: { 'content-type': 'application/json', ...authHeaders('any-token') },
    });
    expect(res.status).toBe(401);
  });

  test('returns 400 when required fields missing', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/visits/v-bad`, {
      method: 'PUT',
      body: JSON.stringify({ date: '2026-04-27T10:00:00Z' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });
});

// audit #3170 — the visits route persists eight optional/nullable columns
// (startLabel, destName, poiCategory, tripMode, routeCoords [jsonb],
// routeDuration, returnRouteCoords [jsonb], returnRouteDuration). The fake-DB
// suite only asserts buildRow's output; nothing wrote them through the real
// route and read them back through Postgres + the GET serializer. These pin the
// actual round-trip: PUT → DB → GET /api/:username.
describe('visits optional fields round-trip', () => {
  const routeCoords = [
    [60.0, 25.0],
    [60.05, 25.05],
    [60.1, 25.1],
  ];
  const returnRouteCoords = [
    [60.1, 25.1],
    [60.05, 25.05],
    [60.0, 25.0],
  ];

  const readBackVisit = async (u: string, token: string, id: string) => {
    const res = await app.request(`/api/${u}`, { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { visits: Record<string, unknown>[] };
    const visit = body.visits.find((v) => v.id === id);
    expect(visit, `visit ${id} should be present after PUT`).toBeDefined();
    return visit!;
  };

  test('populated optional fields survive write then read back', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'v-rt-1';

    const payload = {
      id,
      ...VISIT_BODY,
      startLabel: 'Home dock',
      destName: 'Hidden Lake',
      poiCategory: 'nature',
      tripMode: 'loop',
      routeCoords,
      routeDuration: 1800,
      returnRouteCoords,
      returnRouteDuration: 1750,
    };

    const put = await app.request(`/api/${u}/visits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(put.status).toBe(204);

    const visit = await readBackVisit(u, token, id);
    expect(visit.startLabel).toBe('Home dock');
    expect(visit.destName).toBe('Hidden Lake');
    expect(visit.poiCategory).toBe('nature');
    expect(visit.tripMode).toBe('loop');
    expect(visit.routeCoords).toEqual(routeCoords); // jsonb array preserved
    expect(visit.routeDuration).toBe(1800);
    expect(visit.returnRouteCoords).toEqual(returnRouteCoords);
    expect(visit.returnRouteDuration).toBe(1750);
  });

  test('omitted optional fields read back as null', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'v-rt-2';

    // VISIT_BODY carries only the required fields — every optional one is absent.
    const put = await app.request(`/api/${u}/visits/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ id, ...VISIT_BODY }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(put.status).toBe(204);

    const visit = await readBackVisit(u, token, id);
    expect(visit.startLabel).toBeNull();
    expect(visit.destName).toBeNull();
    expect(visit.poiCategory).toBeNull();
    expect(visit.tripMode).toBeNull();
    expect(visit.routeCoords).toBeNull();
    expect(visit.routeDuration).toBeNull();
    expect(visit.returnRouteCoords).toBeNull();
    expect(visit.returnRouteDuration).toBeNull();
  });
});

describe('DELETE /:username/visits/:id', () => {
  test('removes only that row', async () => {
    const { username: u, token } = await createTestAccount();
    const id1 = 'v-del-1';
    const id2 = 'v-del-2';

    await db.insert(schema.visits).values([
      { id: id1, username: u, date: VISIT_BODY.date, startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5 },
      { id: id2, username: u, date: VISIT_BODY.date, startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5 },
    ]);

    const res = await app.request(`/api/${u}/visits/${id1}`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);

    const remaining = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(id2);
  });

  test('returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/visits/v-1', { method: 'DELETE', headers: authHeaders('any-token') });
    expect(res.status).toBe(401);
  });

  // audit #3169 — for an existing user, DELETE on an id that matches no row is a
  // silent no-op: the handler issues an unconditional delete-where(id ∧ username)
  // and returns 204 regardless of how many rows matched. Pin that 204, and that
  // it doesn't error or touch the user's other rows.
  test('returns 204 no-op for a non-existent visit id (existing user)', async () => {
    const { username: u, token } = await createTestAccount();
    const survivorId = 'v-survivor';
    await db.insert(schema.visits).values({
      id: survivorId, username: u, date: VISIT_BODY.date,
      startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5,
    });

    const res = await app.request(`/api/${u}/visits/does-not-exist`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);

    // the unrelated existing row is untouched
    const remaining = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(survivorId);
  });
});

describe('favorites', () => {
  test('PUT upserts favorite', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'fav-1';
    const payload = { name: 'Park', lat: 60.1, lng: 25.1 };

    const r1 = await app.request(`/api/${u}/favorites/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ payload }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(r1.status).toBe(204);

    const newPayload = { name: 'Updated Park', lat: 60.2, lng: 25.2 };
    await app.request(`/api/${u}/favorites/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ payload: newPayload }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });

    const rows = await db.select().from(schema.favorites).where(eq(schema.favorites.id, id));
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { name: string }).name).toBe('Updated Park');
  });

  test('DELETE removes favorite', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'fav-del-1';
    await db.insert(schema.favorites).values({ id, username: u, payload: { name: 'X' } });
    const res = await app.request(`/api/${u}/favorites/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.favorites).where(eq(schema.favorites.id, id));
    expect(rows).toHaveLength(0);
  });

  test('PUT favorites returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/favorites/f-1', {
      method: 'PUT',
      body: JSON.stringify({ payload: {} }),
      headers: { 'content-type': 'application/json', ...authHeaders('any-token') },
    });
    expect(res.status).toBe(401);
  });

  test('DELETE favorites returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/favorites/f-1', {
      method: 'DELETE',
      headers: authHeaders('any-token'),
    });
    expect(res.status).toBe(401);
  });

  // buildRow uses `body.payload !== undefined ? body.payload : body` — a wrapper
  // key is optional, and its absence is a deliberate passthrough (the client PUTs
  // the favorite object directly; see toggleFavorite in app.js). Pin both branches
  // so a refactor can't silently change what gets persisted.
  test('PUT favorites with a { payload } wrapper stores the wrapped value', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'fav-wrap';
    const res = await app.request(`/api/${u}/favorites/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ payload: { name: 'Park' } }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(schema.favorites).where(eq(schema.favorites.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ name: 'Park' });
  });

  test('PUT favorites with no payload key stores the whole body as the payload', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'fav-nowrap';
    const res = await app.request(`/api/${u}/favorites/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Park' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(schema.favorites).where(eq(schema.favorites.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ name: 'Park' });
  });
});

describe('saved-locations', () => {
  test('PUT upserts saved location', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'sl-1';

    await app.request(`/api/${u}/saved-locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Home', value: '60.1,25.1' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    await app.request(`/api/${u}/saved-locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Home Updated', value: '60.2,25.2' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });

    const rows = await db.select().from(schema.savedLocations).where(eq(schema.savedLocations.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Home Updated');
  });

  test('DELETE removes saved location', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'sl-del-1';
    await db.insert(schema.savedLocations).values({ id, username: u, label: 'Work', value: '60.0,24.9' });
    const res = await app.request(`/api/${u}/saved-locations/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.savedLocations).where(eq(schema.savedLocations.id, id));
    expect(rows).toHaveLength(0);
  });

  test('PUT saved-locations returns 400 when label missing', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/saved-locations/sl-bad`, {
      method: 'PUT',
      body: JSON.stringify({ value: '60.0,25.0' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });

  test('PUT saved-locations returns 400 when value missing', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/saved-locations/sl-bad-2`, {
      method: 'PUT',
      body: JSON.stringify({ label: 'Home' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });

  test('PUT saved-locations returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/saved-locations/sl-1', {
      method: 'PUT',
      body: JSON.stringify({ label: 'Home', value: '60.1,25.1' }),
      headers: { 'content-type': 'application/json', ...authHeaders('any-token') },
    });
    expect(res.status).toBe(401);
  });

  test('DELETE saved-locations returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/saved-locations/sl-1', {
      method: 'DELETE',
      headers: authHeaders('any-token'),
    });
    expect(res.status).toBe(401);
  });
});

describe('history', () => {
  test('PUT upserts history row', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'h-1';

    await app.request(`/api/${u}/history/${id}`, {
      method: 'PUT',
      body: JSON.stringify(visitPayload(id, 3)),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    await app.request(`/api/${u}/history/${id}`, {
      method: 'PUT',
      body: JSON.stringify(visitPayload(id, 9)),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });

    const rows = await db.select().from(schema.history).where(eq(schema.history.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].distance).toBe(9);
  });

  test('DELETE removes history row', async () => {
    const { username: u, token } = await createTestAccount();
    const id = 'h-del-1';
    await db.insert(schema.history).values({
      id, username: u, date: VISIT_BODY.date,
      startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5,
    });
    const res = await app.request(`/api/${u}/history/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    expect(res.status).toBe(204);
    const rows = await db.select().from(schema.history).where(eq(schema.history.id, id));
    expect(rows).toHaveLength(0);
  });

  // History shares buildTripBase with visits, so the same required-field set
  // (date/startLat/startLng/destLat/destLng/distance) gates the upsert.
  test('PUT history returns 400 when required fields missing', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/history/h-bad`, {
      method: 'PUT',
      body: JSON.stringify({ date: '2026-04-27T10:00:00Z' }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });

  test('PUT history returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/history/h-1', {
      method: 'PUT',
      body: JSON.stringify(visitPayload('h-1', 3)),
      headers: { 'content-type': 'application/json', ...authHeaders('any-token') },
    });
    expect(res.status).toBe(401);
  });

  test('DELETE history returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/history/h-1', {
      method: 'DELETE',
      headers: authHeaders('any-token'),
    });
    expect(res.status).toBe(401);
  });
});

// The PUT handler is generic over all four sections: parse JSON (→ 400 'Invalid
// JSON' on failure), then reject any non-object body (→ 400 'Body must be an
// object', e.g. a JSON array). Both branches sit before buildRow, so exercising
// them on one section (visits) covers the shared path for all of them.
describe('PUT body-shape validation (generic across sections)', () => {
  test("returns 400 'Invalid JSON' for an unparseable body", async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/visits/v-badjson`, {
      method: 'PUT',
      body: 'not-json',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
  });

  test("returns 400 'Body must be an object' for a JSON array body", async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/visits/v-array`, {
      method: 'PUT',
      body: '[]',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Body must be an object' });
  });
});
