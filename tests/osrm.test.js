// @vitest-environment node
/**
 * Behavioral tests for osrm.js's transport — tryOsrm, snapToRoad and
 * screeningTableFn, fetch-stubbed. The loop builders that call them are in
 * loop-builders.test.js; the public fallback is in osrm-fallback.test.js.
 *
 * Loading: helpers/load.js's SCRIPT_DEPS lists osrm's real edges (net,
 * geo-utils), so loadScripts('osrm') evaluates the production module in this
 * realm. fetchWithTimeout is the real one; it
 * calls the per-test `fetch` stub and clears its abort timer on resolve.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse, installCannedFetch } from './helpers/fetch-stub.js';
import { routeBody, installOsrmKindFetch } from './helpers/osrm-fetch.js';

beforeAll(() => {
    loadScripts('osrm');
});

// osrm.js's self-hosted-down latch and public-request queue are module-scoped
// state that survives every test in this file (loadScripts only runs once, in
// beforeAll above). A handful of tests below deliberately trip the latch
// (self-hosted throw / non-ok) — without a reset, that state would leak into
// later tests and make them silently skip straight to the public fallback.
beforeEach(() => {
    globalThis.resetOsrmFallbackState();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const START = { lat: 60, lng: 24 };

// ── tryOsrm ──────────────────────────────────────────────────────────────────

describe('tryOsrm', () => {
    // tryOsrm's contract is now a path+query SUFFIX (composed onto whichever
    // base — self-hosted or public fallback — it decides to use), not a
    // fully-composed URL. See tests/osrm-fallback.test.js for the fallback
    // behavior itself (latch, throttle, public retry); this block just pins
    // parsing + the "does/doesn't latch" split for a self-hosted response.
    const suffix = '24,60;24.1,60.1';

    test('maps geojson [lng,lat] → [lat,lng] and flattens leg steps', async () => {
        installOsrmKindFetch({
            route: () => jsonResponse(routeBody(
                [[24, 60], [24.1, 60.1]],
                { duration: 42, distance: 900, legs: [{ steps: [{ name: 'a' }] }, { steps: [{ name: 'b' }] }] },
            )),
        });
        await expect(globalThis.tryOsrm(suffix)).resolves.toEqual({
            coords: [[60, 24], [60.1, 24.1]],
            duration: 42,
            distance: 900,
            steps: [{ name: 'a' }, { name: 'b' }],
        });
    });

    test('composes the suffix onto OSRM_FI_BASE while self-hosted is healthy', async () => {
        const fetch = installOsrmKindFetch();
        await globalThis.tryOsrm(suffix);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_FI_BASE}/${suffix}`);
    });

    test('a fetch throw latches self-hosted and falls back to public (still null if both fail)', async () => {
        const fetch = installCannedFetch({ throw: new Error('net') });
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(2); // self-hosted attempt, then public retry
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('a non-ok response latches self-hosted and falls back to public (still null if both fail)', async () => {
        const fetch = installCannedFetch(jsonResponse({}, { status: 500 }));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('a malformed self-hosted body (json() throws) latches and falls back to public', async () => {
        const fetch = installCannedFetch({
            ok: true,
            status: 200,
            json: async () => { throw new Error('bad json'); },
        });
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('returns null when routes is missing or empty, and does NOT latch or ask public', async () => {
        const fetch = installCannedFetch(jsonResponse({}));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);

        const fetch2 = installCannedFetch(jsonResponse({ routes: [] }));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch2).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('returns null on a 200 whose route has no geometry (finding #7785), and does NOT latch', async () => {
        const fetch = installCannedFetch(jsonResponse({
            routes: [{ duration: 1, distance: 1 }],
        }));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('returns null when geometry.coordinates is not an array, and does NOT latch', async () => {
        const fetch = installCannedFetch(jsonResponse({
            routes: [{ duration: 1, distance: 1, geometry: { coordinates: null } }],
        }));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('returns null when geometry.coordinates is an empty array (finding #7926), and does NOT latch', async () => {
        const fetch = installCannedFetch(jsonResponse({
            routes: [{ duration: 1, distance: 1, geometry: { coordinates: [] } }],
        }));
        await expect(globalThis.tryOsrm(suffix)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });
});

// ── snapToRoad ───────────────────────────────────────────────────────────────

describe('snapToRoad', () => {
    const via = { lat: 60, lng: 24 };

    test('returns the snapped point when nearest is within snapRadius', async () => {
        // ~11 m north — well inside the 0.5 km default.
        installOsrmKindFetch({
            nearest: () => jsonResponse({ waypoints: [{ location: [24, 60.0001] }] }),
        });
        await expect(globalThis.snapToRoad(via, 0.5)).resolves.toEqual({ lat: 60.0001, lng: 24 });
    });

    test('keeps the original via when nearest is missing', async () => {
        installOsrmKindFetch({
            nearest: () => jsonResponse({ waypoints: [] }),
        });
        const out = await globalThis.snapToRoad(via, 0.5);
        expect(out).toBe(via);
    });

    test('keeps the original via when nearest is beyond snapRadius', async () => {
        // 60,24 → 60.1,24.1 is ~13 km.
        installOsrmKindFetch({
            nearest: () => jsonResponse({ waypoints: [{ location: [24.1, 60.1] }] }),
        });
        const out = await globalThis.snapToRoad(via, 0.5);
        expect(out).toBe(via);
    });
});

// ── screeningTableFn ─────────────────────────────────────────────────────────

describe('screeningTableFn', () => {
    const c0 = { lat: 60.05, lng: 24.05 };
    const c1 = { lat: 60.08, lng: 24.08 };

    test('maps candidate i onto destinations[i+1] / distances[0][i+1]', async () => {
        // dests[0] / dists[0][0] are the SOURCE. A regression that reads index i
        // would hand candidate 0 the source snap (9999) instead of 12.
        const fetch = installOsrmKindFetch({
            table: () => jsonResponse({
                code: 'Ok',
                destinations: [
                    { distance: 9999 },
                    { distance: 12 },
                    { distance: 34 },
                ],
                distances: [[0, 1000, 2000]],
            }),
        });
        await expect(globalThis.screeningTableFn(START, [c0, c1])).resolves.toEqual([
            { snapM: 12, routeM: 1000 },
            { snapM: 34, routeM: 2000 },
        ]);
        const url = String(fetch.mock.calls[0][0]);
        expect(url).toContain('/table/v1/foot/');
        expect(url).toContain(`${START.lng},${START.lat};${c0.lng},${c0.lat};${c1.lng},${c1.lat}`);
        expect(url).toContain('sources=0');
        expect(url).toContain('annotations=distance');
    });

    test('empty candidates short-circuit to [] without fetching', async () => {
        const fetch = installOsrmKindFetch();
        await expect(globalThis.screeningTableFn(START, [])).resolves.toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('throws on a non-ok HTTP response', async () => {
        installOsrmKindFetch({
            table: () => jsonResponse({}, { status: 503 }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table http 503');
    });

    test('throws when OSRM code is not Ok', async () => {
        installOsrmKindFetch({
            table: () => jsonResponse({ code: 'NoRoute' }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table NoRoute');
    });

    test('throws when destinations or distances[0] is not an array', async () => {
        installOsrmKindFetch({
            table: () => jsonResponse({ code: 'Ok', destinations: { distance: 1 }, distances: [[0, 1]] }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table malformed');

        // Both sub-cases here trip the self-hosted-down latch (a thrown error
        // falls back to public, which — same handler — throws too). Reset
        // between them so the second case isn't just waiting out the public
        // throttle's PUBLIC_MIN_GAP_MS from the first.
        globalThis.resetOsrmFallbackState();

        installOsrmKindFetch({
            table: () => jsonResponse({ code: 'Ok', destinations: [{ distance: 0 }], distances: null }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table malformed');
    });

    test('null-fills snapM / routeM when the i+1 slot is missing or non-numeric', async () => {
        installOsrmKindFetch({
            table: () => jsonResponse({
                code: 'Ok',
                destinations: [{ distance: 0 }], // source only — candidate slot undefined
                distances: [[0, null]],
            }),
        });
        await expect(globalThis.screeningTableFn(START, [c0])).resolves.toEqual([
            { snapM: null, routeM: null },
        ]);
    });
});
