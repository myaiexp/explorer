// @vitest-environment node
// Integration tests for junctions-cache/src/app.ts — the Hono route layer.
// Audit finding #1565: /health, /logs and the /junctions request validation
// (bbox parsing/range/area caps, start-anchored coord/maxKm caps, partial-param
// handling, Overpass-error → 502) had zero coverage.
// Audit finding #3159: partial anchor params (some-but-not-all of
// startLat/startLng/maxKm) now 400 instead of silently falling through to bbox.
//
// createApp() is a pure factory (bootstrap lives in index.ts), so tests import
// it directly and drive `app.fetch` — no serve() mock, no port bind. Exhaustive
// query-parameter parsing lives in parse-request.test.ts; this file still hits
// the 400s through the route so the wiring cannot drift.
//
// Boundaries mocked: the Overpass fetcher (network), and log.js (so /logs can
// assert what getRecentLogs receives and so runs don't spew structured lines).
// cache.ts holds module-level singleton state and reads CACHE_PATH once at
// import, so each test gets a fresh module + isolated empty cache via
// loadServer() (vi.resetModules + a per-test temp CACHE_PATH) — the production
// cache file is never read or written.

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/overpass.js', () => ({ fetchJunctionsFromOverpass: vi.fn() }));
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const tmpDirs: string[] = [];
function tmpCacheFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jsrv-'));
    tmpDirs.push(dir);
    return join(dir, 'cache.json'); // never created — loadCache hits ENOENT and starts empty
}

type FetchFn = (req: Request) => Promise<Response>;

// Fresh app instance with an isolated empty cache. resetModules + a per-test
// CACHE_PATH give cache.ts a clean store; re-importing the mocked modules yields
// fresh vi.fns that the freshly-imported createApp() wires to.
async function loadServer() {
    vi.resetModules();
    process.env.CACHE_PATH = tmpCacheFile();
    const overpass = await import('../src/overpass.js');
    const logMod = await import('../src/log.js');
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    return {
        fetch: app.fetch as FetchFn,
        fetchMock: overpass.fetchJunctionsFromOverpass as unknown as Mock,
        getRecentLogs: logMod.getRecentLogs as unknown as Mock,
    };
}

async function get(fetch: FetchFn, path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(new Request('http://localhost' + path));
    return { status: res.status, body: await res.json() };
}

// Fake timers keep the cache's debounced 200ms save from ever firing (no real fs
// write, no dangling handle); real fs reads in loadCache still resolve.
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => {
    vi.useRealTimers();
    delete process.env.LOGS_TOKEN; // never leak the /logs auth gate into other tests
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// get() with explicit request headers (e.g. an Authorization bearer for /logs).
async function getWith(fetch: FetchFn, path: string, headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const res = await fetch(new Request('http://localhost' + path, { headers }));
    return { status: res.status, body: await res.json() };
}

// A small, in-range, well-under-area-cap bbox used wherever a VALID bbox is just
// a precondition (every request — including anchored mode — requires one).
const OK_BBOX = '60,24,60.5,24.5';

// ── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
    test('returns 200 with ok:true and the live cache-entry count', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/health');
        expect(status).toBe(200);
        expect(body).toEqual({ ok: true, cacheEntries: 0 }); // fresh cache ⇒ 0
    });
});

// ── GET /junctions — bbox required + exclude + bbox parsing/range/area ─────────

describe('GET /junctions — bbox guard, exclude, parsing', () => {
    test('missing bbox → 400 "missing bbox"', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/junctions');
        expect(status).toBe(400);
        expect(body.error).toBe('missing bbox');
    });

    // finding #7559: start/radius on the query string land in nginx access
    // logs, so GET refuses them even when bbox is also missing. POST-without-
    // bbox is the "missing bbox" case (post-junctions.test.ts).
    test('start params on the query string → 400 pointing at the POST body', async () => {
        const { fetch, fetchMock } = await loadServer();
        const { status, body } = await get(fetch, '/junctions?startLat=60.2&startLng=24.2&maxKm=10');
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('exclude other than default|winter → 400', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, `/junctions?bbox=${OK_BBOX}&exclude=bogus`);
        expect(status).toBe(400);
        expect(body.error).toMatch(/exclude must be/);
    });

    test('bbox with wrong component count → 400 "bbox must be …"', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/junctions?bbox=60,24,60.5');
        expect(status).toBe(400);
        expect(body.error).toMatch(/bbox must be/);
    });

    test('bbox with non-numeric components → 400 "bbox must be …"', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/junctions?bbox=a,b,c,d');
        expect(status).toBe(400);
        expect(body.error).toMatch(/bbox must be/);
    });

    test('bbox out of range (maxLat > 90) → 400 "out of range or inverted"', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/junctions?bbox=0,0,91,1');
        expect(status).toBe(400);
        expect(body.error).toMatch(/out of range or inverted/);
    });

    test('inverted bbox (minLat ≥ maxLat) → 400 "out of range or inverted"', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await get(fetch, '/junctions?bbox=61,24,60,25');
        expect(status).toBe(400);
        expect(body.error).toMatch(/out of range or inverted/);
    });

    test('bbox area above the cap → 400 "bbox too large"', async () => {
        const { fetch } = await loadServer();
        // 3°×3° = 9 deg² > MAX_AREA_DEG2 (4)
        const { status, body } = await get(fetch, '/junctions?bbox=0,0,3,3');
        expect(status).toBe(400);
        expect(body.error).toBe('bbox too large');
    });

    // Boundary that pins the comparator: the cap is `area > 4` (strict), so an
    // area of EXACTLY 4 must pass through to the lookup, not be rejected.
    test('bbox area exactly at the cap (4 deg²) is accepted, not "too large"', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 61, lng: 25 }]);
        // 2°×2° = 4 deg², all coords in range
        const { status, body } = await get(fetch, '/junctions?bbox=60,24,62,26');
        expect(status).toBe(200);
        expect(body.cache).toBe('miss');
    });
});

