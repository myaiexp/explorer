// Unit tests for shared section guards, field validation and body-size limit
import { describe, it, expect, beforeEach } from 'vitest';
import { resetRateLimiter } from '../middleware/rate-limit.js';
import { sectionsRoutes } from './sections.js';
import { MAX_LABEL_LEN, MAX_NAME_LEN } from '../lib/validate-fields.js';
import { makeFakeDb, AUTH, jsonReq, validTrip } from './sections-test-fixtures.js';

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

  it('rejects an over-length saved-location value with 400', async () => {
    // Finding #12623 — the label cap above was pinned; value shares
    // MAX_LABEL_LEN. The 1 MiB body cap still accepts 501 characters.
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/saved-locations/s1',
      jsonReq('PUT', { label: 'ok', value: 'x'.repeat(MAX_LABEL_LEN + 1) })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(`value exceeds maximum length of ${MAX_LABEL_LEN}`);
    expect(ops).toHaveLength(0);
  });

  it('accepts a saved-location value of exactly MAX_LABEL_LEN', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/saved-locations/s1',
      jsonReq('PUT', { label: 'ok', value: 'x'.repeat(MAX_LABEL_LEN) })
    );
    expect(res.status).toBe(204);
    expect(ops).toHaveLength(1);
    expect(ops[0].row?.value).toHaveLength(MAX_LABEL_LEN);
  });

  it('rejects an over-length tripMode with 400', async () => {
    // Finding #7590 — startLabel/poiCategory/destName were pinned; tripMode
    // shares tooLong(MAX_LABEL_LEN) and would 400 in production with no pin.
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/visits/v1',
      jsonReq('PUT', validTrip({ tripMode: 'x'.repeat(MAX_LABEL_LEN + 1) }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(`tripMode exceeds maximum length of ${MAX_LABEL_LEN}`);
    expect(ops).toHaveLength(0);
  });

  it('rejects an over-length destName with 400', async () => {
    const { db, ops } = makeFakeDb({ userExists: true });
    const app = sectionsRoutes(db);
    const res = await app.request(
      '/alice/visits/v1',
      jsonReq('PUT', validTrip({ destName: 'x'.repeat(MAX_NAME_LEN + 1) }))
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual(`destName exceeds maximum length of ${MAX_NAME_LEN}`);
    expect(ops).toHaveLength(0);
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
