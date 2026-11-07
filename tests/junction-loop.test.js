// @vitest-environment node
/**
 * Behavioral tests for loop-builders.js's buildJunctionLoop — both chiralities,
 * the junction snap, both buildLoop fallbacks and avoidBacktracking forwarding —
 * over a fetch stub keyed on the OSRM endpoint kind. corridor-junctions.test.js
 * pins the junctions-cache URL it fetches.
 */
import { describe, test, expect, vi } from 'vitest';
import { jsonResponse } from './helpers/fetch-stub.js';
import { parseRouteWaypoints, echoNearest, echoRoute, installOsrmKindFetch } from './helpers/osrm-fetch.js';
import { installLoopBuilderSuite, START, DEST, SPREAD, routeUrls, LOOP_OPTS } from './helpers/loop-builders-suite.js';

installLoopBuilderSuite();

// ── buildJunctionLoop ────────────────────────────────────────────────────────

describe('buildJunctionLoop', () => {
    const POOL = [{ lat: 60.05, lng: 24.05 }];

    test('Overpass throw → buildLoop with overlap null and junctions null', async () => {
        const fetch = installOsrmKindFetch({
            junctions: () => jsonResponse({}, { status: 503 }),
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

    // With the public fallback, a self-hosted /route failure no longer just
    // returns null — tryOsrm also retries on public within the same call, and
    // the shared self-hosted-down latch then routes buildLoop's own snap +
    // route calls straight to public too. So "both chiralities fail" is now
    // pinned by taking BOTH backends down for /route (self-hosted and public
    // both 500), which also fails buildLoop's fallback attempt — the pool of
    // junctions is still preserved even though no route could be built at all.
    // Uses fake timers because the many resulting public-fallback calls are
    // throttled PUBLIC_MIN_GAP_MS apart, which would otherwise make this test
    // take several real seconds.
    test('both chiralities fail on self-hosted AND public → buildLoop also fails, junction pool still returned', async () => {
        vi.useFakeTimers();
        try {
            installOsrmKindFetch({
                junctions: () => jsonResponse({ junctions: POOL }),
                route: () => jsonResponse({}, { status: 500 }),
            });
            const promise = globalThis.buildJunctionLoop(
                START.lat, START.lng, DEST.lat, DEST.lng, LOOP_OPTS(),
            );
            await vi.advanceTimersByTimeAsync(30000);
            const out = await promise;
            expect(out.overlap).toBeNull();
            expect(out.junctions).toBe(POOL);
            expect(out.outbound).toBeNull();
            expect(out.return).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    test('cachedJunctions skips Overpass and returns a picked chirality', async () => {
        const fetch = installOsrmKindFetch();
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
        const fetch = installOsrmKindFetch({
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
        installOsrmKindFetch({
            junctions: () => jsonResponse({ junctions: POOL }),
        });
        await globalThis.buildJunctionLoop(
            START.lat, START.lng, DEST.lat, DEST.lng,
            { maxKm: 7, onProgress, spread: SPREAD() },
        );
        expect(onProgress.mock.calls.filter(([msg]) => msg === 'Searching for junctions…')).toHaveLength(1);
        expect(onProgress).toHaveBeenCalledWith('Building both chiralities…');
    });

    // buildJunctionLoop shapes the loop at three sites — its own loopVias call
    // and both buildLoop fallbacks. A flag dropped at any one of them hands the
    // user the legacy geometry the toggle exists to replace, so each is pinned
    // by the vias that reach OSRM.
    describe('avoidBacktracking', () => {
        const WIDE = () => globalThis.loopVias(
            START.lat, START.lng, DEST.lat, DEST.lng, SPREAD(), { avoidBacktracking: true },
        );
        const OPTS = () => ({ ...LOOP_OPTS(), avoidBacktracking: true });
        const routed = (fetch) => routeUrls(fetch).map(parseRouteWaypoints);

        test('the junction path starts from the widened vias', async () => {
            // An empty pool snaps nothing, so each via reaches /route as loopVias made it.
            const { A, B, rightVias, leftVias } = WIDE();
            const fetch = installOsrmKindFetch();
            await globalThis.buildJunctionLoop(
                START.lat, START.lng, DEST.lat, DEST.lng, { ...OPTS(), cachedJunctions: [] },
            );
            expect(routed(fetch)).toContainEqual([A, ...rightVias, B]);
            expect(routed(fetch)).toContainEqual([B, ...leftVias.slice().reverse(), A]);
        });

        test('the Overpass-failure fallback builds the widened loop', async () => {
            const { A, B, rightVias, leftVias } = WIDE();
            const fetch = installOsrmKindFetch({
                junctions: () => jsonResponse({}, { status: 503 }),
            });
            const out = await globalThis.buildJunctionLoop(
                START.lat, START.lng, DEST.lat, DEST.lng, OPTS(),
            );
            expect(out.junctions).toBeNull();
            // echoNearest snaps every via onto itself.
            expect(routed(fetch)).toEqual([
                [A, ...rightVias, B],
                [B, ...leftVias.slice().reverse(), A],
            ]);
        });

        test('the both-chiralities-failed fallback builds the widened loop', async () => {
            // osrm-routed answers "no path" with HTTP 400 { code: 'NoRoute' }.
            // That is the engine, not an outage: it must fail the chirality
            // without latching, so the fallback's own calls stay on the
            // stubbed self-hosted backend.
            const { A, B, rightVias, leftVias } = WIDE();
            let routeCalls = 0;
            const fetch = installOsrmKindFetch({
                route: (url) => (++routeCalls <= 4
                    ? jsonResponse({ code: 'NoRoute', routes: [] }, { status: 400 })
                    : echoRoute(url)),
            });
            const out = await globalThis.buildJunctionLoop(
                START.lat, START.lng, DEST.lat, DEST.lng, { ...OPTS(), cachedJunctions: [] },
            );
            expect(out.overlap).toBeNull();
            expect(out.outbound).toBeTruthy();
            expect(globalThis.isSelfHostedDown()).toBe(false);
            expect(routed(fetch).slice(4)).toEqual([
                [A, ...rightVias, B],
                [B, ...leftVias.slice().reverse(), A],
            ]);
        });
    });
});
