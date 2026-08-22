import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { sectionsRoutes } from './sections.js';
import { resetRateLimiter } from '../middleware/rate-limit.js';
import { hashToken } from '../lib/token-hash.js';

// Captures the single insert/delete op a handler issues against the fake Db.
interface RecordedOp {
  op: 'insert' | 'delete';
  table: unknown;
  row?: Record<string, unknown>;
  conf?: { target: unknown; set: Record<string, unknown> };
}

// Fake Db reproducing the exact drizzle call chains the handlers use:
//   auth:   db.select({...}).from(accounts).where(c)        -> rows[]
//   upsert: db.insert(t).values(row).onConflictDoUpdate     -> void
//   delete: db.delete(t).where(c)                           -> void
// `userExists` models whether the account row exists: true → the select returns
// the account (auth finds a matching token), false → [] (auth 401s). The handlers
// no longer re-check existence themselves — accountAuth is the sole gate.
function makeFakeDb(opts: { userExists: boolean }) {
  const ops: RecordedOp[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              // Auth middleware hashes the presented bearer and compares to
              // `.token` (a SHA-256 digest) on row 0.
              return Promise.resolve(opts.userExists ? [{ username: 'alice', token: hashToken('sekret') }] : []);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(row: Record<string, unknown>) {
          return {
            onConflictDoUpdate(conf: { target: unknown; set: Record<string, unknown> }) {
              ops.push({ op: 'insert', table, row, conf });
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          ops.push({ op: 'delete', table });
          return Promise.resolve();
        },
      };
    },
  };
  return { db: db as unknown as Db, ops };
}

// Valid auth for the fake account (plaintext bearer; the fake row stores the hash).
const AUTH = { Authorization: 'Bearer sekret' };

function jsonReq(method: 'PUT', body: unknown) {
  return {
    method,
    headers: { 'content-type': 'application/json', ...AUTH },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

// A minimal valid trip body (visits/history share this shape).
function validTrip(extra: Record<string, unknown> = {}) {
  return {
    date: '2026-06-02T10:00:00Z',
    startLat: 60.1,
    startLng: 24.9,
    destLat: 60.2,
    destLng: 25.0,
    distance: 1234,
    ...extra,
  };
}

beforeEach(() => {
  resetRateLimiter();
});

// ── shared factory-level behavior (exercised through each section) ───────────

describe('section PUT — shared guards', () => {
  it('returns 401 when the account does not exist (auth blocks before the body)', async () => {
    // A missing account has no token to match, so auth rejects with 401 before
    // the handler's body checks ever run.
    const { db, ops } = makeFakeDb({ userExists: false });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip()));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(ops).toHaveLength(0);
  });

  it('returns 400 "Invalid JSON" for an unparseable body', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', '{not json'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(ops).toHaveLength(0);
  });

  it('returns 400 "Body must be an object" for a JSON array', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', []));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Body must be an object' });
    expect(ops).toHaveLength(0);
  });
});

// ── visits ──────────────────────────────────────────────────────────────────

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

// ── favorites ─────────────────────────────────────────────────────────────────

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

// ── field validation: ISO date, string-length caps, body-size limit ───────────

describe('date validation', () => {
  it('rejects a present-but-malformed date with a 400 and ISO message', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ date: 'last tuesday' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'date must be an ISO-8601 timestamp' });
    expect(ops).toHaveLength(0);
  });

  it('rejects a SQL-ish string masquerading as a date with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/history/h1', jsonReq('PUT', validTrip({ date: 'DROP TABLE visits' })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ISO-8601/);
  });

  it('accepts a bare ISO date (YYYY-MM-DD) prefix', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ date: '2026-06-02' })));
    expect(res.status).toBe(204);
    expect(ops[0].row?.date).toBe('2026-06-02');
  });
});

describe('string-length caps', () => {
  it('rejects an over-length startLabel with 400', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ startLabel: 'x'.repeat(501) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/startLabel exceeds maximum length/);
    expect(ops).toHaveLength(0);
  });

  it('rejects an over-length poiCategory with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ poiCategory: 'x'.repeat(501) })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/poiCategory exceeds maximum length/);
  });

  it('rejects an over-length saved-location label with 400', async () => {
    const { db } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/saved-locations/s1', jsonReq('PUT', { label: 'x'.repeat(501), value: 'ok' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/label exceeds maximum length/);
  });

  it('accepts a destName up to the 2000-char name cap', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request('/alice/visits/v1', jsonReq('PUT', validTrip({ destName: 'x'.repeat(2000) })));
    expect(res.status).toBe(204);
    expect(ops[0].row?.destName).toHaveLength(2000);
  });
});

describe('request body-size limit', () => {
  it('rejects an oversized body (giant unknown key) with 413 before the handler runs', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    // > 1 MiB total — bodyLimit rejects via the Content-Length fast path (the realistic
    // case: nginx and fetch both set it) before c.req.json() buffers the body.
    const body = JSON.stringify(validTrip({ junk: 'x'.repeat(1_100_000) }));
    const res = await app.request('/alice/visits/v1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...AUTH },
      body,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Request body too large' });
    expect(ops).toHaveLength(0);
  });
});
