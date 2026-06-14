// @vitest-environment node
/**
 * Tests for audit #1796 — pickMostNovelDestination now delegates to
 * rankByNovelty instead of re-implementing the scoring/selection.
 *
 * pickMostNovelDestination lives inside app.js (DOM-heavy, not loadable in a
 * bare vm realm) and is not globalThis-exposed, so we exercise the consolidated
 * BODY directly: `rankByNovelty(candidates, existingDests)[0]`. That expression
 * is byte-identical to the function's new implementation.
 *
 * Why no frozen-Math.random "same exact pick" baseline: the old single-pick
 * (one `Math.floor(Math.random()*n)` index) and the new path (Fisher-Yates
 * shuffle of the top half, then [0]) consume different amounts of entropy, so
 * under a mocked RNG they select different specific elements. The DISTRIBUTION
 * is identical, so we prove equivalence by support-set comparison over many
 * trials against a faithful copy of the pre-refactor logic.
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
