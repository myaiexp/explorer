// @vitest-environment node
/**
 * Tests for novelty.js — the whole module in one file: minDistanceToExisting
 * (audit #3166), rankByNovelty, shuffleInPlace (audit #1580), and the
 * pickMostNovelDestination consolidation (audit #1796) that delegates to
 * rankByNovelty.
 *
 * Loading: novelty.js is a non-module browser script that depends on the shared
 * haversineKm from geo-utils.js, so geo-utils.js runs in the realm first —
 * helpers/load.js's SCRIPT_DEPS encodes that edge, so loading 'novelty' pulls
 * it in automatically. destination-resolve.js is loaded next so the suite can
 * pin pickMostNovelDestination on the real globalThis export (it reads
 * rankByNovelty off globalThis at call time). The `@vitest-environment node`
 * pragma above just skips jsdom setup, which this suite doesn't need.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    // novelty first so rankByNovelty is on globalThis when the real pick runs;
    // destination-resolve has no SCRIPT_DEPS (other suites fake its deps), so
    // load it explicitly after novelty for the consolidation pin only.
    loadScripts('novelty');
    loadScripts('destination-resolve');
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
// Real export lives on globalThis from destination-resolve.js (one-liner:
// rankByNovelty(candidates, existingDests)[0]). Pin against that export so a
// drift in the live path fails here — not a local reimplementation that can
// stay green when the real function diverges (audit #5724).
//
// destination-resolve.test.js fakes rankByNovelty as identity so its pipeline
// tests stay deterministic; the support-set / distribution pin lives here with
// the real novelty module loaded.

const pick = (...args) => globalThis.pickMostNovelDestination(...args);

// Stable identity key — compare by tag rather than reference (pick returns the
// original candidate object from rankByNovelty's ranked list).
const tagOf = c => (c == null ? undefined : c.tag);
const supportOf = (candidates, existing, trials = 400) => {
    const seen = new Set();
    for (let i = 0; i < trials; i++) seen.add(tagOf(pick(candidates, existing)));
    return seen;
};

describe('pickMostNovelDestination (real export)', () => {
    test('is the globalThis export from destination-resolve', () => {
        expect(typeof globalThis.pickMostNovelDestination).toBe('function');
    });

    test('empty candidates → undefined', () => {
        expect(pick([], [])).toBeUndefined();
        expect(pick([], [[60, 24]])).toBeUndefined();
    });

    test('single candidate with history → returns that candidate', () => {
        const only = { lat: 61, lng: 24, tag: 'only' };
        expect(tagOf(pick([only], [[60, 24]]))).toBe('only');
    });

    test('delegates to rankByNovelty — pick is always rankByNovelty(...)[0]', () => {
        // Structural pin: whatever rankByNovelty returns, the export takes [0].
        // Uses a deterministic stub so the one-liner contract is independent of
        // shuffle noise; restore the real ranker after.
        const realRank = globalThis.rankByNovelty;
        const cands = [
            { lat: 60, lng: 24, tag: 'first' },
            { lat: 61, lng: 25, tag: 'second' },
        ];
        globalThis.rankByNovelty = () => [cands[1], cands[0]];
        try {
            expect(pick(cands, [[60, 24]])).toBe(cands[1]);
        } finally {
            globalThis.rankByNovelty = realRank;
        }
    });

    test('with history → never picks a low-novelty candidate (mutation-proof)', () => {
        // Flipping rankByNovelty's sort sign would surface the close ones here.
        const existing = [[60.0, 24.0]];
        const close1 = { lat: 60.001, lng: 24.001, tag: 'close1' };
        const close2 = { lat: 60.002, lng: 24.002, tag: 'close2' };
        const far1 = { lat: 65.0, lng: 28.0, tag: 'far1' };
        const far2 = { lat: 67.0, lng: 30.0, tag: 'far2' };
        const cands = [close1, close2, far1, far2];
        expect(supportOf(cands, existing)).toEqual(new Set(['far1', 'far2']));
    });

    test('with history → support set is the novel top half', () => {
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
        expect(supportOf(cands, existing)).toEqual(new Set(['c3', 'c4', 'c5']));
    });

    test('no history → support set is all candidates (uniform pick)', () => {
        const cands = [
            { lat: 60, lng: 24, tag: 'a' },
            { lat: 61, lng: 25, tag: 'b' },
            { lat: 62, lng: 26, tag: 'c' },
        ];
        expect(supportOf(cands, [])).toEqual(new Set(['a', 'b', 'c']));
    });
});
