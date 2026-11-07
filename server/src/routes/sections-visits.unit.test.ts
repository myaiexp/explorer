// Unit tests for the visits section PUT and DELETE routes
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRateLimiter } from '../middleware/rate-limit.js';
import { sectionsRoutes } from './sections.js';
import { schema } from '../db.js';
import { MAX_ROWS_PER_SECTION, MAX_STORED_BYTES } from '../lib/limits.js';
import { makeFakeDb, AUTH, jsonReq, validTrip } from './sections-test-fixtures.js';

beforeEach(() => {
  resetRateLimiter();
});

describe('visits PUT', () => {
  it('upserts into the visits table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/visits/v1',
      jsonReq('PUT', validTrip({ poiCategory: 'nature', startLabel: 'Home', destName: 'Lake' }))
    );
    expect(res.status).toBe(204);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('insert');
    expect(ops[0].table).toBe(schema.visits);
    // Conflict target is the composite PK (username, id) — owner-scoped upsert.
    expect(ops[0].conf?.target).toEqual([schema.visits.username, schema.visits.id]);
    // id + username come from the path; payload fields from the body.
    expect(ops[0].row).toMatchObject({
      id: 'v1',
      username: 'alice',
      date: '2026-06-02T10:00:00Z',
      startLat: 60.1,
      startLng: 24.9,
      destLat: 60.2,
      destLng: 25.0,
      distance: 1234,
      poiCategory: 'nature',
      startLabel: 'Home',
      destName: 'Lake',
    });
    // optional fields default to null
    expect(ops[0].row).toMatchObject({
      tripMode: null,
      routeCoords: null,
      routeDuration: null,
      returnRouteCoords: null,
      returnRouteDuration: null,
    });
    // set clause = every column except the PK keys (id + username), plus a fresh
    // updatedAt bump (buildRow omits it) that the client's last-write-wins merge
    // orders by.
    const setKeys = Object.keys(ops[0].conf!.set).sort();
    expect(setKeys).toEqual(
      [
        'date',
        'destLat',
        'destLng',
        'destName',
        'distance',
        'poiCategory',
        'returnRouteCoords',
        'returnRouteDuration',
        'routeCoords',
        'routeDuration',
        'startLabel',
        'startLat',
        'startLng',
        'tripMode',
        'updatedAt',
      ].sort()
    );
    expect(setKeys).not.toContain('id');
    expect(setKeys).not.toContain('username');
  });

  it('defaults non-string poiCategory/startLabel/destName to null', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    await app.request(
      '/alice/visits/v1',
      jsonReq('PUT', validTrip({ poiCategory: 123, startLabel: {}, destName: false }))
    );
    expect(ops[0].row).toMatchObject({ poiCategory: null, startLabel: null, destName: null });
  });

  it('rejects missing date with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ date: undefined })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: date' });
  });

  it('rejects missing distance with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ distance: undefined })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: distance' });
  });

  it('rejects non-number startLat with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ startLat: '60' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: startLat' });
  });

  it('rejects destLat 91 with 400 (scalar range, finding #7775)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ destLat: 91 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/destLat/);
    expect(ops).toHaveLength(0);
  });

  it('rejects startLng 200 with 400 (scalar range, finding #7775)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ startLng: 200 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/startLng/);
    expect(ops).toHaveLength(0);
  });

  it('rejects malformed routeCoords with 400 (RouteCoordsError message)', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/visits/v1',
      jsonReq('PUT', validTrip({ routeCoords: [[999, 0]] }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/routeCoords/);
  });

  it('passes through valid routeCoords into the row', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const coords = [
      [60.1, 24.9],
      [60.2, 25.0],
    ];
    await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ routeCoords: coords })));
    expect(ops[0].row?.routeCoords).toEqual(coords);
  });

  it('returns 409 when a new id would exceed the section row cap', async () => {
    const { db, ops } = makeFakeDb({ userExists: true, rowCount: MAX_ROWS_PER_SECTION });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v-new', jsonReq('PUT', validTrip()));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(String(MAX_ROWS_PER_SECTION));
    expect(ops).toHaveLength(0);
  });

  it('still upserts an existing id when the section is at the cap', async () => {
    const { db, ops } = makeFakeDb({
      userExists: true,
      rowCount: MAX_ROWS_PER_SECTION,
      hasExistingRow: true,
    });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ distance: 99 })));
    expect(res.status).toBe(204);
    expect(ops).toHaveLength(1);
    expect(ops[0].row).toMatchObject({ id: 'v1', distance: 99 });
  });

  it('returns 409 when a new visit would exceed the per-account stored-bytes budget', async () => {
    const { db, ops } = makeFakeDb({ userExists: true, storedBytes: MAX_STORED_BYTES });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/visits/v-fat',
      jsonReq('PUT', validTrip({ routeCoords: [[60.1, 24.9], [60.2, 25.0]] })),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(String(MAX_STORED_BYTES));
    expect(ops).toHaveLength(0);
  });
});

describe('visits DELETE', () => {
  it('deletes from the visits table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(204);
    expect(ops).toEqual([{ op: 'delete', table: schema.visits }]);
  });

  it('returns 401 when the account does not exist', async () => {
    const { db, ops } = makeFakeDb({ userExists: false });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(401);
    expect(ops).toHaveLength(0);
  });
});
