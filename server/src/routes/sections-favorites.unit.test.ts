// Unit tests for the favorites section PUT and DELETE routes
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRateLimiter } from '../middleware/rate-limit.js';
import { sectionsRoutes } from './sections.js';
import { schema } from '../db.js';
import { makeFakeDb, AUTH, jsonReq } from './sections-test-fixtures.js';

beforeEach(() => {
  resetRateLimiter();
});

describe('favorites PUT', () => {
  it('upserts into the favorites table with the payload field and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/favorites/f1', jsonReq('PUT', { payload: { name: 'X' } }));
    expect(res.status).toBe(204);
    expect(ops[0].table).toBe(schema.favorites);
    expect(ops[0].conf?.target).toEqual([schema.favorites.username, schema.favorites.id]);
    expect(ops[0].row).toEqual({ id: 'f1', username: 'alice', payload: { name: 'X' } });
    expect(Object.keys(ops[0].conf!.set).sort()).toEqual(['payload', 'updatedAt']);
  });

  it('uses the whole body as payload when no payload field is present (client contract)', async () => {
    // The client PUTs the favorite object directly (no `payload` wrapper), so the
    // whole body becomes the stored JSONB. This fall-back is intentional.
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    await app.request('/alice/favorites/f1', jsonReq('PUT', { color: 'red', n: 3 }));
    expect(ops[0].row?.payload).toEqual({ color: 'red', n: 3 });
  });

  it('rejects an over-size payload with 400 (explicit payload field)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const huge = { blob: 'x'.repeat(520_000) }; // serialized length > 512_000
    const res = await app.request('/alice/favorites/f1', jsonReq('PUT', { payload: huge }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/payload exceeds maximum size/);
    expect(ops).toHaveLength(0);
  });

  it('rejects an over-size whole-body favorite with 400 (fall-back path is capped too)', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/favorites/f1', jsonReq('PUT', { blob: 'x'.repeat(520_000) }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/payload exceeds maximum size/);
    expect(ops).toHaveLength(0);
  });

  it('rejects a non-object payload (array) with 400 so a 204 cannot persist an undrawable row', async () => {
    // Finding #7307: validateFavoriteRow used to accept {payload: []} / {payload: "x"}
    // as JSONB, sync-down left them unusable, and the list renderer threw on first paint.
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/favorites/f1', jsonReq('PUT', { payload: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/payload must be an object/);
    expect(ops).toHaveLength(0);
  });

  it('rejects a non-object payload (string) with 400', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/favorites/f1', jsonReq('PUT', { payload: 'x' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/payload must be an object/);
    expect(ops).toHaveLength(0);
  });
});

describe('favorites DELETE', () => {
  it('deletes from the favorites table and returns 204', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/favorites/f1', { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(204);
    expect(ops).toEqual([{ op: 'delete', table: schema.favorites }]);
  });
});
