// Unit tests for the saved-locations and history section routes
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRateLimiter } from '../middleware/rate-limit.js';
import { sectionsRoutes } from './sections.js';
import { schema } from '../db.js';
import { MAX_STORED_BYTES } from '../lib/limits.js';
import { makeFakeDb, AUTH, jsonReq, validTrip } from './sections-test-fixtures.js';

beforeEach(() => {
  resetRateLimiter();
});

// ── saved-locations ───────────────────────────────────────────────────────────

describe('saved-locations PUT', () => {
  it('upserts into the savedLocations table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/saved-locations/s1',
      jsonReq('PUT', { label: 'Work', value: '60.1,24.9' })
    );
    expect(res.status).toBe(204);
    expect(ops[0].table).toBe(schema.savedLocations);
    expect(ops[0].conf?.target).toEqual([schema.savedLocations.username, schema.savedLocations.id]);
    expect(ops[0].row).toEqual({ id: 's1', username: 'alice', label: 'Work', value: '60.1,24.9' });
    expect(Object.keys(ops[0].conf!.set).sort()).toEqual(['label', 'updatedAt', 'value']);
  });

  it('rejects missing label with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/saved-locations/s1', jsonReq('PUT', { value: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: label' });
  });

  it('rejects missing value with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/saved-locations/s1', jsonReq('PUT', { label: 'x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: value' });
  });

  it('still inserts at the stored-bytes budget (saved-locations add no jsonb)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true, storedBytes: MAX_STORED_BYTES });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/saved-locations/s-at-cap',
      jsonReq('PUT', { label: 'Home', value: '60.1,24.9' }),
    );
    expect(res.status).toBe(204);
    expect(ops).toHaveLength(1);
  });
});

describe('saved-locations DELETE', () => {
  it('deletes from the savedLocations table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/saved-locations/s1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(204);
    expect(ops).toEqual([{ op: 'delete', table: schema.savedLocations }]);
  });
});

// ── history ───────────────────────────────────────────────────────────────────

describe('history PUT', () => {
  it('upserts into the history table and returns 204 (no poiCategory column)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/history/h1',
      jsonReq('PUT', validTrip({ tripMode: 'loop', startLabel: 'Home' }))
    );
    expect(res.status).toBe(204);
    expect(ops[0].table).toBe(schema.history);
    expect(ops[0].conf?.target).toEqual([schema.history.username, schema.history.id]);
    expect(ops[0].row).toMatchObject({
      id: 'h1',
      username: 'alice',
      date: '2026-06-02T10:00:00Z',
      tripMode: 'loop',
      startLabel: 'Home',
      distance: 1234,
    });
    // history has NO poiCategory column
    expect(ops[0].row).not.toHaveProperty('poiCategory');
    const setKeys = Object.keys(ops[0].conf!.set);
    expect(setKeys).not.toContain('poiCategory');
    expect(setKeys).not.toContain('id');
    expect(setKeys).not.toContain('username');
    expect(setKeys).toContain('tripMode');
    expect(setKeys).toContain('updatedAt');
  });

  it('rejects missing destLat with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/history/h1', jsonReq('PUT', validTrip({ destLat: undefined })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing required field: destLat' });
  });

  it('rejects malformed returnRouteCoords with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/history/h1',
      jsonReq('PUT', validTrip({ returnRouteCoords: 'nope' }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/returnRouteCoords/);
  });
});

describe('history DELETE', () => {
  it('deletes from the history table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/history/h1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(204);
    expect(ops).toEqual([{ op: 'delete', table: schema.history }]);
  });

  it('returns 401 when the account does not exist', async () => {
    const { db, ops } = makeFakeDb({ userExists: false });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/history/h1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(401);
    expect(ops).toHaveLength(0);
  });
});
