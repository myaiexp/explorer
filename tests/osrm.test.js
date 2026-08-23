// @vitest-environment node
/**
 * Behavioral tests for osrm.js's routing builders (audit #7063).
 *
 * loop-vias.test.js pins envelope geometry; corridor-junctions.test.js pins the
 * junctions-cache URL. Everything the smart round-trip actually walks —
 * tryOsrm, snapToRoad, screeningTableFn, snapToJunction, pickBetterLoop,
 * buildLoop, buildJunctionLoop, buildOneWay — is fetch-stubbed here.
 *
 * Loading: helpers/load.js's SCRIPT_DEPS already lists osrm's real edges
 * (net, geometry, loop-quality), so loadScripts('osrm') evaluates the
 * production module in this realm. fetchWithTimeout is the real one; it
 * calls the per-test `fetch` stub and clears its abort timer on resolve.
 */
import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('osrm');
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
});

const START = { lat: 60, lng: 24 };
const DEST = { lat: 60.1, lng: 24.1 };
const SPREAD = () => globalThis.computeSpreadParams(50);

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function routeBody(coordsLngLat, { duration = 60, distance = 1000, legs } = {}) {
    return {
        routes: [{
            geometry: { coordinates: coordsLngLat },
            duration,
            distance,
            legs,
        }],
    };
}

function coordPath(url) {
    return String(url).split('/foot/')[1].split('?')[0];
}

function parseRouteWaypoints(url) {
    return coordPath(url).split(';').map((pair) => {
        const [lng, lat] = pair.split(',').map(Number);
        return { lat, lng };
    });
}

function echoNearest(url) {
    const [lng, lat] = coordPath(url).split(',').map(Number);
    return jsonResponse({ waypoints: [{ location: [lng, lat] }] });
}

function echoRoute(url) {
    const wps = parseRouteWaypoints(url);
    return jsonResponse(routeBody(wps.map((p) => [p.lng, p.lat])));
}

function installFetch(overrides = {}) {
    const handlers = {
        table: () => jsonResponse({ code: 'Ok', destinations: [{ distance: 0 }], distances: [[0]] }),
        nearest: echoNearest,
        route: echoRoute,
        junctions: () => jsonResponse({ junctions: [] }),
        ...overrides,
    };
    const fetch = vi.fn(async (url) => {
        const u = String(url);
        const kind = u.includes('/table/') ? 'table'
            : u.includes('/nearest/') ? 'nearest'
            : u.includes('/route/') ? 'route'
            : u.includes('/junctions') ? 'junctions'
            : null;
        if (!kind) throw new Error(`unexpected fetch: ${u}`);
        return handlers[kind](u);
    });
    globalThis.fetch = fetch;
    return fetch;
}

function routeUrls(fetchMock) {
    return fetchMock.mock.calls
        .map(([url]) => String(url))
        .filter((u) => u.includes('/route/'));
}

const LOOP_OPTS = () => ({
    maxKm: 7,
    onProgress: vi.fn(),
    spread: SPREAD(),
});

// ── tryOsrm ──────────────────────────────────────────────────────────────────

describe('tryOsrm', () => {
    const url = 'https://mase.fi/api/osrm-fi/route/v1/foot/24,60;24.1,60.1';

    test('maps geojson [lng,lat] → [lat,lng] and flattens leg steps', async () => {
        installFetch({
            route: () => jsonResponse(routeBody(
                [[24, 60], [24.1, 60.1]],
                { duration: 42, distance: 900, legs: [{ steps: [{ name: 'a' }] }, { steps: [{ name: 'b' }] }] },
            )),
        });
        await expect(globalThis.tryOsrm(url)).resolves.toEqual({
            coords: [[60, 24], [60.1, 24.1]],
            duration: 42,
            distance: 900,
            steps: [{ name: 'a' }, { name: 'b' }],
        });
    });

    test('returns null when fetch throws', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('net'); });
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null on a non-ok response', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({}, { ok: false, status: 500 }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null when json() throws', async () => {
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => { throw new Error('bad json'); },
        }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null when routes is missing or empty', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({}));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
        globalThis.fetch = vi.fn(async () => jsonResponse({ routes: [] }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null on a 200 whose route has no geometry (finding #7785)', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({
            routes: [{ duration: 1, distance: 1 }],
        }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null when geometry.coordinates is not an array', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({
            routes: [{ duration: 1, distance: 1, geometry: { coordinates: null } }],
        }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });

    test('returns null when geometry.coordinates is an empty array (finding #7926)', async () => {
        globalThis.fetch = vi.fn(async () => jsonResponse({
            routes: [{ duration: 1, distance: 1, geometry: { coordinates: [] } }],
        }));
        await expect(globalThis.tryOsrm(url)).resolves.toBeNull();
    });
});

// ── snapToRoad ───────────────────────────────────────────────────────────────

