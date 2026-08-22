import { describe, test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { app, db, truncateAll, createTestAccount, authHeaders, insertTestVisit, insertTestFavorite, resetRateLimiter, VISIT_BODY } from './helpers.js';
import { schema } from '../src/db.js';
import {
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_ROWS_PER_SECTION,
} from '../src/lib/validate-fields.js';

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

  // audit #4832 — importVisits preserves the exported row ids, so two accounts
  // importing the same shared walks-export JSON carry identical ids. Under the old
  // global-id PK the second import's insert collided and aborted with an opaque
  // 500. The composite PK (username, id) makes each account's rows independent.
  test("importing another account's exported ids succeeds independently (no cross-account collision)", async () => {
    const a = await createTestAccount();
    const b = await createTestAccount();
    const shared = { visits: [makeVisit('shared-1'), makeVisit('shared-2')], favorites: [], savedLocations: [], history: [] };

    const rA = await app.request(`/api/${a.username}/import`, {
      method: 'POST', body: JSON.stringify(shared),
      headers: { 'content-type': 'application/json', ...authHeaders(a.token) },
    });
    expect(rA.status).toBe(204);

    const rB = await app.request(`/api/${b.username}/import`, {
      method: 'POST', body: JSON.stringify(shared),
      headers: { 'content-type': 'application/json', ...authHeaders(b.token) },
    });
    expect(rB.status).toBe(204);

    const rowsA = await db.select().from(schema.visits).where(eq(schema.visits.username, a.username));
    const rowsB = await db.select().from(schema.visits).where(eq(schema.visits.username, b.username));
    expect(rowsA.map((r) => r.id).sort()).toEqual(['shared-1', 'shared-2']);
    expect(rowsB.map((r) => r.id).sort()).toEqual(['shared-1', 'shared-2']);
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

  // idea #2485 — two rows sharing an id in one section violate the composite
  // (username, id) PK. Must 400 with a clear message before the tx, not 500.
  test('returns 400 when a section has two rows with the same id', async () => {
    const { username: u, token } = await createTestAccount();
    await insertTestVisit(u, 'existing');

    const payload = {
      visits: [makeVisit('dup-1'), makeVisit('dup-1')],
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
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/duplicate/i);
    expect(body.error).toMatch(/dup-1/);

    // Pre-check failure — no write, original visit intact
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

  // The client (sync.js) stores favorites FLAT — {id, destLat, destName, …} with no
  // `payload` wrapper — and bulk-imports them verbatim. import must accept the flat
  // shape (mirroring the per-row PUT's `payload = body.payload ?? body`), or every
  // favorite is silently dropped on account creation (#2065).
  test('imports flat favorites (no payload wrapper) by wrapping the whole row', async () => {
    const { username: u, token } = await createTestAccount();
    const flatFav = { id: 'f-flat-1', destLat: 60.1, destLng: 24.9, destName: 'Park', distance: 3 };
    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify({ visits: [], favorites: [flatFav], savedLocations: [], history: [] }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);

    const favorites = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
    expect(favorites).toHaveLength(1);
    expect(favorites[0].id).toBe('f-flat-1');
    // Stored as the jsonb payload, identical to the per-row PUT path.
    expect(favorites[0].payload).toMatchObject({ destLat: 60.1, destName: 'Park' });
  });

  // A pre-wrapped favorite ({id, payload}) must still import unchanged — the flat-shape
  // acceptance above must not double-wrap an already-wrapped payload.
  test('imports pre-wrapped favorites without double-wrapping', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: JSON.stringify({ visits: [], favorites: [{ id: 'f-wrap-1', payload: { destName: 'Lake' } }], savedLocations: [], history: [] }),
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(204);
    const favorites = await db.select().from(schema.favorites).where(eq(schema.favorites.username, u));
    expect(favorites).toHaveLength(1);
    expect(favorites[0].payload).toEqual({ destName: 'Lake' });
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

  // Per-section row validation rejects with 400 BEFORE the replace-all transaction runs,
  // so a seeded visit must survive untouched (proves no deletes/writes happened). Only the
  // invalid-visit path was covered before; these pin the favorites/savedLocations/history
  // validators and the favorite null-payload guard (validateFavorite line `payload === null`).
  describe('row validation rejections (400, no writes)', () => {
    const rowCases: Array<[string, Record<string, unknown>]> = [
      // validateFavorite: explicit `payload === null` guard.
      ['favorite with payload: null', { favorites: [{ id: 'f-1', payload: null }] }],
      // validateFavorite: missing/empty id.
      ['favorite missing id', { favorites: [{ payload: { name: 'Park' } }] }],
      // validateFavorite / validateTripRow: id charset + length (finding #7061).
      ['favorite id with slash', { favorites: [{ id: 'a/b', payload: { name: 'Park' } }] }],
      ['visit id over 128 chars', { visits: [{ ...VISIT_BODY, id: 'a'.repeat(129) }] }],
      ['savedLocation traversal id', { savedLocations: [{ id: '..', label: 'Home', value: '60,25' }] }],
      // validateSavedLocation: missing required `value`.
      ['savedLocation missing value', { savedLocations: [{ id: 'sl-1', label: 'Home' }] }],
      // importTripRow: missing required route-row fields.
      ['history row missing required fields', { history: [{ id: 'bad', date: VISIT_BODY.date }] }],
    ];
    for (const [label, sectionBody] of rowCases) {
      test(`${label} → 400, seeded visit survives`, async () => {
        const { username: u, token } = await createTestAccount();
        await insertTestVisit(u, 'survivor');

        const res = await app.request(`/api/${u}/import`, {
          method: 'POST',
          body: JSON.stringify(sectionBody),
          headers: { 'content-type': 'application/json', ...authHeaders(token) },
        });
        expect(res.status).toBe(400);

        // Transaction never started — the pre-existing visit is untouched.
        const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
        expect(rows.map((r) => r.id)).toEqual(['survivor']);
      });
    }
  });

  // Each section value must be an array. A `null`/`undefined` value defaults to [] via `?? []`,
  // so these guards only fire for non-null, non-array values ({}, string, number, boolean).
  describe('non-array section values → 400', () => {
    const nonArrayCases: Array<[string, unknown]> = [
      ['visits', {}],
      ['favorites', 'string'],
      ['savedLocations', 5],
      ['history', true],
    ];
    for (const [key, value] of nonArrayCases) {
      test(`${key} as ${typeof value === 'object' ? 'object' : typeof value} → 400`, async () => {
        const { username: u, token } = await createTestAccount();
        const res = await app.request(`/api/${u}/import`, {
          method: 'POST',
          body: JSON.stringify({ [key]: value }),
          headers: { 'content-type': 'application/json', ...authHeaders(token) },
        });
        expect(res.status).toBe(400);
      });
    }
  });

  // The handler's own try/catch around c.req.json() (independent of sections.ts) returns 400
  // on an unparseable body. Auth passes first, so a valid token is required to reach the catch.
  test('non-JSON body → 400', async () => {
    const { username: u, token } = await createTestAccount();
    const res = await app.request(`/api/${u}/import`, {
      method: 'POST',
      body: 'not-json',
      headers: { 'content-type': 'application/json', ...authHeaders(token) },
    });
    expect(res.status).toBe(400);
  });

  // audit #1343 — bodyLimit + per-section row cap. Coordinate-array length is
  // already enforced inside validateTripRow → assertRouteCoords (MAX_ROUTE_COORDS).
  describe('import size limits (audit #1343)', () => {
    test('rejects an oversized body with 413 before the handler runs', async () => {
      const { username: u, token } = await createTestAccount();
      await insertTestVisit(u, 'survivor');

      // Content-Length over the cap — bodyLimit's fast path rejects without
      // buffering the whole body into JSON.parse.
      const oversize = MAX_IMPORT_BODY_BYTES + 1;
      const res = await app.request(`/api/${u}/import`, {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'content-length': String(oversize),
          ...authHeaders(token),
        },
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'Request body too large' });

      // No write reached the DB.
      const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
      expect(rows.map((r) => r.id)).toEqual(['survivor']);
    });

    test('rejects a section with more than MAX_IMPORT_ROWS_PER_SECTION rows', async () => {
      const { username: u, token } = await createTestAccount();
      await insertTestVisit(u, 'survivor');

      const visits = Array.from({ length: MAX_IMPORT_ROWS_PER_SECTION + 1 }, (_, i) =>
        makeVisit(`v-too-many-${i}`)
      );
      const res = await app.request(`/api/${u}/import`, {
        method: 'POST',
        body: JSON.stringify({ visits, favorites: [], savedLocations: [], history: [] }),
        headers: { 'content-type': 'application/json', ...authHeaders(token) },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/exceeds maximum/);
      expect(body.error).toMatch(String(MAX_IMPORT_ROWS_PER_SECTION));

      // Pre-check failure — no replace transaction, seeded visit intact.
      const rows = await db.select().from(schema.visits).where(eq(schema.visits.username, u));
      expect(rows.map((r) => r.id)).toEqual(['survivor']);
    });
  });
});