// ── GET /junctions — legacy bbox mode lookup (miss/hit) + Overpass error ───────

describe('GET /junctions — legacy bbox lookup', () => {
    test('cache miss fetches Overpass and returns the legacy shape (no total)', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await get(fetch, `/junctions?bbox=${OK_BBOX}`);
        expect(status).toBe(200);
        expect(body.cache).toBe('miss');
        expect(body.count).toBe(1);
        expect(typeof body.overpassMs).toBe('number');
        expect(body.junctions).toEqual([{ lat: 60.2, lng: 24.2 }]);
        expect(body.total).toBeUndefined(); // legacy mode carries no `total`
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('second identical request is served from cache — no second fetch, no overpassMs', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        await get(fetch, `/junctions?bbox=${OK_BBOX}`);              // miss
        const { status, body } = await get(fetch, `/junctions?bbox=${OK_BBOX}`); // hit
        expect(status).toBe(200);
        expect(body.cache).toBe('hit');
        expect(body.count).toBe(1);
        expect(body.overpassMs).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('a concurrent waiter is cache=coalesced and still carries overpassMs', async () => {
        const { fetch, fetchMock } = await loadServer();
        let resolveFetch: (v: { lat: number; lng: number }[]) => void = () => {};
        fetchMock.mockReturnValue(new Promise(r => { resolveFetch = r; }));

        const p1 = get(fetch, `/junctions?bbox=${OK_BBOX}`);
        const p2 = get(fetch, `/junctions?bbox=${OK_BBOX}`);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        resolveFetch([{ lat: 60.2, lng: 24.2 }]);
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r1.body.cache).toBe('miss');
        expect(r2.body.cache).toBe('coalesced');
        expect(typeof r1.body.overpassMs).toBe('number');
        expect(typeof r2.body.overpassMs).toBe('number');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('Overpass failure → 502 with the busy message', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status, body } = await get(fetch, `/junctions?bbox=${OK_BBOX}`);
        expect(status).toBe(502);
        expect(body.error).toBe('POI search is busy. Please try again.');
    });
});

// ── GET /junctions — query-string anchors refused (finding #7559) ──────────────
// startLat/startLng/maxKm on the request line land in nginx access logs at full
// JS precision (often home). GET is bbox-only; anchored lookups go through POST.
// Validation of the values themselves is POST-only (post-junctions.test.ts).

describe('GET /junctions — query-string anchors refused', () => {
    test('bbox + start query params → 400 POST body, no Overpass call', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await get(
            fetch,
            `/junctions?bbox=${OK_BBOX}&startLat=60.2&startLng=24.2&maxKm=10`,
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a partial start query (only startLat) is refused the same way', async () => {
        const { fetch, fetchMock } = await loadServer();
        const { status, body } = await get(fetch, `/junctions?bbox=${OK_BBOX}&startLat=60.2`);
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

// ── GET /logs — n-param parsing (authorized) ──────────────────────────────────
// app.ts parses `n` and applies a NaN fallback (→ 100) before handing it to
// getRecentLogs; the clamp to [1,500] lives in log.ts (out of scope here, mocked).
// /logs is CLOSED by default (see the auth-gate block below), so these parse-path
// tests must present the LOGS_TOKEN bearer to reach getRecentLogs at all.
// SUT vs finding: there is NO log file — getRecentLogs reads an in-memory ring
// buffer, so "absent log file" maps to "empty ring ⇒ []" (last test below).

describe('GET /logs — n parsing', () => {
    const AUTH = { Authorization: 'Bearer sekret' };
    beforeEach(() => { process.env.LOGS_TOKEN = 'sekret'; });

    test('valid n is parsed and passed through to getRecentLogs', async () => {
        const { fetch, getRecentLogs } = await loadServer();
        getRecentLogs.mockReturnValue([{ ts: 't', level: 'INFO', fields: {} }]);
        const { status, body } = await getWith(fetch, '/logs?n=5', AUTH);
        expect(status).toBe(200);
        expect(getRecentLogs).toHaveBeenCalledWith(5);
        expect(body).toEqual({ logs: [{ ts: 't', level: 'INFO', fields: {} }] });
    });

    test('non-numeric n falls back to the default of 100', async () => {
        const { fetch, getRecentLogs } = await loadServer();
        getRecentLogs.mockReturnValue([]);
        const { status } = await getWith(fetch, '/logs?n=abc', AUTH);
        expect(status).toBe(200);
        expect(getRecentLogs).toHaveBeenCalledWith(100);
    });

    test('absent n defaults to 100', async () => {
        const { fetch, getRecentLogs } = await loadServer();
        getRecentLogs.mockReturnValue([]);
        await getWith(fetch, '/logs', AUTH);
        expect(getRecentLogs).toHaveBeenCalledWith(100);
    });

    test('empty ring (no logs yet — there is no log file) → { logs: [] }', async () => {
        const { fetch, getRecentLogs } = await loadServer();
        getRecentLogs.mockReturnValue([]);
        const { status, body } = await getWith(fetch, '/logs?n=10', AUTH);
        expect(status).toBe(200);
        expect(body).toEqual({ logs: [] });
    });
});

// ── GET /logs — LOGS_TOKEN bearer gate (closed by default) ─────────────────────
// /logs echoes anchored-lookup events that include the walker's `start` (~110 m,
// ≈ home) + radius and is publicly reachable via the VPS proxy, so it is CLOSED
// by default: unset LOGS_TOKEN ⇒ 401 without touching getRecentLogs. Setting
// LOGS_TOKEN reopens it behind Authorization: Bearer <LOGS_TOKEN> (constant-time),
// which still 401s on a missing/wrong token, never reading logs.

describe('GET /logs — LOGS_TOKEN auth gate', () => {
    test('unset LOGS_TOKEN → 401 by default (closed), no log read', async () => {
        // afterEach deletes LOGS_TOKEN, so it is unset here — the secure default.
        const { fetch, getRecentLogs } = await loadServer();
        const { status, body } = await get(fetch, '/logs');
        expect(status).toBe(401);
        expect(body).toEqual({ error: 'unauthorized' });
        expect(getRecentLogs).not.toHaveBeenCalled();
    });

    test('with LOGS_TOKEN set, a missing token → 401 and no log read', async () => {
        process.env.LOGS_TOKEN = 'sekret';
        const { fetch, getRecentLogs } = await loadServer();
        const { status, body } = await get(fetch, '/logs');
        expect(status).toBe(401);
        expect(body).toEqual({ error: 'unauthorized' });
        expect(getRecentLogs).not.toHaveBeenCalled();
    });

    test('with LOGS_TOKEN set, a wrong token → 401', async () => {
        process.env.LOGS_TOKEN = 'sekret';
        const { fetch, getRecentLogs } = await loadServer();
        const { status } = await getWith(fetch, '/logs', { Authorization: 'Bearer nope' });
        expect(status).toBe(401);
        expect(getRecentLogs).not.toHaveBeenCalled();
    });

    test('with LOGS_TOKEN set, the correct bearer token → 200 and serves logs', async () => {
        process.env.LOGS_TOKEN = 'sekret';
        const { fetch, getRecentLogs } = await loadServer();
        getRecentLogs.mockReturnValue([{ ts: 't', level: 'INFO', fields: {} }]);
        const { status, body } = await getWith(fetch, '/logs?n=5', { Authorization: 'Bearer sekret' });
        expect(status).toBe(200);
        expect(getRecentLogs).toHaveBeenCalledWith(5);
        expect(body).toEqual({ logs: [{ ts: 't', level: 'INFO', fields: {} }] });
    });
});

// ── Per-IP rate limiting is wired onto the routes ─────────────────────────────
// The token-bucket logic itself is unit-tested in rate-limit.test.ts; here we
// only prove the middleware is actually attached to the live routes. All requests
// from a captured app.fetch share one bucket (no X-Forwarded-For ⇒ key "unknown"),
// so exhausting the /junctions budget (60/min) yields a 429 on the 61st call.

describe('per-IP rate limiting', () => {
    test('/junctions 429s once the per-IP budget is exhausted (cache hits still count)', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]); // first call misses, rest hit cache
        const statuses: number[] = [];
        for (let i = 0; i < 61; i++) {
            statuses.push((await get(fetch, `/junctions?bbox=${OK_BBOX}`)).status);
        }
        expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true); // budget = 60
        expect(statuses[60]).toBe(429);                                  // 61st blocked
        expect(fetchMock).toHaveBeenCalledTimes(1);                      // only the first miss fetched
    });
});
