// @vitest-environment node
// Tests for src/lib/pool.ts — annulus filtering and the random down-sample
// that replaces the browser's capPool.

import { describe, test, expect } from 'vitest';
import { POOL_CAP, filterToAnnulus, samplePool, haversineKm } from '../src/lib/pool.js';

// Jyväskylä, the start used throughout the design doc's measurements.
const LAT = 62.24;
const LNG = 25.75;

// A point `km` north of the centre. 1 degree of latitude ≈ 111.195 km with this
// haversine's R=6371, so this is exact enough to place a point in a named ring.
function northOf(km: number, name?: string) {
    const p: { lat: number; lng: number; name?: string } = { lat: LAT + km / 111.195, lng: LNG };
    if (name !== undefined) p.name = name;
    return p;
}

function makePoints(n: number) {
    return Array.from({ length: n }, (_, i) => ({ lat: LAT + i * 0.001, lng: LNG, id: i }));
}

describe('haversineKm', () => {
    test('a point on top of the centre is zero km away', () => {
        expect(haversineKm(LAT, LNG, LAT, LNG)).toBe(0);
    });

    test('a degree of latitude is ~111 km', () => {
        expect(haversineKm(LAT, LNG, LAT + 1, LNG)).toBeCloseTo(111.19, 1);
    });
});

describe('filterToAnnulus', () => {
    test('keeps points between minKm and maxKm', () => {
        const pts = [northOf(1), northOf(3), northOf(5)];
        const out = filterToAnnulus(pts, LAT, LNG, 2, 4);
        expect(out).toHaveLength(1);
        expect(out[0]!.lat).toBeCloseTo(northOf(3).lat, 6);
    });

    test('drops points inside minKm', () => {
        const out = filterToAnnulus([northOf(0.5)], LAT, LNG, 1, 5);
        expect(out).toEqual([]);
    });

    test('drops points outside maxKm', () => {
        const out = filterToAnnulus([northOf(9)], LAT, LNG, 0, 5);
        expect(out).toEqual([]);
    });

    // Inclusive at both ends, matching the frontend's `d >= minKm && d <= maxKm`.
    test('both bounds are inclusive', () => {
        const inner = northOf(2);
        const outer = northOf(4);
        const d1 = haversineKm(LAT, LNG, inner.lat, inner.lng);
        const d2 = haversineKm(LAT, LNG, outer.lat, outer.lng);
        expect(filterToAnnulus([inner, outer], LAT, LNG, d1, d2)).toHaveLength(2);
    });

    // The whole reason filterToAnnulus is generic: a POI must not lose its label
    // on the way through.
    test('preserves the name field on POI points', () => {
        const out = filterToAnnulus([northOf(3, 'Kahvila')], LAT, LNG, 1, 5);
        expect(out[0]!.name).toBe('Kahvila');
    });

    test('an empty input yields an empty result, not a throw', () => {
        expect(filterToAnnulus([], LAT, LNG, 0, 5)).toEqual([]);
    });
});

describe('samplePool', () => {
    test('returns the input identity when at or below the cap', () => {
        const small = makePoints(10);
        expect(samplePool(small, POOL_CAP)).toBe(small);
        const exact = makePoints(POOL_CAP);
        expect(samplePool(exact, POOL_CAP)).toBe(exact);
    });

    test('above the cap returns exactly cap items', () => {
        expect(samplePool(makePoints(200), POOL_CAP)).toHaveLength(POOL_CAP);
    });

    test('every sampled item came from the input', () => {
        const input = makePoints(200);
        const ids = new Set(input.map(p => p.id));
        for (const p of samplePool(input, POOL_CAP)) expect(ids.has(p.id)).toBe(true);
    });

    test('the sample has no duplicates', () => {
        const out = samplePool(makePoints(200), POOL_CAP);
        expect(new Set(out.map(p => p.id)).size).toBe(out.length);
    });

    // First-N would make every re-roll from a cached start return the same 45
    // candidates forever — the exact staleness the per-request sample exists to
    // avoid.
    test('is randomized, not first-N', () => {
        const input = makePoints(200);
        const heads = new Set<number>();
        for (let i = 0; i < 20; i++) heads.add(samplePool(input, POOL_CAP)[0]!.id);
        expect(heads.size).toBeGreaterThan(1);
    });

    test('does not mutate its input', () => {
        const input = makePoints(200);
        const before = input.map(p => p.id);
        samplePool(input, POOL_CAP);
        expect(input.map(p => p.id)).toEqual(before);
    });

    test('POOL_CAP mirrors the frontend SCREENING_POOL_CAP', () => {
        expect(POOL_CAP).toBe(45);
    });
});
