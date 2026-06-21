import { describe, test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, db, truncateAll, createTestAccount, authHeaders, insertTestVisit, insertTestFavorite, resetRateLimiter, VISIT_BODY } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

const makeVisit = (id: string) => ({
  id,
  date: VISIT_BODY.date,
  startLat: VISIT_BODY.startLat,
  startLng: VISIT_BODY.startLng,
  destLat: VISIT_BODY.destLat,
  destLng: VISIT_BODY.destLng,
  distance: VISIT_BODY.distance,
});

describe('POST /api/:username/import', () => {
  test('replaces all sections atomically', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u, 'old-visit');

    const payload = {
      visits: [makeVisit('new-1'), makeVisit('new-2'), makeVisit('new-3')],
      favorites: [],
      savedLocations: [],
      history: [],
    };

    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    expect(rows).toHaveLength(3);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(['new-1', 'new-2', 'new-3']);
  });

  test('returns 401 when no matching account exists (no existence oracle)', async () => {
    const res = await app.request('/api/no-such-user-99/import', {
      method: 'POST',
      body: JSON.stringify({ visits: [], favorites: [], savedLocations: [], history: [] }),
      headers: { 'content-type': 'application/json', ...authHeaders('any-token') },
    });
    expect(res.status).toBe(401);
  });

  test('returns 400 when unknown section is present', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify({ visits: [], favorites: [], savedLocations: [], history: [], unknownSection: [] }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });

  test('rolls back on partial failure — invalid visit row leaves DB unchanged', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u, 'existing');

    const payload = {
      visits: [
        makeVisit('good-1'),
        { id: 'bad', date: '2026-04-27T10:00:00Z' }, // missing required fields
      ],
      favorites: [],
      savedLocations: [],
      history: [],
    };

    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);

    // Original visit still present
    const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('existing');
  });

  test('accepts empty body (all sections default to empty)', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u, 'old');

    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify({ visits: [], favorites: [], savedLocations: [], history: [] }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    expect(rows).toHaveLength(0);
  });

  test('imports all four sections', async () => {
    const { username: u, token } = await createTestAccount();
    const payload = {
      visits: [makeVisit('v-imp-1')],
      favorites: [{ id: 'f-imp-1', payload: { name: 'Park' } }],
      savedLocations: [{ id: 'sl-imp-1', label: 'Home', value: '60,25' }],
      history: [makeVisit('h-imp-1')],
    };

    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const visits = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
    const favorites = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
    const savedLocations = await db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, u));
    const history = await db.select().from(schema.history).where(eq(schema.history.username, u));

    expect(visits).toHaveLength(1);
    expect(favorites).toHaveLength(1);
    expect(savedLocations).toHaveLength(1);
    expect(history).toHaveLength(1);
  });

  // Partial import (only a subset of section keys present). The route is replace-all:
  // an omitted section defaults to [] (body.<section> ?? []) and ALL four sections are
  // unconditionally deleted for the user inside the transaction before re-inserting.
  // So omitting a section is equivalent to passing it empty — its existing rows are wiped.
  // These tests pin that destructive contract; they are not asserting a merge.
  describe('partial payload (subset of section keys)', () => {
    // Seed one row in every section so we can prove exactly which survive a partial import.
    async function seedAllSections(u: string): Promise<void> {
      await insertTestVisit(u, 'seed-visit');
      await insertTestFavorite(u, 'seed-fav');
      await db.insert(schema.savedLocations).values({ id: 'seed-sl', username: u, label: 'Seed', value: '60,25' });
      await db.insert(schema.history).values({
        id: 'seed-hist',
        username: u,
        date: VISIT_BODY.date,
        startLat: VISIT_BODY.startLat,
        startLng: VISIT_BODY.startLng,
        destLat: VISIT_BODY.destLat,
        destLng: VISIT_BODY.destLng,
        distance: VISIT_BODY.distance,
      });
    }

    test('only visits present — replaces visits, wipes the three omitted sections', async () => {
      const { username: u, token } = await createTestAccount();
      await seedAllSections(u);

      // Body carries ONLY the visits key; favorites/savedLocations/history are absent.
      const res = await app.request(`/api/${u}/import`, {
        method: 'POST',
        body: JSON.stringify({ visits: [makeVisit('new-visit')] }),
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
      });
      expect(res.status).toBe(204);

      const visits = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
      const favorites = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
      const savedLocations = await db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, u));
      const history = await db.select().from(schema.history).where(eq(schema.history.username, u));

      // Present section: seeded row gone, new row in.
      expect(visits.map((r) => r.id)).toEqual(['new-visit']);
      // Omitted sections: wiped, not preserved.
      expect(favorites).toHaveLength(0);
      expect(savedLocations).toHaveLength(0);
      expect(history).toHaveLength(0);
    });

    test('two sections present — replaces that subset, wipes the two omitted sections', async () => {
      const { username: u, token } = await createTestAccount();
      await seedAllSections(u);

      // Body carries favorites + history; visits and savedLocations are absent.
      const res = await app.request(`/api/${u}/import`, {
        method: 'POST',
        body: JSON.stringify({
          favorites: [{ id: 'new-fav', payload: { name: 'Lake' } }],
          history: [makeVisit('new-hist')],
        }),
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
      });
      expect(res.status).toBe(204);

      const visits = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
      const favorites = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
      const savedLocations = await db.select().from(schema.savedLocations).where(eq(schema.savedLocations.username, u));
      const history = await db.select().from(schema.history).where(eq(schema.history.username, u));

      // Present subset: replaced with the new rows.
      expect(favorites.map((r) => r.id)).toEqual(['new-fav']);
      expect(history.map((r) => r.id)).toEqual(['new-hist']);
      // Omitted subset: wiped.
      expect(visits).toHaveLength(0);
      expect(savedLocations).toHaveLength(0);
    });
  });
});
