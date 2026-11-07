// @vitest-environment node
/**
 * Behavioral tests for loop-builders.js — snapToJunction, pickBetterLoop,
 * buildOneWay and buildLoop — over a fetch stub keyed on the OSRM endpoint
 * kind. buildJunctionLoop is in junction-loop.test.js; loop-vias.test.js pins
 * the envelope geometry these builders route through.
 */
import { describe, test, expect } from 'vitest';
import { jsonResponse } from './helpers/fetch-stub.js';
import { parseRouteWaypoints, installOsrmKindFetch } from './helpers/osrm-fetch.js';
import { installLoopBuilderSuite, START, DEST, SPREAD, routeUrls } from './helpers/loop-builders-suite.js';

installLoopBuilderSuite();

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
        const fetch = installOsrmKindFetch();
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
        const fetch = installOsrmKindFetch({
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

    test('a non-degraded buildLoop still snaps its vias', async () => {
        const spread = SPREAD();
        const fetch = installOsrmKindFetch();
        await globalThis.buildLoop(START.lat, START.lng, DEST.lat, DEST.lng, spread);
        const nearestCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/nearest/'));
        expect(nearestCalls).toHaveLength(6);
    });

    test('a degraded buildLoop issues no nearest calls', async () => {
        const spread = SPREAD();
        const { rightVias, leftVias, A, B } = globalThis.loopVias(
            START.lat, START.lng, DEST.lat, DEST.lng, spread,
        );
        const fetch = installOsrmKindFetch();
        const loop = await globalThis.buildLoop(
            START.lat, START.lng, DEST.lat, DEST.lng, spread, { degraded: true },
        );
        expect(loop.outbound).toBeTruthy();
        expect(loop.return).toBeTruthy();

        const nearestCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/nearest/'));
        expect(nearestCalls).toHaveLength(0);

        const urls = routeUrls(fetch);
        expect(urls).toHaveLength(2);
        expect(parseRouteWaypoints(urls[0])).toEqual([A, ...rightVias, B]);
        expect(parseRouteWaypoints(urls[1])).toEqual([B, ...leftVias.slice().reverse(), A]);
    });

    test('a degraded round trip issues exactly 2 route calls total', async () => {
        const spread = SPREAD();
        const fetch = installOsrmKindFetch();
        await globalThis.buildLoop(START.lat, START.lng, DEST.lat, DEST.lng, spread, { degraded: true });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // Asserted on the vias the builder actually routes through: that is what a
    // dropped flag changes for the walker.
    // Degraded skips the snap, so the envelope vias reach /route verbatim.
    test('avoidBacktracking routes through the widened envelope, not the legacy one', async () => {
        const spread = SPREAD();
        const wide = globalThis.loopVias(
            START.lat, START.lng, DEST.lat, DEST.lng, spread, { avoidBacktracking: true },
        );
        const legacy = globalThis.loopVias(START.lat, START.lng, DEST.lat, DEST.lng, spread);
        expect(wide.rightVias).not.toEqual(legacy.rightVias); // precondition
        const fetch = installOsrmKindFetch();
        await globalThis.buildLoop(
            START.lat, START.lng, DEST.lat, DEST.lng, spread, { degraded: true, avoidBacktracking: true },
        );

        const urls = routeUrls(fetch);
        expect(parseRouteWaypoints(urls[0])).toEqual([wide.A, ...wide.rightVias, wide.B]);
        expect(parseRouteWaypoints(urls[1])).toEqual([wide.B, ...wide.leftVias.slice().reverse(), wide.A]);
    });
});
