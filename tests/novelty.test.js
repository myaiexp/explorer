// @vitest-environment node
/**
 * Tests for novelty.js — the whole module in one file: minDistanceToExisting
 * (audit #3166), rankByNovelty, shuffleInPlace (audit #1580), and the
 * pickMostNovelDestination consolidation (audit #1796) that delegates to
 * rankByNovelty.
 *
 * Loading: novelty.js is a non-module browser script that depends on the shared
 * haversineKm from geo-utils.js, so geo-utils.js runs in the realm first; both
 * expose their helpers via explicit globalThis assignment. The vm/fs loader needs
 * Node built-ins, so this file runs under the node environment (the repo-root
 * vitest config defaults to jsdom, which stubs Node built-ins).
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

describe('rankByNovelty', () => {
    test('empty candidates → empty array', () => {
        expect(globalThis.rankByNovelty([], [])).toEqual([]);
        expect(globalThis.rankByNovelty([], [[60, 24]])).toEqual([]);
    });

    test('no existing destinations → all candidates returned, length preserved', () => {
        const cands = [{lat: 60, lng: 24}, {lat: 61, lng: 25}];
        const ranked = globalThis.rankByNovelty(cands, []);
        expect(ranked.length).toBe(2);
        expect(new Set(ranked)).toEqual(new Set(cands));
    });

    test('with history, clearly-more-novel candidates appear in top half', () => {
        // existingDests is [[lat, lng], ...] — tuple form
        const existing = [[60.0, 24.0]];
        const veryClose1 = {lat: 60.001, lng: 24.001};
        const veryClose2 = {lat: 60.002, lng: 24.002};
        const veryFar1   = {lat: 65.0,   lng: 28.0};
        const veryFar2   = {lat: 67.0,   lng: 30.0};
        const ranked = globalThis.rankByNovelty(
            [veryClose1, veryClose2, veryFar1, veryFar2], existing);
        const topHalf = new Set(ranked.slice(0, 2));
        const bottomHalf = new Set(ranked.slice(2));
        expect(topHalf).toEqual(new Set([veryFar1, veryFar2]));
        expect(bottomHalf).toEqual(new Set([veryClose1, veryClose2]));
    });

    test('odd-length top half ceil(n/2)', () => {
        const existing = [[60.0, 24.0]];
        const cands = Array.from({length: 5}, (_, i) => ({
            lat: 60 + i * 0.5, lng: 24,
        }));
        // Top half is ceil(5/2) = 3. The 3 farthest from [60, 24] are
        // indices 2, 3, 4 (lats 61, 61.5, 62).
        const ranked = globalThis.rankByNovelty(cands, existing);
        expect(ranked.length).toBe(5);
        const top = new Set(ranked.slice(0, 3));
        expect(top).toEqual(new Set([cands[2], cands[3], cands[4]]));
    });

    test('preserves all candidates, no duplicates, no extras', () => {
        const cands = Array.from({length: 5}, (_, i) => ({lat: 60 + i*0.01, lng: 24}));
        const ranked = globalThis.rankByNovelty(cands, [[60, 24]]);
        expect(ranked.length).toBe(5);
        expect(new Set(ranked)).toEqual(new Set(cands));
    });
});

// shuffleInPlace was only ever exercised indirectly through rankByNovelty,
// leaving its contract — mutate-in-place (same array reference, not a copy) and
// preserve the exact multiset of elements — unpinned, including the empty/single
// degenerate inputs the Fisher-Yates loop short-circuits on (audit #1580).
describe('shuffleInPlace', () => {
    test('empty array → returns the SAME (empty) array reference', () => {
        const arr = [];
        const out = globalThis.shuffleInPlace(arr);
        expect(out).toBe(arr);          // mutates in place, never allocates a copy
        expect(out).toEqual([]);
    });

    test('single element → returns the SAME array reference, unchanged', () => {
        const arr = [42];
        const out = globalThis.shuffleInPlace(arr);
        expect(out).toBe(arr);
        expect(out).toEqual([42]);
    });

    test('multi-element → same reference (in-place) and preserves the exact multiset', () => {
        const arr = [1, 2, 3, 4, 5];
        const out = globalThis.shuffleInPlace(arr);
        expect(out).toBe(arr);          // not a new array
        // Order may change, but every original element survives exactly once.
        expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
        expect(out.length).toBe(5);
    });
});

// ── audit #1796 — pickMostNovelDestination delegates to rankByNovelty ──────────
// pickMostNovelDestination lives inside the frontend's generate pipeline
// (DOM-heavy, not loadable in a bare vm realm) and is not globalThis-exposed, so
// we exercise the consolidated BODY directly: `rankByNovelty(candidates,
// existingDests)[0]`. That expression is byte-identical to the function's
// implementation.
//
// Why no frozen-Math.random "same exact pick" baseline: the old single-pick (one
// `Math.floor(Math.random()*n)` index) and the new path (Fisher-Yates shuffle of
// the top half, then [0]) consume different amounts of entropy, so under a mocked
// RNG they select different specific elements. The DISTRIBUTION is identical, so
// we prove equivalence by support-set comparison over many trials against a
// faithful copy of the pre-refactor logic.

// The consolidated body of pickMostNovelDestination (post audit #1796).
const pickNew = (candidates, existingDests) =>
    globalThis.rankByNovelty(candidates, existingDests)[0];

// Faithful copy of the PRE-refactor pickMostNovelDestination body. Must stay
// behaviorally identical to the code that lived in app.js before #1796 — this
// is the equivalence baseline. calculateDistance was `globalThis.haversineKm`.
function pickOld(candidates, existingDests) {
    if (!existingDests || existingDests.length === 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    const scored = candidates.map(c => {
        const minDist = existingDests.reduce((min, [eLat, eLng]) =>
            Math.min(min, globalThis.haversineKm(c.lat, c.lng, eLat, eLng)), Infinity);
        return { ...c, minDist };
    });
    scored.sort((a, b) => b.minDist - a.minDist);
    const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
    return pool[Math.floor(Math.random() * pool.length)];
}

// Stable identity key — old returns a {...c} copy, new returns the original
// object, so compare by coordinates (and tag) rather than reference.
const tagOf = c => (c == null ? undefined : c.tag);
const supportOf = (pick, candidates, existing, trials = 400) => {
    const seen = new Set();
    for (let i = 0; i < trials; i++) seen.add(tagOf(pick(candidates, existing)));
    return seen;
};

describe('pickMostNovelDestination ≡ rankByNovelty(...)[0]', () => {
    test('empty candidates → undefined (matches pre-refactor)', () => {
        expect(pickNew([], [])).toBeUndefined();
        expect(pickNew([], [[60, 24]])).toBeUndefined();
        expect(pickOld([], [])).toBeUndefined();
        expect(pickOld([], [[60, 24]])).toBeUndefined();
    });

    test('single candidate with history → returns that candidate', () => {
        const only = { lat: 61, lng: 24, tag: 'only' };
        expect(tagOf(pickNew([only], [[60, 24]]))).toBe('only');
        expect(tagOf(pickOld([only], [[60, 24]]))).toBe('only');
    });

    test('with history → never picks a low-novelty candidate (mutation-proof)', () => {
        // Flipping rankByNovelty's sort sign would surface the close ones here.
        const existing = [[60.0, 24.0]];
        const close1 = { lat: 60.001, lng: 24.001, tag: 'close1' };
        const close2 = { lat: 60.002, lng: 24.002, tag: 'close2' };
        const far1 = { lat: 65.0, lng: 28.0, tag: 'far1' };
        const far2 = { lat: 67.0, lng: 30.0, tag: 'far2' };
        const cands = [close1, close2, far1, far2];
        const support = supportOf(pickNew, cands, existing);
        expect(support).toEqual(new Set(['far1', 'far2']));
    });

    test('support set is identical between old and new — with history', () => {
        const existing = [[60.0, 24.0]];
        // Distinct, well-separated distances → top half ceil(6/2)=3 is the
        // three farthest: c3, c4, c5. No ties, so support is deterministic.
        const cands = [
            { lat: 60.001, lng: 24.0, tag: 'c0' },
            { lat: 60.5, lng: 24.0, tag: 'c1' },
            { lat: 61.0, lng: 24.0, tag: 'c2' },
            { lat: 61.5, lng: 24.0, tag: 'c3' },
            { lat: 62.0, lng: 24.0, tag: 'c4' },
            { lat: 62.5, lng: 24.0, tag: 'c5' },
        ];
        const expectedTop = new Set(['c3', 'c4', 'c5']);
        const newSupport = supportOf(pickNew, cands, existing);
        const oldSupport = supportOf(pickOld, cands, existing);
        expect(newSupport).toEqual(expectedTop);
        expect(oldSupport).toEqual(expectedTop);
        expect(newSupport).toEqual(oldSupport);
    });

    test('support set is identical between old and new — no history', () => {
        // No existing destinations → both pick uniformly across ALL candidates.
        const cands = [
            { lat: 60, lng: 24, tag: 'a' },
            { lat: 61, lng: 25, tag: 'b' },
            { lat: 62, lng: 26, tag: 'c' },
        ];
        const all = new Set(['a', 'b', 'c']);
        const newSupport = supportOf(pickNew, cands, []);
        const oldSupport = supportOf(pickOld, cands, []);
        expect(newSupport).toEqual(all);
        expect(oldSupport).toEqual(all);
        expect(newSupport).toEqual(oldSupport);
    });
});
