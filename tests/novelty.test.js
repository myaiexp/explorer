// @vitest-environment node
/**
 * Tests for novelty.js — minDistanceToExisting (audit #3166).
 *
 * rankByNovelty is covered in rank-by-novelty.test.js; this file pins the
 * helper minDistanceToExisting directly, which the existing suites only
 * exercise indirectly. The empty-existingDests path is the headline case:
 * reduce over [] returns the Infinity seed unchanged — the "no neighbors,
 * infinite novelty" sentinel rankByNovelty relies on.
 *
 * Loading: novelty.js is a non-module browser script that depends on the
 * shared haversineKm from geo-utils.js, so load geo-utils.js into the realm
 * first; both expose their helpers via explicit globalThis assignment. The
 * vm/fs loader needs Node built-ins, so this file runs under the node
 * environment (the repo-root vitest config defaults to jsdom, which stubs
 * Node built-ins) — matching the loader pattern of its sibling test files.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const GEO_SRC = readFileSync(resolve(__dirname, '../geo-utils.js'), 'utf8');
const SRC = readFileSync(resolve(__dirname, '../novelty.js'), 'utf8');

beforeAll(() => {
    new vm.Script(GEO_SRC).runInThisContext();
    new vm.Script(SRC).runInThisContext();
});

describe('minDistanceToExisting', () => {
    const min = (...args) => globalThis.minDistanceToExisting(...args);
    const h = (...args) => globalThis.haversineKm(...args);

    test('empty existingDests → Infinity (no-neighbors sentinel)', () => {
        // reduce over [] returns the Infinity seed: any candidate is maximally
        // novel when there is no history. This is the contract rankByNovelty
        // depends on to return all candidates when existingDests is empty.
        expect(min({ lat: 60.17, lng: 24.94 }, [])).toBe(Infinity);
    });

    test('single existing point → exact distance to it', () => {
        // One degree of latitude north of the candidate ≈ 111.195 km, and it
        // must equal haversineKm exactly (no initial-Infinity contamination).
        const c = { lat: 60, lng: 24 };
        expect(min(c, [[61, 24]])).toBe(h(60, 24, 61, 24));
        expect(min(c, [[61, 24]])).toBeCloseTo(111.195, 2);
    });

    test('multiple existing → returns the nearest (minimum), not max/last/sum', () => {
        // Mix far and near neighbours in a non-sorted order; result must be the
        // closest one. Kills mutations to Math.max / last-element / accumulate.
        const c = { lat: 60, lng: 24 };
        const far = [67, 30];
        const near = [60.01, 24]; // ~1.1 km away
        const mid = [65, 28];
        expect(min(c, [far, near, mid])).toBe(h(60, 24, near[0], near[1]));
    });

    test('candidate coincident with an existing point → 0', () => {
        const c = { lat: 60.17, lng: 24.94 };
        expect(min(c, [[61.5, 23.76], [60.17, 24.94], [62, 25]])).toBe(0);
    });

    test('order-independent — same neighbour set, any order, same result', () => {
        const c = { lat: 60, lng: 24 };
        const a = [[67, 30], [60.01, 24], [65, 28]];
        const b = [[65, 28], [67, 30], [60.01, 24]];
        expect(min(c, a)).toBe(min(c, b));
    });
});
