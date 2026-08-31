// @vitest-environment node
/**
 * Tests for loop-quality.js — loopOverlapFraction, loopBudgetOvershoot, loopScore.
 *
 * Loading: loop-quality.js is a non-module browser script. It reads the
 * shared globalThis.haversineM (audit #1262), so geo-utils.js must load
 * first — helpers/load.js's SCRIPT_DEPS encodes that edge, so loading
 * 'loop-quality' pulls it in automatically, both evaluated in the current
 * realm with their explicit globalThis assignments exposing the helpers.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('loop-quality');   // pulls in geo-utils first (globalThis.haversineM)
});

describe('loopOverlapFraction', () => {
    test('identical polylines → 1.0', () => {
        const path = [[60.17, 24.94], [60.18, 24.95], [60.19, 24.96]];
        expect(globalThis.loopOverlapFraction(path, path)).toBeCloseTo(1.0, 2);
    });

    test('opposite-direction same path → 1.0 (degenerate out-and-back)', () => {
        const out = [[60.17, 24.94], [60.18, 24.95], [60.19, 24.96]];
        const ret = [...out].reverse();
        expect(globalThis.loopOverlapFraction(out, ret)).toBeCloseTo(1.0, 2);
    });

    test('parallel offset 100 m → near 0', () => {
        // ~100 m north offset (1° lat ≈ 111 km, so 100 m ≈ 0.0009°)
        const out = [[60.17, 24.94], [60.18, 24.94], [60.19, 24.94]];
        const ret = [[60.1709, 24.94], [60.1809, 24.94], [60.1909, 24.94]];
        expect(globalThis.loopOverlapFraction(out, ret)).toBeLessThan(0.05);
    });

    test('partial overlap (half-shared) → ~0.5', () => {
        // First half identical, second half offset 200 m
        const out = [
            [60.17, 24.94], [60.18, 24.95],
            [60.19, 24.96], [60.20, 24.97],
        ];
        const ret = [
            [60.20, 24.97], [60.19, 24.96],     // shared (reversed)
            [60.1818, 24.95], [60.1718, 24.94], // offset ~200 m north
        ];
        const overlap = globalThis.loopOverlapFraction(out, ret);
        // Exact derivation (OVERLAP_PROXIMITY_M = 25 m):
        //   out→ret: out[2]/out[3] coincide with ret[1]/ret[0] (0 m apart);
        //            out[0]/out[1] sit ~200 m from their nearest ret point
        //            (> 25 m) → 2 of 4 near = 0.50
        //   ret→out: symmetric by the same coordinates → 2 of 4 = 0.50
        //   max(0.50, 0.50) = 0.50 — a genuine half-shared loop.
        // Tight bound: an implementation drifting to 0.41 (just over
        // OVERLAP_BAD_THRESHOLD) or 0.69 now fails instead of sliding through
        // the old 0.4–0.7 window.
        expect(overlap).toBeCloseTo(0.5, 5);
    });

    test('empty outbound → 0', () => {
        expect(globalThis.loopOverlapFraction([], [[60, 24]])).toBe(0);
    });

    test('null returns → 0', () => {
        expect(globalThis.loopOverlapFraction(null, [[60, 24]])).toBe(0);
        expect(globalThis.loopOverlapFraction([[60, 24]], null)).toBe(0);
    });

    test('asymmetric leg lengths still report max', () => {
        // Long outbound, short return that exactly retraces beginning of outbound
        const out = Array.from({length: 20}, (_, i) => [60.17 + i*0.001, 24.94]);
        const ret = out.slice(0, 5).reverse();
        const overlap = globalThis.loopOverlapFraction(out, ret);
        // ret→out is fully covered (1.0); out→ret is only ~25% covered.
        // Max is 1.0.
        expect(overlap).toBeCloseTo(1.0, 1);
    });
});

describe('loopBudgetOvershoot', () => {
    test('a loop inside the budget is not penalised, at any margin', () => {
        expect(globalThis.loopBudgetOvershoot(3, 5)).toBe(0);
        expect(globalThis.loopBudgetOvershoot(5, 5)).toBe(0);
    });

    test('overshoot is the fraction of the budget exceeded', () => {
        expect(globalThis.loopBudgetOvershoot(7, 5)).toBeCloseTo(0.4, 10);
        expect(globalThis.loopBudgetOvershoot(10, 5)).toBeCloseTo(1.0, 10);
    });

    test('an unusable budget scores 0 rather than poisoning the rank with NaN', () => {
        // A missing leg leaves totalKm NaN; maxKm can be NaN from an empty field.
        for (const [total, max] of [[NaN, 5], [7, NaN], [7, 0], [7, -1], [7, undefined]]) {
            expect(globalThis.loopBudgetOvershoot(total, max)).toBe(0);
        }
    });
});

describe('loopScore', () => {
    test('adds overlap and overshoot on the same scale', () => {
        expect(globalThis.loopScore(0.2, 6, 5)).toBeCloseTo(0.4, 10);   // 0.2 + 0.2
        expect(globalThis.loopScore(0.2, 4, 5)).toBeCloseTo(0.2, 10);   // in budget
    });

    test('an over-budget loop loses to a worse-overlapping one that fits', () => {
        const sprawling = globalThis.loopScore(0.10, 9, 5);   // great legs, 80% over
        const tidy      = globalThis.loopScore(0.35, 5, 5);   // worse legs, fits
        expect(tidy).toBeLessThan(sprawling);
    });

    test('unknown overlap stays null so it never displaces a measured candidate', () => {
        expect(globalThis.loopScore(null, 4, 5)).toBeNull();
        expect(globalThis.loopScore(undefined, 4, 5)).toBeNull();
    });
});
