// @vitest-environment node
/**
 * Tests for destination-resolve.js — the destination-resolution pipeline
 * (resolveCandidatePool / screenCandidatePool / isBetterLoop / findBestLoop /
 * buildRouteForDestination).
 *
 * Loading: destination-resolve.js is a non-module browser script, loaded via
 * helpers/load.js's loadScripts('destination-resolve'); its explicit
 * globalThis assignments expose the pipeline functions. Every cross-file
 * dependency (rankByNovelty, generateRandomPointAnnulus, capPool,
 * screenCandidates, screeningTableFn, fetchRoadsInRadius, fetchPOIsInRadius,
 * buildJunctionLoop, buildRouteForMode, loopScore, OVERLAP_BAD_THRESHOLD, POI_TYPES) is
 * resolved from globalThis at call time — exactly as in the browser — so each
 * test installs fakes on globalThis instead of pulling in real sources (no
 * SCRIPT_DEPS entry for this module). rankByNovelty is faked as identity,
 * making pickMostNovelDestination return the pool's first element
 * deterministically.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    // loop-quality is loaded for REAL, not faked: findBestLoop ranks candidates
    // with its loopScore, so a stub would rank nothing and the ranking tests
    // below would pass against a fiction. It is pure (no DOM, no network) and
    // supplies OVERLAP_BAD_THRESHOLD too — beforeEach re-pins that to the same
    // 0.4 so the threshold a test reasons about stays visible in the test file.
    loadScripts('loop-quality', 'destination-resolve');
});

// POI catalog fake — two keys so poi vs any_poi key/label logic is exercised.
// The `filter` values are kept deliberately: the catalog still carries them (to
// describe the dropdown), and the assertions below prove they are NOT what
// reaches fetchPOIsInRadius. The service takes catalog keys only.
const POI_TYPES = [
    { label: 'park', key: 'park', filter: '["leisure"="park"]' },
    { label: 'cafe', key: 'cafe', filter: '["amenity"="cafe"]' },
];

beforeEach(() => {
    // Identity ranking → pickMostNovelDestination returns pool[0], findBestLoop
    // iterates the pool in order.
    globalThis.rankByNovelty = vi.fn((arr) => arr);
    globalThis.generateRandomPointAnnulus = vi.fn(() => ({ lat: 60, lng: 24, random: true }));
    globalThis.capPool = vi.fn((arr) => arr);
    globalThis.screenCandidates = vi.fn();
    globalThis.screeningTableFn = vi.fn();
    globalThis.fetchRoadsInRadius = vi.fn();
    globalThis.fetchPOIsInRadius = vi.fn();
    globalThis.buildJunctionLoop = vi.fn();
    globalThis.buildRouteForMode = vi.fn();
    globalThis.OVERLAP_BAD_THRESHOLD = 0.4;
    globalThis.POI_TYPES = POI_TYPES;
});

// ── resolveCandidatePool ──────────────────────────────────────────────────────

describe('resolveCandidatePool', () => {
    const base = { straightMin: 0.5, straightMax: 2, existingDests: [] };

    test('roads: fetch throws → random fallback with "Overpass unavailable" message', async () => {
        globalThis.fetchRoadsInRadius.mockRejectedValue(new Error('overpass 500'));
        const onProgress = vi.fn();
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'roads', onProgress, winterMode: false });
        expect(onProgress).toHaveBeenCalledWith('Overpass unavailable, using random point…');
        expect(r.destName).toBeNull();
        expect(r.candidatePool).toHaveLength(15);      // RANDOM_POOL_SIZE
        expect(r.dest).toEqual({ lat: 60, lng: 24, random: true });
    });

    test('roads: empty result → random fallback with "No roads found" message', async () => {
        globalThis.fetchRoadsInRadius.mockResolvedValue([]);
        const onProgress = vi.fn();
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'roads', onProgress, winterMode: false });
        expect(onProgress).toHaveBeenCalledWith('No roads found nearby, using random point…');
        expect(r.candidatePool).toHaveLength(15);
    });

    test('roads: success → capPool result, novelty pick, destName null; winterMode forwarded', async () => {
        const roads = [{ lat: 60.1, lng: 24.1 }, { lat: 60.2, lng: 24.2 }];
        globalThis.fetchRoadsInRadius.mockResolvedValue(roads);
        const onProgress = vi.fn();
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'roads', onProgress, winterMode: true });
        // winterMode threads through to the overpass fetcher (was a DOM read before)
        expect(globalThis.fetchRoadsInRadius).toHaveBeenCalledWith(60, 24, 0.5, 2, onProgress, true);
        expect(r.candidatePool).toBe(roads);
        expect(r.dest).toBe(roads[0]);
        expect(r.destName).toBeNull();
    });

    test('poi: success → dest.name becomes destName; the catalog KEY is sent, not its filter', async () => {
        const pois = [{ lat: 60.1, lng: 24.1, name: 'Central Park' }];
        globalThis.fetchPOIsInRadius.mockResolvedValue(pois);
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'poi', rawLocationType: 'park', onProgress: vi.fn() });
        // The bare key, not an array and never the Overpass filter string —
        // overpass.js wraps a scalar key, and the service resolves keys through
        // its own catalog so a client cannot inject a query.
        expect(globalThis.fetchPOIsInRadius).toHaveBeenCalledWith(60, 24, 0.5, 2, 'park', expect.any(Function));
        expect(globalThis.fetchPOIsInRadius.mock.calls[0][4]).not.toContain('leisure');
        expect(r.dest).toBe(pois[0]);
        expect(r.destName).toBe('Central Park');
    });

    test('poi: fetch throws → random fallback', async () => {
        globalThis.fetchPOIsInRadius.mockRejectedValue(new Error('boom'));
        const onProgress = vi.fn();
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'poi', rawLocationType: 'park', onProgress });
        expect(onProgress).toHaveBeenCalledWith('Overpass unavailable, using random point…');
        expect(r.candidatePool).toHaveLength(15);
    });

    test('poi: empty result → "No matching places found" message', async () => {
        globalThis.fetchPOIsInRadius.mockResolvedValue([]);
        const onProgress = vi.fn();
        await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'poi', rawLocationType: 'park', onProgress });
        expect(onProgress).toHaveBeenCalledWith('No matching places found nearby, using random point…');
    });

    // Stale settings restore a poiType with no matching <option>, so the select
    // value is '' (or a retired key). That must not reach the pool endpoint as
    // an empty or unknown selection — the service 400s on both, and the user
    // would see "Overpass unavailable" for what is really a bad dropdown.
    test.each(['', 'stale_key'])('poi: unknown type %j → random fallback, no pool fetch', async (raw) => {
        globalThis.fetchPOIsInRadius.mockResolvedValue([]);
        const onProgress = vi.fn();
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'poi', rawLocationType: raw, onProgress });
        expect(globalThis.fetchPOIsInRadius).not.toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalledWith('Unknown place type, using random point…');
        expect(onProgress).not.toHaveBeenCalledWith('Overpass unavailable, using random point…');
        expect(r.candidatePool).toHaveLength(15);
        expect(r.destName).toBeNull();
    });

    test('any_poi: the "all" selector is sent, not an expanded catalog, label "any POI"', async () => {
        globalThis.fetchPOIsInRadius.mockResolvedValue([{ lat: 60.1, lng: 24.1, name: 'X' }]);
        const onProgress = vi.fn();
        await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'any_poi', onProgress });
        expect(onProgress).toHaveBeenCalledWith('Searching for any POI…');
        // 'all' says the same thing as every key in the catalog, in one token,
        // and cannot drift when the two catalogs differ by an entry.
        expect(globalThis.fetchPOIsInRadius).toHaveBeenCalledWith(
            60, 24, 0.5, 2, 'all', expect.any(Function));
    });

    test('any: straight random pool, no Overpass fetch', async () => {
        const r = await globalThis.resolveCandidatePool(60, 24, {
            ...base, routingStrategy: 'any', onProgress: vi.fn() });
        expect(globalThis.fetchRoadsInRadius).not.toHaveBeenCalled();
        expect(globalThis.fetchPOIsInRadius).not.toHaveBeenCalled();
        expect(r.candidatePool).toHaveLength(15);
        expect(r.destName).toBeNull();
    });
});

// ── screenCandidatePool ───────────────────────────────────────────────────────

describe('screenCandidatePool', () => {
    const pool = [{ lat: 60.1, lng: 24.1 }, { lat: 60.2, lng: 24.2 }];

    test('survivors → pool replaced, fresh novelty pick, waterLocked false', async () => {
        const survivors = [{ lat: 60.3, lng: 24.3, name: 'Reachable' }];
        globalThis.screenCandidates.mockResolvedValue({ survivors, bestRejected: null });
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.candidatePool).toBe(survivors);
        expect(r.dest).toBe(survivors[0]);
        expect(r.destName).toBe('Reachable');
        expect(r.waterLocked).toBe(false);
    });

    test('no survivors but bestRejected → waterLocked true, pool is [bestRejected]', async () => {
        const bestRejected = { lat: 60.9, lng: 24.9, name: 'Far' };
        globalThis.screenCandidates.mockResolvedValue({ survivors: [], bestRejected });
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.waterLocked).toBe(true);
        expect(r.candidatePool).toEqual([bestRejected]);
        expect(r.dest).toBe(bestRejected);
        expect(r.destName).toBe('Far');
    });

    test('unnamed survivor does not inherit the previous destName', async () => {
        const survivors = [{ lat: 60.3, lng: 24.3 }];
        globalThis.screenCandidates.mockResolvedValue({ survivors, bestRejected: null });
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.dest).toBe(survivors[0]);
        expect(r.destName).toBeNull();
        expect(r.waterLocked).toBe(false);
    });

    test('unnamed bestRejected does not inherit the previous destName', async () => {
        globalThis.screenCandidates.mockResolvedValue({ survivors: [], bestRejected: { lat: 60.9, lng: 24.9 } });
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.destName).toBeNull();
        expect(r.waterLocked).toBe(true);
    });

    test('screening throws → unscreened pool/dest/destName pass through, waterLocked false, warns', async () => {
        globalThis.screenCandidates.mockRejectedValue(new Error('table 500'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[1], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.candidatePool).toBe(pool);
        expect(r.dest).toBe(pool[1]);
        expect(r.destName).toBe('orig');
        expect(r.waterLocked).toBe(false);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
    });

    test('no survivors and no bestRejected → passes through unchanged', async () => {
        globalThis.screenCandidates.mockResolvedValue({ survivors: [], bestRejected: null });
        const r = await globalThis.screenCandidatePool(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'orig', existingDests: [], onProgress: vi.fn() });
        expect(r.candidatePool).toBe(pool);
        expect(r.dest).toBe(pool[0]);
        expect(r.waterLocked).toBe(false);
    });
});

// ── isBetterLoop ──────────────────────────────────────────────────────────────

// Usable loop shape — both legs required before ranking (finding #6220).
function usable(overlap) {
    return { outbound: { coords: ['o'] }, return: { coords: ['r'] }, overlap };
}
function unusable(overlap = null) {
    return { outbound: null, return: null, overlap };
}

describe('isBetterLoop null-overlap ordering', () => {
    test('missing legs never rank, even with no incumbent', () => {
        expect(globalThis.isBetterLoop(unusable(null), null)).toBe(false);
        expect(globalThis.isBetterLoop({ outbound: { c: 1 }, return: null, overlap: 0.1 }, null)).toBe(false);
        expect(globalThis.isBetterLoop({ outbound: null, return: { c: 1 }, overlap: 0.1 }, null)).toBe(false);
    });
    test('no incumbent → usable candidate is better', () => {
        expect(globalThis.isBetterLoop(usable(null), null)).toBe(true);
        expect(globalThis.isBetterLoop(usable(0.9), null)).toBe(true);
    });
    test('candidate with null overlap never displaces a usable incumbent', () => {
        expect(globalThis.isBetterLoop(usable(null), usable(0.9))).toBe(false);
        expect(globalThis.isBetterLoop(usable(null), usable(null))).toBe(false);
    });
    test('a measured overlap beats a null (unknown) incumbent (both usable)', () => {
        expect(globalThis.isBetterLoop(usable(0.9), usable(null))).toBe(true);
    });
    test('two measured overlaps → strictly lower wins, ties keep incumbent', () => {
        expect(globalThis.isBetterLoop(usable(0.2), usable(0.5))).toBe(true);
        expect(globalThis.isBetterLoop(usable(0.5), usable(0.2))).toBe(false);
        expect(globalThis.isBetterLoop(usable(0.3), usable(0.3))).toBe(false);
    });
});

// ── findBestLoop ──────────────────────────────────────────────────────────────

describe('findBestLoop', () => {
    // Return a loop with the given overlap; junctions default to a fresh pool.
    function loop(overlap, junctions = [{ j: 1 }]) {
        return { outbound: { coords: ['o'] }, return: { coords: ['r'] }, overlap, junctions };
    }
    const opts = (candidatePool) => ({
        candidatePool, dest: candidatePool[0], existingDests: [],
        maxKm: 5, winterMode: false, spread: { offsetMult: 0.2, viaTs: [] }, onProgress: vi.fn(),
    });

    test('early-exit: first sub-threshold overlap stops the retry loop', async () => {
        const pool = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }, { lat: 3, lng: 3 }];
        globalThis.buildJunctionLoop.mockResolvedValue(loop(0.1));   // 0.1 < 0.4
        const best = await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(1);
        expect(best.overlap).toBe(0.1);
        expect(best.dest).toBe(pool[0]);
    });

    test('retries past bad overlaps and keeps the lowest, exiting once below threshold', async () => {
        const pool = [{ lat: 1, lng: 1, name: 'a' }, { lat: 2, lng: 2, name: 'b' }, { lat: 3, lng: 3, name: 'c' }];
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce(loop(0.5))   // bad → continue
            .mockResolvedValueOnce(loop(0.3))   // 0.3 < 0.4 → keep + break
            .mockResolvedValueOnce(loop(0.1));  // never reached
        const best = await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
        expect(best.overlap).toBe(0.3);
        expect(best.dest).toBe(pool[1]);
        expect(best.destName).toBe('b');
    });

    test('each retry fetches its own corridor — cachedJunctions stays null', async () => {
        // The pool from attempt 1 is corridor-filtered to dest1. dest2 sits in
        // a different direction; reusing dest1's junctions would silently skip
        // snapping on retries. The start-anchored service cache still hits.
        const pool = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce(loop(0.5, [{ j: 'dest1' }]))
            .mockResolvedValueOnce(loop(0.5, [{ j: 'dest2' }]));
        await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
        expect(globalThis.buildJunctionLoop.mock.calls[0][2]).toBe(1);
        expect(globalThis.buildJunctionLoop.mock.calls[1][2]).toBe(2);
        expect(globalThis.buildJunctionLoop.mock.calls[0][4].cachedJunctions).toBeNull();
        expect(globalThis.buildJunctionLoop.mock.calls[1][4].cachedJunctions).toBeNull();
    });

    test('a measured overlap is preferred over an earlier null (unknown) overlap', async () => {
        const pool = [{ lat: 1, lng: 1, name: 'null-loop' }, { lat: 2, lng: 2, name: 'real-loop' }];
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce(loop(null))   // unknown overlap → does not early-exit
            .mockResolvedValueOnce(loop(0.5));   // measured, still > threshold → no break, budget ends
        const best = await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
        expect(best.overlap).toBe(0.5);
        expect(best.dest).toBe(pool[1]);
    });

    test('all attempts return null legs → null (nothing usable built)', async () => {
        const pool = [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }];
        globalThis.buildJunctionLoop.mockResolvedValue({
            outbound: null, return: null, overlap: null, junctions: [],
        });
        const best = await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
        expect(best).toBeNull();
    });

    test('fail then buildLoop success (null overlap) → second dest wins', async () => {
        // Total OSRM failure must not stick as bestSeen and block a later usable
        // null-overlap loop (buildJunctionLoop's buildLoop fallback).
        const pool = [{ lat: 1, lng: 1, name: 'fail' }, { lat: 2, lng: 2, name: 'ok' }];
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce({ outbound: null, return: null, overlap: null, junctions: [] })
            .mockResolvedValueOnce(loop(null));
        const best = await globalThis.findBestLoop(60, 24, opts(pool));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
        expect(best.dest).toBe(pool[1]);
        expect(best.destName).toBe('ok');
        expect(best.outbound).toEqual({ coords: ['o'] });
        expect(best.return).toEqual({ coords: ['r'] });
        expect(best.overlap).toBeNull();
    });

    test('empty pool builds nothing and returns null', async () => {
        const best = await globalThis.findBestLoop(60, 24, {
            candidatePool: [], dest: undefined, existingDests: [],
            maxKm: 5, winterMode: false, spread: {}, onProgress: vi.fn() });
        expect(globalThis.buildJunctionLoop).not.toHaveBeenCalled();
        expect(best).toBeNull();
    });
});

// ── buildRouteForDestination ──────────────────────────────────────────────────

// ── budget-aware ranking (avoidBacktracking) ─────────────────────────────────
//
// Legacy findBestLoop ranks on leg overlap alone, which is how a 6.9 km loop won
// a 5 km budget: nothing ever compared the built route to the number the user
// typed. With avoidBacktracking the rank becomes loopScore (overlap + budget
// overshoot). These pin BOTH sides — the fix, and the legacy behaviour it is
// opt-in against.
describe('findBestLoop budget-aware ranking', () => {
    // Legs carry METRES, as they do off OSRM; the km conversion is findBestLoop's.
    function sizedLoop(overlap, totalKm) {
        return {
            outbound: { coords: ['o'], distance: totalKm * 500 },
            return:   { coords: ['r'], distance: totalKm * 500 },
            overlap,
            junctions: [{ j: 1 }],
        };
    }
    // Two candidates: a sprawling loop with tidy legs, then a compact loop with
    // worse legs. Overlap alone prefers the first; budget-aware prefers the second.
    const sprawling = sizedLoop(0.10, 9);   // 80% over a 5 km budget
    const compact   = sizedLoop(0.35, 5);   // fits exactly
    const twoDests  = [{ lat: 1, lng: 1, name: 'sprawling' }, { lat: 2, lng: 2, name: 'compact' }];

    function optsFor(avoidBacktracking) {
        return {
            candidatePool: twoDests, dest: twoDests[0], existingDests: [], maxKm: 5,
            winterMode: false, spread: { offsetMult: 0.2, viaTs: [] }, onProgress: vi.fn(),
            avoidBacktracking,
        };
    }

    test('legacy ranking keeps the over-budget loop because its legs overlap least', async () => {
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce(sprawling)
            .mockResolvedValueOnce(compact);
        const best = await globalThis.findBestLoop(60, 24, optsFor(false));
        expect(best.destName).toBe('sprawling');
    });

    test('budget-aware ranking prefers the loop that fits the distance asked for', async () => {
        globalThis.buildJunctionLoop
            .mockResolvedValueOnce(sprawling)
            .mockResolvedValueOnce(compact);
        const best = await globalThis.findBestLoop(60, 24, optsFor(true));
        expect(best.destName).toBe('compact');
        // overlap is still reported unmodified — generate.js warns the user on it.
        expect(best.overlap).toBe(0.35);
    });

    test('a sub-threshold overlap that busts the budget no longer stops the retry loop', async () => {
        // 0.10 overlap is under OVERLAP_BAD_THRESHOLD, so legacy early-exits on
        // attempt 1. Budget-aware scores it 0.10 + 0.80 and keeps looking.
        globalThis.buildJunctionLoop.mockResolvedValue(sprawling);
        await globalThis.findBestLoop(60, 24, optsFor(false));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(1);

        globalThis.buildJunctionLoop.mockClear();
        await globalThis.findBestLoop(60, 24, optsFor(true));
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(2);
    });

    test('the flag reaches buildJunctionLoop, not just the ranking', async () => {
        globalThis.buildJunctionLoop.mockResolvedValue(compact);
        await globalThis.findBestLoop(60, 24, optsFor(true));
        expect(globalThis.buildJunctionLoop.mock.calls[0][4].avoidBacktracking).toBe(true);
    });
});

describe('buildRouteForDestination', () => {
    const dest = { lat: 61, lng: 25, name: 'Dest' };

    test('round-trip → findBestLoop path, returns the substituted best loop', async () => {
        const better = { lat: 62, lng: 26, name: 'Better' };
        globalThis.buildJunctionLoop.mockResolvedValue({
            outbound: { coords: ['o'] }, return: { coords: ['r'] }, overlap: 0.1, junctions: [{ j: 1 }],
        });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [better], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false, onProgress: vi.fn() });
        expect(globalThis.buildRouteForMode).not.toHaveBeenCalled();
        expect(built.dest).toBe(better);
        expect(built.destName).toBe('Better');
        expect(built.overlap).toBe(0.1);
        expect(built.outbound).toEqual({ coords: ['o'] });
    });

    // The silent-downgrade guard (see route-view.js / generate.js / this
    // file's headers): smart routing is no longer a caller-supplied flag on
    // this function at all — `smartRouting` is not even a key in the options
    // object below. A round trip that is not degraded must still take the
    // multi-candidate findBestLoop path unconditionally; if a future edit
    // reintroduces a smartRouting-style gate defaulting to falsy, this test
    // catches the regression (findBestLoop would never run, and the build
    // would silently downgrade to buildRouteForMode's single-shot buildLoop).
    test('round-trip still takes the multi-candidate findBestLoop path with no smartRouting key at all', async () => {
        globalThis.buildJunctionLoop.mockResolvedValue({
            outbound: { coords: ['o'] }, return: { coords: ['r'] }, overlap: 0.1, junctions: [{ j: 1 }],
        });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [dest], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false, onProgress: vi.fn() });
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(1);
        expect(globalThis.buildRouteForMode).not.toHaveBeenCalled();
        expect(built.overlap).toBe(0.1);
    });

    test('round-trip with nothing built → undefined legs, null overlap', async () => {
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false, onProgress: vi.fn() });
        expect(built.dest).toBe(dest);
        expect(built.outbound).toBeUndefined();
        expect(built.return).toBeUndefined();
        expect(built.junctions).toBeNull();
        expect(built.overlap).toBeNull();
    });

    // one-way builds are unchanged: they never took the smart-loop branch
    // before (tripMode !== 'one-way' already gated it), and still don't —
    // dispatched straight through buildRouteForMode with smartRouting
    // hardcoded false ("plain loop, deliberately"), regardless of tripMode.
    test('one-way builds are unchanged → buildRouteForMode path, junctions/overlap null', async () => {
        globalThis.buildRouteForMode.mockResolvedValue({ outbound: { coords: ['ow'] }, return: null, junctions: null });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [dest], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'one-way', spread: {}, winterMode: true, onProgress: vi.fn() });
        expect(globalThis.buildJunctionLoop).not.toHaveBeenCalled();
        expect(globalThis.buildRouteForMode).toHaveBeenCalledWith(60, 24, 61, 25, expect.objectContaining({
            tripMode: 'one-way', smartRouting: false, winterMode: false }));
        expect(built.dest).toBe(dest);
        expect(built.outbound).toEqual({ coords: ['ow'] });
        expect(built.junctions).toBeNull();
        expect(built.overlap).toBeNull();
    });

    // ── degraded (Layer 2 pipeline reduction) ────────────────────────────────

    test('a degraded round trip still skips junctions and candidate retries', async () => {
        globalThis.buildRouteForMode.mockResolvedValue({
            outbound: { coords: ['lo'] }, return: { coords: ['lr'] }, junctions: null });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [dest], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false,
            onProgress: vi.fn(), degraded: true });
        // buildJunctionLoop is the only path that fetches /api/junctions/
        // (osrm.test.js pins that); asserting it's never called is the same
        // as asserting no junctions fetch happened.
        expect(globalThis.buildJunctionLoop).not.toHaveBeenCalled();
        // The fallback call hardcodes smartRouting: false — that's the "plain
        // loop, deliberately" meaning that used to come from a caller-supplied
        // false and must survive as an explicit literal now that the incoming
        // flag is gone entirely.
        expect(globalThis.buildRouteForMode).toHaveBeenCalledWith(60, 24, 61, 25, expect.objectContaining({
            tripMode: 'round', smartRouting: false, degraded: true }));
        expect(built.outbound).toEqual({ coords: ['lo'] });
        expect(built.return).toEqual({ coords: ['lr'] });
    });

    test('degraded never enters findBestLoop (one build attempt for a 3-candidate pool)', async () => {
        const pool = [
            { lat: 1, lng: 1, name: 'a' },
            { lat: 2, lng: 2, name: 'b' },
            { lat: 3, lng: 3, name: 'c' },
        ];
        globalThis.buildRouteForMode.mockResolvedValue({
            outbound: { coords: ['lo'] }, return: { coords: ['lr'] }, junctions: null });
        await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: pool, dest: pool[0], destName: 'a', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false,
            onProgress: vi.fn(), degraded: true });
        // findBestLoop would call buildJunctionLoop up to MAX_RETRY_ATTEMPTS (3)
        // times for this pool; degraded must never enter that loop at all.
        expect(globalThis.buildJunctionLoop).not.toHaveBeenCalled();
        expect(globalThis.buildRouteForMode).toHaveBeenCalledTimes(1);
    });

    test('a non-degraded round trip still uses findBestLoop', async () => {
        globalThis.buildJunctionLoop.mockResolvedValue({
            outbound: { coords: ['o'] }, return: { coords: ['r'] }, overlap: 0.1, junctions: [{ j: 1 }],
        });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [dest], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'round', spread: {}, winterMode: false,
            onProgress: vi.fn(), degraded: false });
        expect(globalThis.buildJunctionLoop).toHaveBeenCalledTimes(1);
        expect(globalThis.buildRouteForMode).not.toHaveBeenCalled();
        expect(built.overlap).toBe(0.1);
    });

    test('one-way builds are unaffected by degraded', async () => {
        globalThis.buildRouteForMode.mockResolvedValue({ outbound: { coords: ['ow'] }, return: null, junctions: null });
        const built = await globalThis.buildRouteForDestination(60, 24, {
            candidatePool: [dest], dest, destName: 'Dest', existingDests: [],
            maxKm: 5, tripMode: 'one-way', spread: {}, winterMode: true,
            onProgress: vi.fn(), degraded: true });
        expect(globalThis.buildJunctionLoop).not.toHaveBeenCalled();
        expect(globalThis.buildRouteForMode).toHaveBeenCalledWith(60, 24, 61, 25, expect.objectContaining({
            tripMode: 'one-way', smartRouting: false, winterMode: false, degraded: true }));
        expect(built.outbound).toEqual({ coords: ['ow'] });
    });
});
