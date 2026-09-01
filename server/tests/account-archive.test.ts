// GET /:username/archive/:section — cursor-paged full-geometry archive dump
import { describe, test, expect, beforeEach } from 'vitest';
import { app, db, truncateAll, createTestAccount, resetRateLimiter, authHeaders } from './helpers.js';
import { schema } from '../src/db.js';
import {
  ARCHIVE_PAGE_DEFAULT_ROWS,
  ARCHIVE_PAGE_MAX_BYTES,
  ARCHIVE_PAGE_MAX_ROWS,
  GET_SNAPSHOT_MAX_BYTES,
} from '../src/lib/validate-fields.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
});

interface Page {
  section: string;
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
}

function dayStamp(i: number): string {
  return new Date(Date.UTC(2026, 0, i + 1)).toISOString();
}

// A routeCoords array of at least `bytes` serialized JSON. Measured rather than
// estimated from a per-pair guess: jsonb rounds trailing zeros off the numbers,
// so a fixed multiplier drifts. Postgres' jsonb::text — what the byte bound
// actually counts — adds ", " between elements, so the stored size only ever
// comes out above this, which is the safe direction for every threshold here.
function coordsOfBytes(bytes: number): [number, number][] {
  const out: [number, number][] = [];
  let size = 2;
  for (let i = 0; size < bytes; i++) {
    const pair: [number, number] = [60 + i * 1e-6, 25 + i * 1e-6];
    out.push(pair);
    size += JSON.stringify(pair).length + 1;
  }
  return out;
}

// The multi-megabyte fixtures below push ~10 MB through pg; the 5 s default
// times the test out mid-insert, and the NEXT test's truncateAll then lands
// while those inserts are still in flight (FK violations on a wiped account).
const FAT_TIMEOUT = 60_000;

async function insertVisit(
  username: string,
  id: string,
  date: string,
  routeCoords: [number, number][] | null = null,
): Promise<void> {
  await db.insert(schema.visits).values({
    id,
    username,
    date,
    startLat: 60,
    startLng: 25,
    destLat: 60.1,
    destLng: 25.1,
    distance: 5,
    routeCoords,
  });
}

async function fetchPage(
  username: string,
  token: string,
  section: string,
  query = '',
): Promise<{ status: number; body: Page }> {
  const res = await app.request(`/api/${username}/archive/${section}${query}`, {
    headers: authHeaders(token),
  });
  return { status: res.status, body: (await res.json()) as Page };
}