describe('snapToRoad', () => {
    const via = { lat: 60, lng: 24 };

    test('returns the snapped point when nearest is within snapRadius', async () => {
        // ~11 m north — well inside the 0.5 km default.
        installFetch({
            nearest: () => jsonResponse({ waypoints: [{ location: [24, 60.0001] }] }),
        });
        await expect(globalThis.snapToRoad(via, 0.5)).resolves.toEqual({ lat: 60.0001, lng: 24 });
    });

    test('keeps the original via when nearest is missing', async () => {
        installFetch({
            nearest: () => jsonResponse({ waypoints: [] }),
        });
        const out = await globalThis.snapToRoad(via, 0.5);
        expect(out).toBe(via);
    });

    test('keeps the original via when nearest is beyond snapRadius', async () => {
        // 60,24 → 60.1,24.1 is ~13 km.
        installFetch({
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
        const fetch = installFetch({
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
        const fetch = installFetch();
        await expect(globalThis.screeningTableFn(START, [])).resolves.toEqual([]);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('throws on a non-ok HTTP response', async () => {
        installFetch({
            table: () => jsonResponse({}, { ok: false, status: 503 }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table http 503');
    });

    test('throws when OSRM code is not Ok', async () => {
        installFetch({
            table: () => jsonResponse({ code: 'NoRoute' }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table NoRoute');
    });

    test('throws when destinations or distances[0] is not an array', async () => {
        installFetch({
            table: () => jsonResponse({ code: 'Ok', destinations: { distance: 1 }, distances: [[0, 1]] }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table malformed');

        installFetch({
            table: () => jsonResponse({ code: 'Ok', destinations: [{ distance: 0 }], distances: null }),
        });
        await expect(globalThis.screeningTableFn(START, [c0]))
            .rejects.toThrow('osrm table malformed');
    });

    test('null-fills snapM / routeM when the i+1 slot is missing or non-numeric', async () => {
        installFetch({
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

// ── snapToJunction ───────────────────────────────────────────────────────────

describe('snapToJunction', () => {
    const via = { lat: 60, lng: 24 };

    test('returns the original via when the pool is empty or missing', () => {
        expect(globalThis.snapToJunction(via, [], 1)).toBe(via);
        expect(globalThis.snapToJunction(via, null, 1)).toBe(via);
    });

    test('returns the original via when the closest junction is out of range', () => {
        const pool = [{ lat: 60.1, lng: 24.1 }]; // ~13 km
        expect(globalThis.snapToJunction(via, pool, 0.5)).toBe(via);
    });

    test('returns the closest in-range junction', () => {
        const near = { lat: 60.0001, lng: 24, id: 'near' };
        const far = { lat: 60.01, lng: 24, id: 'far' };
        expect(globalThis.snapToJunction(via, [far, near], 0.5)).toBe(near);
    });
});

// ── pickBetterLoop ───────────────────────────────────────────────────────────

describe('pickBetterLoop', () => {
    const shared = { coords: [[60, 24], [60.001, 24.001]], duration: 1, distance: 10 };
    const far = { coords: [[70, 30], [70.001, 30.001]], duration: 1, distance: 10 };

    test('both ok → lower-overlap chirality (ties break toward A)', () => {
        // A shares its legs (overlap 1); B's return is far from its outbound (overlap 0).
        const picked = globalThis.pickBetterLoop(shared, shared, shared, far);
        expect(picked.outbound).toBe(shared);
        expect(picked.return).toBe(far);
        expect(picked.overlap).toBe(0);
    });

    test('only A ok → A, even if B has a leftover leg', () => {
        const picked = globalThis.pickBetterLoop(shared, shared, shared, null);
        expect(picked.outbound).toBe(shared);
        expect(picked.return).toBe(shared);
        expect(picked.overlap).toBe(1);
    });

    test('only B ok → B', () => {
        const picked = globalThis.pickBetterLoop(null, null, shared, far);
        expect(picked.outbound).toBe(shared);
        expect(picked.return).toBe(far);
        expect(picked.overlap).toBe(0);
    });

    test('neither fully ok → null outbound/return/overlap', () => {
        expect(globalThis.pickBetterLoop(shared, null, null, far)).toEqual({
            outbound: null, return: null, overlap: null,
        });
        expect(globalThis.pickBetterLoop(null, null, null, null)).toEqual({
            outbound: null, return: null, overlap: null,
        });
    });
});

// ── buildOneWay ──────────────────────────────────────────────────────────────

describe('buildOneWay', () => {
    test('routes A→B with the documented /route query', async () => {
        const fetch = installFetch();
        const out = await globalThis.buildOneWay(START.lat, START.lng, DEST.lat, DEST.lng);
        expect(fetch).toHaveBeenCalledTimes(1);
        const url = String(fetch.mock.calls[0][0]);
        expect(url.startsWith(`${globalThis.OSRM_FI_BASE}/`)).toBe(true);
        expect(parseRouteWaypoints(url)).toEqual([START, DEST]);
        expect(url).toContain('overview=full');
        expect(url).toContain('geometries=geojson');
        expect(url).toContain('steps=true');
        expect(url).toContain('continue_straight=true');
        expect(out.coords[0]).toEqual([START.lat, START.lng]);
        expect(out.coords.at(-1)).toEqual([DEST.lat, DEST.lng]);
        expect(out.duration).toBe(60);
        expect(out.distance).toBe(1000);
    });
});

// ── buildLoop ────────────────────────────────────────────────────────────────

describe('buildLoop', () => {
    test('keeps envelope vias in the /route URL when nearest is beyond snapRadius', async () => {
        const spread = SPREAD();
        const { rightVias, leftVias, A, B } = globalThis.loopVias(
            START.lat, START.lng, DEST.lat, DEST.lng, spread,
        );
        const fetch = installFetch({
            nearest: () => jsonResponse({ waypoints: [{ location: [30, 70] }] }),
        });
        const loop = await globalThis.buildLoop(START.lat, START.lng, DEST.lat, DEST.lng, spread);
        expect(loop.outbound).toBeTruthy();
        expect(loop.return).toBeTruthy();

        const urls = routeUrls(fetch);
        expect(urls).toHaveLength(2);
        expect(parseRouteWaypoints(urls[0])).toEqual([A, ...rightVias, B]);
        expect(parseRouteWaypoints(urls[1])).toEqual([B, ...leftVias.slice().reverse(), A]);
        expect(urls.join('')).not.toContain('30,70');
    });
});

// ── buildJunctionLoop ────────────────────────────────────────────────────────

describe('buildJunctionLoop', () => {
    const POOL = [{ lat: 60.05, lng: 24.05 }];

    test('Overpass throw → buildLoop with overlap null and junctions null', async () => {
        const fetch = installFetch({
            junctions: () => jsonResponse({}, { ok: false, status: 503 }),
        });
        const out = await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng, LOOP_OPTS(),
        );
        expect(out.overlap).toBeNull();
        expect(out.junctions).toBeNull();
        expect(out.outbound).toBeTruthy();
        expect(out.return).toBeTruthy();
        // Fallback is envelope-snap: nearest was called, junctions was not reused.
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/nearest/'))).toBe(true);
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/junctions'))).toBe(true);
    });

    test('both chiralities fail → buildLoop, still returning the junction pool', async () => {
        let routeCalls = 0;
        installFetch({
            junctions: () => jsonResponse({ junctions: POOL }),
            route: (url) => {
                routeCalls += 1;
                // Four chirality legs fail; the two envelope-snap legs after that succeed.
                if (routeCalls <= 4) return jsonResponse({}, { ok: false, status: 500 });
                return echoRoute(url);
            },
        });
        const out = await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng, LOOP_OPTS(),
        );
        expect(out.overlap).toBeNull();
        expect(out.junctions).toBe(POOL);
        expect(out.outbound).toBeTruthy();
        expect(out.return).toBeTruthy();
        expect(routeCalls).toBe(6);
    });

    test('cachedJunctions skips Overpass and returns a picked chirality', async () => {
        const fetch = installFetch();
        const out = await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng,
            { ...LOOP_OPTS(), cachedJunctions: POOL },
        );
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/junctions'))).toBe(false);
        expect(out.junctions).toBe(POOL);
        expect(out.outbound).toBeTruthy();
        expect(out.return).toBeTruthy();
        expect(typeof out.overlap).toBe('number');
        expect(routeUrls(fetch)).toHaveLength(4);
    });

    test('omitting onProgress still uses the junction path, not the Overpass fallback', async () => {
        const fetch = installFetch({
            junctions: () => jsonResponse({ junctions: POOL }),
        });
        const out = await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng,
            { maxKm: 7, spread: SPREAD() },
        );
        // A TypeError from an unguarded onProgress used to land in the Overpass
        // catch and silently degrade to envelope-snap (nearest). Junction path
        // never calls nearest.
        expect(out.junctions).toBe(POOL);
        expect(typeof out.overlap).toBe('number');
        expect(fetch.mock.calls.some(([url]) => String(url).includes('/nearest/'))).toBe(false);
    });

    test("emits 'Searching for junctions…' once, from the fetch, not also from the builder", async () => {
        const onProgress = vi.fn();
        installFetch({
            junctions: () => jsonResponse({ junctions: POOL }),
        });
        await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng,
            { maxKm: 7, onProgress, spread: SPREAD() },
        );
        expect(onProgress.mock.calls.filter(([msg]) => msg === 'Searching for junctions…')).toHaveLength(1);
        expect(onProgress).toHaveBeenCalledWith('Building both chiralities…');
    });
});
