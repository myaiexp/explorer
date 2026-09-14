// @vitest-environment node
/**
 * Behavioral tests for osrm.js's self-hosted → public OSRM fallback.
 *
 * Context: shelly (self-hosted OSRM-foot at mase.fi/api/osrm-fi) has been
 * offline for days, so every OSRM call was timing out and the app was
 * drawing a straight line instead of a route. osrm.js now falls back to the
 * public FOSSGIS server (routing.openstreetmap.de/routed-foot) when
 * self-hosted is down, but that's a free community service under a ~1
 * req/sec fair-use cap, so every public request is paced through a shared
 * throttle queue.
 *
 * tests/osrm.test.js pins tryOsrm/tryNearest/screeningTableFn's parsing and
 * the loop builders against a single (self-hosted-only) backend, and only
 * incidentally exercises the "does it latch" split. This file is the one
 * that actually distinguishes the two backends and drives the fallback
 * itself: the latch (isSelfHostedDown/resetOsrmFallbackState), when it does
 * and doesn't trip, and the public throttle's pacing.
 *
 * Loading: helpers/load.js's SCRIPT_DEPS already lists osrm's real edges
 * (net, geometry, loop-quality), so loadScripts('osrm') evaluates the
 * production module in this realm, same as osrm.test.js.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse } from './helpers/fetch-stub.js';
import { echoNearest, echoRoute } from './helpers/osrm-fetch.js';

beforeAll(() => {
    loadScripts('osrm');
});

beforeEach(() => {
    globalThis.resetOsrmFallbackState();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// Keyed on which backend BASE the composed URL starts with — every test here
// cares about self-hosted vs. public. osrm.test.js's installOsrmKindFetch keys
// on the endpoint kind (/route, /nearest, /table, /junctions) instead and never
// tells the two backends apart. A backend with no handler throws "unexpected
// self-hosted/public fetch". (`public` is rebound to `pub` only because it is a
// reserved word as a binding name.)
function installOsrmBackendFetch({ selfHosted, public: pub }) {
    const fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.startsWith(globalThis.OSRM_FI_BASE) || u.startsWith(globalThis.OSRM_FI_NEAREST) || u.startsWith(globalThis.OSRM_FI_TABLE)) {
            if (!selfHosted) throw new Error(`unexpected self-hosted fetch: ${u}`);
            return selfHosted(u);
        }
        if (u.startsWith(globalThis.OSRM_PUBLIC_BASE) || u.startsWith(globalThis.OSRM_PUBLIC_NEAREST) || u.startsWith(globalThis.OSRM_PUBLIC_TABLE)) {
            if (!pub) throw new Error(`unexpected public fetch: ${u}`);
            return pub(u);
        }
        throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
}

const START = { lat: 60, lng: 24 };
const C0 = { lat: 60.05, lng: 24.05 };
const ROUTE_SUFFIX = '24,60;24.1,60.1?overview=full&geometries=geojson&steps=true&continue_straight=true';
const VIA = { lat: 60, lng: 24 };
const NEAREST_SUFFIX = `${VIA.lng},${VIA.lat}?number=1`;

// ── tryOsrm: self-hosted healthy / down / recovering ────────────────────────

describe('OSRM public fallback — route', () => {
    test('uses the self-hosted base while healthy', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: (u) => echoRoute(u),
        });
        const out = await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(out).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_FI_BASE}/${ROUTE_SUFFIX}`);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('a self-hosted network failure retries the same request on public', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => { throw new Error('net down'); },
            public: (u) => echoRoute(u),
        });
        const out = await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(out).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_FI_BASE}/${ROUTE_SUFFIX}`);
        expect(String(fetch.mock.calls[1][0])).toBe(`${globalThis.OSRM_PUBLIC_BASE}/${ROUTE_SUFFIX}`);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('a 502 from self-hosted also falls through to public', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({}, { status: 502 }),
            public: (u) => echoRoute(u),
        });
        const out = await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(out).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('a 200 with no routes returns null, does NOT latch, and never asks public', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({ routes: [] }),
        });
        await expect(globalThis.tryOsrm(ROUTE_SUFFIX)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('a 200 with empty route geometry returns null, does NOT latch, and never asks public', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({ routes: [{ geometry: { coordinates: [] }, duration: 1, distance: 1 }] }),
        });
        await expect(globalThis.tryOsrm(ROUTE_SUFFIX)).resolves.toBeNull();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('while latched, self-hosted is not retried at all', async () => {
        // Fake timers: the second call is public-only and has to wait out
        // the first call's PUBLIC_MIN_GAP_MS — advance past that instead of
        // burning real wall-clock time on it.
        vi.useFakeTimers();
        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('net down'); },
            public: (u) => echoRoute(u),
        });
        await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        const fetch = installOsrmBackendFetch({
            public: (u) => echoRoute(u),
        });
        const p2 = globalThis.tryOsrm(ROUTE_SUFFIX);
        await vi.advanceTimersByTimeAsync(globalThis.PUBLIC_MIN_GAP_MS);
        const out = await p2;
        expect(out).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_PUBLIC_BASE}/${ROUTE_SUFFIX}`);
    });

    test('the latch expires so a recovered backend is used again', async () => {
        vi.useFakeTimers();

        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('net down'); },
            public: (u) => echoRoute(u),
        });
        await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        await vi.advanceTimersByTimeAsync(globalThis.SELF_HOSTED_RETRY_MS - 1000);
        expect(globalThis.isSelfHostedDown()).toBe(true); // not yet expired

        await vi.advanceTimersByTimeAsync(1000 + 1);
        expect(globalThis.isSelfHostedDown()).toBe(false); // expired — next call re-probes

        const fetch = installOsrmBackendFetch({
            selfHosted: (u) => echoRoute(u),
        });
        const out = await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(out).toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_FI_BASE}/${ROUTE_SUFFIX}`);
    });

    test('consecutive public requests are at least PUBLIC_MIN_GAP_MS apart', async () => {
        vi.useFakeTimers();
        const timestamps = [];
        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: (u) => { timestamps.push(Date.now()); return echoRoute(u); },
        });

        // First call: trips the latch, then makes the first-ever public
        // request — nothing queued ahead of it, so no wait.
        await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        // Second call: latched already, so it's public-only — but it must
        // wait out the gap since the first public request.
        const p2 = globalThis.tryOsrm(ROUTE_SUFFIX);
        await vi.advanceTimersByTimeAsync(globalThis.PUBLIC_MIN_GAP_MS);
        await p2;

        expect(timestamps).toHaveLength(2);
        expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(globalThis.PUBLIC_MIN_GAP_MS);
    });

    test('resetOsrmFallbackState also clears the throttle — a fresh public call after reset does not wait', async () => {
        vi.useFakeTimers();
        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: (u) => echoRoute(u),
        });
        await globalThis.tryOsrm(ROUTE_SUFFIX); // sets lastPublicRequestAt

        globalThis.resetOsrmFallbackState();
        expect(globalThis.isSelfHostedDown()).toBe(false);

        // Re-latch and issue another public call immediately — if the
        // throttle queue/lastPublicRequestAt survived the reset, this would
        // hang waiting on a fake timer we never advance.
        const fetch = installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: (u) => echoRoute(u),
        });
        await expect(globalThis.tryOsrm(ROUTE_SUFFIX)).resolves.toBeTruthy();
        expect(fetch).toHaveBeenCalledTimes(2); // self-hosted + public, no extra wait needed
    });
});

// ── tryNearest / snapToRoad ──────────────────────────────────────────────────

describe('OSRM public fallback — nearest', () => {
    test('snapToRoad falls back to public nearest', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: (u) => echoNearest(u),
        });
        const out = await globalThis.snapToRoad(VIA, 0.5);
        expect(out).toEqual(VIA); // echoNearest echoes the query point back, well within radius
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_FI_NEAREST}/${NEAREST_SUFFIX}`);
        expect(String(fetch.mock.calls[1][0])).toBe(`${globalThis.OSRM_PUBLIC_NEAREST}/${NEAREST_SUFFIX}`);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('a self-hosted 200 with no waypoints returns null, does NOT latch, and never asks public', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({ waypoints: [] }),
        });
        const out = await globalThis.snapToRoad(VIA, 0.5);
        expect(out).toBe(VIA); // snapToRoad's own null-handling: keep the original via
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.isSelfHostedDown()).toBe(false);
    });

    test('while latched, a nearest call goes straight to public', async () => {
        vi.useFakeTimers();
        installOsrmBackendFetch({
            selfHosted: () => jsonResponse({}, { status: 500 }),
            public: (u) => echoNearest(u),
        });
        await globalThis.tryNearest(NEAREST_SUFFIX);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        const fetch = installOsrmBackendFetch({ public: (u) => echoNearest(u) });
        const p2 = globalThis.tryNearest(NEAREST_SUFFIX);
        await vi.advanceTimersByTimeAsync(globalThis.PUBLIC_MIN_GAP_MS);
        await p2;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_PUBLIC_NEAREST}/${NEAREST_SUFFIX}`);
    });
});

// ── The latch is shared across endpoints ─────────────────────────────────────

describe('the self-hosted-down latch is shared across route/nearest/table', () => {
    test('a route failure also routes a later nearest call straight to public', async () => {
        vi.useFakeTimers();
        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: (u) => echoRoute(u),
        });
        await globalThis.tryOsrm(ROUTE_SUFFIX);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        const fetch = installOsrmBackendFetch({ public: (u) => echoNearest(u) });
        const p2 = globalThis.tryNearest(NEAREST_SUFFIX);
        await vi.advanceTimersByTimeAsync(globalThis.PUBLIC_MIN_GAP_MS);
        await p2;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(`${globalThis.OSRM_PUBLIC_NEAREST}/${NEAREST_SUFFIX}`);
    });
});

// ── screeningTableFn: same fallback, but keeps throwing ─────────────────────

describe('OSRM public fallback — table (screeningTableFn)', () => {
    test('the table helper falls back to public and still throws if both fail', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({}, { status: 503 }),
            public: () => jsonResponse({}, { status: 503 }),
        });
        // screenCandidates (screening.js) has no try/catch around tableFn —
        // the catch is one level up in destination-resolve.js — so this must
        // keep rejecting rather than resolving to a swallowed null/[].
        await expect(globalThis.screeningTableFn(START, [C0]))
            .rejects.toThrow('osrm table http 503');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('the table helper falls back to public and resolves if public succeeds', async () => {
        const fetch = installOsrmBackendFetch({
            selfHosted: () => jsonResponse({}, { status: 500 }),
            public: () => jsonResponse({
                code: 'Ok',
                destinations: [{ distance: 0 }, { distance: 5 }],
                distances: [[0, 20]],
            }),
        });
        await expect(globalThis.screeningTableFn(START, [C0]))
            .resolves.toEqual([{ snapM: 5, routeM: 20 }]);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(globalThis.isSelfHostedDown()).toBe(true);
    });

    test('while latched, the table helper skips self-hosted entirely', async () => {
        vi.useFakeTimers();
        installOsrmBackendFetch({
            selfHosted: () => { throw new Error('down'); },
            public: () => jsonResponse({
                code: 'Ok',
                destinations: [{ distance: 0 }, { distance: 5 }],
                distances: [[0, 20]],
            }),
        });
        await globalThis.screeningTableFn(START, [C0]);
        expect(globalThis.isSelfHostedDown()).toBe(true);

        const fetch = installOsrmBackendFetch({
            public: () => jsonResponse({
                code: 'Ok',
                destinations: [{ distance: 0 }, { distance: 5 }],
                distances: [[0, 20]],
            }),
        });
        const p2 = globalThis.screeningTableFn(START, [C0]);
        await vi.advanceTimersByTimeAsync(globalThis.PUBLIC_MIN_GAP_MS);
        await p2;
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0]).startsWith(globalThis.OSRM_PUBLIC_TABLE)).toBe(true);
    });
});