describe('GET /api/:username/archive/:section (idea #3715)', () => {
  test('walks every visit newest-first across pages, geometry intact', async () => {
    const { username: u, token } = await createTestAccount();
    for (let i = 0; i < 5; i++) {
      await insertVisit(u, `v-${i}`, dayStamp(i), [[60 + i, 25 + i]]);
    }

    const first = await fetchPage(u, token, 'visits', '?limit=2');
    expect(first.status).toBe(200);
    expect(first.body.section).toBe('visits');
    expect(first.body.rows.map((r) => r.id)).toEqual(['v-4', 'v-3']);
    // The point of the endpoint: stored geometry, not the keep-window strip.
    expect(first.body.rows[0]!.routeCoords).toEqual([[64, 29]]);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await fetchPage(
      u, token, 'visits', `?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
    );
    expect(second.body.rows.map((r) => r.id)).toEqual(['v-2', 'v-1']);
    expect(second.body.nextCursor).toBeTruthy();

    const third = await fetchPage(
      u, token, 'visits', `?limit=2&cursor=${encodeURIComponent(second.body.nextCursor!)}`,
    );
    expect(third.body.rows.map((r) => r.id)).toEqual(['v-0']);
    // Last page — the walk terminates rather than handing back an empty page.
    expect(third.body.nextCursor).toBeNull();
  });

  test('an empty section is one empty page with no cursor', async () => {
    const { username: u, token } = await createTestAccount();
    const page = await fetchPage(u, token, 'history');
    expect(page.status).toBe(200);
    expect(page.body.rows).toEqual([]);
    expect(page.body.nextCursor).toBeNull();
  });

  test('recovers an archive too big for ?geometry=full, which still 413s', async () => {
    const { username: u, token } = await createTestAccount();
    // Six ~1.5 MB visits — 9 MB, over GET_SNAPSHOT_MAX_BYTES (8 MiB) in total.
    const fat = coordsOfBytes(1_500_000);
    for (let i = 0; i < 6; i++) await insertVisit(u, `fat-${i}`, dayStamp(i), fat);

    const dump = await app.request(`/api/${u}?geometry=full`, { headers: authHeaders(token) });
    expect(dump.status).toBe(413);

    // The escape hatch: same rows, one bounded page at a time.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      const page = await fetchPage(u, token, 'visits', q);
      expect(page.status).toBe(200);
      for (const r of page.body.rows) seen.push(r.id as string);
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen.sort()).toEqual(['fat-0', 'fat-1', 'fat-2', 'fat-3', 'fat-4', 'fat-5']);
  }, FAT_TIMEOUT);

  test('cuts a page at ARCHIVE_PAGE_MAX_BYTES rather than the row limit', async () => {
    const { username: u, token } = await createTestAccount();
    // Each row ~1/3 of the page budget, so 3 fit and the 4th does not — well
    // under the default row limit, proving the byte bound is what cut it.
    const chunk = coordsOfBytes(Math.floor(ARCHIVE_PAGE_MAX_BYTES / 3));
    for (let i = 0; i < 5; i++) await insertVisit(u, `b-${i}`, dayStamp(i), chunk);

    const page = await fetchPage(u, token, 'visits');
    expect(page.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(page.body.rows.length).toBeLessThan(5);
    expect(page.body.rows.length).toBeLessThan(ARCHIVE_PAGE_DEFAULT_ROWS);
    expect(page.body.nextCursor).toBeTruthy();
  }, FAT_TIMEOUT);

  test('a single row over the page budget is still returned, alone', async () => {
    const { username: u, token } = await createTestAccount();
    // Reachable through bulk import, whose body cap (5 MiB) is above the page
    // budget — so the page must never stall on a row it cannot fit.
    await insertVisit(u, 'huge', dayStamp(1), coordsOfBytes(ARCHIVE_PAGE_MAX_BYTES + 500_000));
    await insertVisit(u, 'small', dayStamp(0), [[60, 25]]);

    const page = await fetchPage(u, token, 'visits');
    expect(page.body.rows.map((r) => r.id)).toEqual(['huge']);
    expect(page.body.nextCursor).toBeTruthy();

    const next = await fetchPage(
      u, token, 'visits', `?cursor=${encodeURIComponent(page.body.nextCursor!)}`,
    );
    expect(next.body.rows.map((r) => r.id)).toEqual(['small']);
    expect(next.body.nextCursor).toBeNull();
  }, FAT_TIMEOUT);

  test('paginates favorites and savedLocations on updatedAt', async () => {
    const { username: u, token } = await createTestAccount();
    for (let i = 0; i < 3; i++) {
      await db.insert(schema.favorites).values({
        id: `f-${i}`, username: u, payload: { name: `p${i}` }, updatedAt: new Date(dayStamp(i)),
      });
      await db.insert(schema.savedLocations).values({
        id: `s-${i}`, username: u, label: `l${i}`, value: `v${i}`, updatedAt: new Date(dayStamp(i)),
      });
    }

    const favs = await fetchPage(u, token, 'favorites', '?limit=2');
    expect(favs.body.rows.map((r) => r.id)).toEqual(['f-2', 'f-1']);
    expect(favs.body.rows[0]!.payload).toEqual({ name: 'p2' });

    const locs = await fetchPage(u, token, 'savedLocations', '?limit=2');
    expect(locs.body.rows.map((r) => r.id)).toEqual(['s-2', 's-1']);
    expect(locs.body.nextCursor).toBeTruthy();
  });

  test('ties on the sort column are broken by id, so no row repeats or vanishes', async () => {
    const { username: u, token } = await createTestAccount();
    const same = dayStamp(3);
    for (const id of ['t-a', 't-b', 't-c', 't-d']) await insertVisit(u, id, same);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const q: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
      const page = await fetchPage(u, token, 'visits', q);
      for (const r of page.body.rows) seen.push(r.id as string);
      cursor = page.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(['t-d', 't-c', 't-b', 't-a']);
  });

  test('never leaks another account\'s rows', async () => {
    const mine = await createTestAccount();
    const theirs = await createTestAccount();
    await insertVisit(mine.username, 'shared-id', dayStamp(1));
    await insertVisit(theirs.username, 'shared-id', dayStamp(2));

    const page = await fetchPage(mine.username, mine.token, 'visits');
    expect(page.body.rows).toHaveLength(1);
    expect(page.body.rows[0]!.username).toBe(mine.username);
  });

  describe('input validation', () => {
    test('rejects an unknown section', async () => {
      const { username: u, token } = await createTestAccount();
      const res = await app.request(`/api/${u}/archive/accounts`, { headers: authHeaders(token) });
      expect(res.status).toBe(400);
    });

    test.each([
      ['?limit=0', 'zero'],
      ['?limit=-1', 'negative'],
      ['?limit=abc', 'non-numeric'],
      ['?limit=1.5', 'fractional'],
      [`?limit=${ARCHIVE_PAGE_MAX_ROWS + 1}`, 'above the max'],
    ])('rejects limit %s (%s)', async (query) => {
      const { username: u, token } = await createTestAccount();
      const res = await app.request(`/api/${u}/archive/visits${query}`, {
        headers: authHeaders(token),
      });
      expect(res.status).toBe(400);
    });

    test.each([
      ['not-base64!!', 'malformed base64'],
      [Buffer.from('{"k":"nope"}').toString('base64url'), 'missing id'],
      [Buffer.from('not json').toString('base64url'), 'not JSON'],
      [Buffer.from('{"k":"whenever","i":"x"}').toString('base64url'), 'unparseable timestamp'],
    ])('rejects cursor %s (%s)', async (cursor) => {
      const { username: u, token } = await createTestAccount();
      const res = await app.request(
        `/api/${u}/archive/visits?cursor=${encodeURIComponent(cursor)}`,
        { headers: authHeaders(token) },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('auth', () => {
    test('401s with no token', async () => {
      const { username: u } = await createTestAccount();
      const res = await app.request(`/api/${u}/archive/visits`);
      expect(res.status).toBe(401);
    });

    test('401s with another account\'s token', async () => {
      const mine = await createTestAccount();
      const theirs = await createTestAccount();
      const res = await app.request(`/api/${mine.username}/archive/visits`, {
        headers: authHeaders(theirs.token),
      });
      expect(res.status).toBe(401);
    });
  });

  test('page budget stays under the whole-snapshot cap it exists to page around', () => {
    expect(ARCHIVE_PAGE_MAX_BYTES).toBeLessThan(GET_SNAPSHOT_MAX_BYTES);
    expect(ARCHIVE_PAGE_DEFAULT_ROWS).toBeLessThanOrEqual(ARCHIVE_PAGE_MAX_ROWS);
  });
});
