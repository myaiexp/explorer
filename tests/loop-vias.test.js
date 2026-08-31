// @vitest-environment node
/**
 * Tests for loopVias (osrm.js) — the single source for the loop envelope vias,
 * now shared by buildLoop, buildJunctionLoop, and buildDirectionsUrl.
 *
 * Loading: geo-utils.js + geometry.js provide the globals loopVias/buildLoopSetup
 * read at call time (haversineKm, envelopeOffsetPoint, computeSpreadParams);
 * osrm.js only assigns globals at load (no top-level calls),
 * so the whole file runs cleanly in the realm. loopOverlapFraction is unused here.
 * helpers/load.js's SCRIPT_DEPS already lists osrm's edges (net, geometry,
 * loop-quality; geo-utils arrives transitively), so loading 'osrm' pulls them.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('osrm');
});

const A = { lat: 60, lng: 24 };
const B = { lat: 60.1, lng: 24.1 };

function setup() {
    const spread = globalThis.computeSpreadParams(50);
    const straight = globalThis.haversineKm(A.lat, A.lng, B.lat, B.lng);
    const offsetKm = Math.max(0.1, straight * spread.offsetMult);
    return { spread, offsetKm };
}

describe('loopVias', () => {
    test('right/left vias match envelopeOffsetPoint at the three via t-positions', () => {
        const { spread, offsetKm } = setup();
        const { rightVias, leftVias, viaTs } = globalThis.loopVias(A.lat, A.lng, B.lat, B.lng, spread);

        expect(viaTs).toEqual([0.25, 0.5, 0.75]);
        expect(rightVias).toHaveLength(3);
        expect(leftVias).toHaveLength(3);
        for (let i = 0; i < viaTs.length; i++) {
            expect(rightVias[i]).toEqual(
                globalThis.envelopeOffsetPoint(A.lat, A.lng, B.lat, B.lng, viaTs[i], offsetKm, -1));
            expect(leftVias[i]).toEqual(
                globalThis.envelopeOffsetPoint(A.lat, A.lng, B.lat, B.lng, viaTs[i], offsetKm, +1));
        }
    });

    test('spreads the setup fields (A, B, offsetKm, snapRadius) so callers skip re-deriving', () => {
        const { spread, offsetKm } = setup();
        const v = globalThis.loopVias(A.lat, A.lng, B.lat, B.lng, spread);
        expect(v.A).toEqual(A);
        expect(v.B).toEqual(B);
        expect(v.offsetKm).toBeCloseTo(offsetKm, 9);
        expect(v.snapRadius).toBeCloseTo(Math.max(0.3, offsetKm * 0.5), 9);
    });

    test('snapRadius and offsetKm honour their floors for a near-zero separation', () => {
        // dest ~metres from start → straight·offsetMult ≪ 0.1, so both floors bind.
        const v = globalThis.loopVias(60, 24, 60.00001, 24.00001, globalThis.computeSpreadParams(50));
        expect(v.offsetKm).toBe(0.1);
        expect(v.snapRadius).toBe(0.3);
    });

    // Behaviour-preservation: loopVias must reproduce, byte for byte, the inline
    // formulas the three consumers used before the extraction.
    test('reproduces the old buildLoop / buildDirectionsUrl inline vias exactly', () => {
        const { spread, offsetKm } = setup();
        const { viaTs } = spread;
        const { rightVias, leftVias } = globalThis.loopVias(A.lat, A.lng, B.lat, B.lng, spread);

        // old buildLoop: viasRight forward -1, viasLeftReturn reversed +1
        const oldViasRight = viaTs.map(t =>
            globalThis.envelopeOffsetPoint(A.lat, A.lng, B.lat, B.lng, t, offsetKm, -1));
        const oldViasLeftReturn = viaTs.slice().reverse().map(t =>
            globalThis.envelopeOffsetPoint(A.lat, A.lng, B.lat, B.lng, t, offsetKm, +1));
        expect(rightVias).toEqual(oldViasRight);
        expect(leftVias.slice().reverse()).toEqual(oldViasLeftReturn);

        // old buildDirectionsUrl: outVias = rightVias, retVias = leftVias reversed
        expect(rightVias).toEqual(oldViasRight);
        expect(leftVias.slice().reverse()).toEqual(oldViasLeftReturn);
    });
});

// ── avoidBacktracking envelope ───────────────────────────────────────────────
//
// The toggle exists because the legacy pair is incoherent: snapRadius floors at
// 300 m while offsetKm floors at 100 m, so a via can be snapped further than the
// envelope displaced it — back across the A→B line, collapsing the loop onto
// one set of streets. These pin the two properties that fix must hold.
describe('buildLoopSetup with avoidBacktracking', () => {
    const near = { lat: 60.012, lng: 24 };   // ~1.33 km — the short-trip case

    const setupFor = (slider, opts) => globalThis.buildLoopSetup(
        A.lat, A.lng, near.lat, near.lng, globalThis.computeSpreadParams(slider), opts);

    test('the snap radius can never exceed the offset that placed the via', () => {
        for (const slider of [0, 25, 50, 75, 100]) {
            const { offsetKm, snapRadius } = setupFor(slider, { avoidBacktracking: true });
            expect(snapRadius).toBeLessThanOrEqual(offsetKm);
        }
    });

    test('legacy geometry has the inverted relationship this replaces', () => {
        // Not aspirational — this is the bug, pinned so the comparison stays honest.
        const { offsetKm, snapRadius } = setupFor(50, { avoidBacktracking: false });
        expect(snapRadius).toBeGreaterThan(offsetKm);
    });

    test('the whole slider stays live — legacy collapses its bottom quarter', () => {
        const legacy = [0, 25].map(s => setupFor(s, { avoidBacktracking: false }).offsetKm);
        expect(legacy[0]).toBe(legacy[1]);           // the dead zone, as shipped

        const fixed = [0, 25, 50, 75, 100].map(s => setupFor(s, { avoidBacktracking: true }).offsetKm);
        for (let i = 1; i < fixed.length; i++) expect(fixed[i]).toBeGreaterThan(fixed[i - 1]);
    });

    test('the narrowest loop clears the block spacing that forced leg reuse', () => {
        expect(setupFor(0, { avoidBacktracking: true }).offsetKm)
            .toBeGreaterThanOrEqual(globalThis.MIN_LOOP_OFFSET_KM);
    });

    test('omitting the option leaves the legacy geometry byte-identical', () => {
        expect(setupFor(50, undefined)).toEqual(setupFor(50, { avoidBacktracking: false }));
    });
});
