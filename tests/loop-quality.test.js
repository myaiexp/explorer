/**
 * Tests for loop-quality.js — loopOverlapFraction.
 *
 * Loading: loop-quality.js is a non-module browser script. We load its
 * source and run it in the current realm via Node's vm module; the
 * script's explicit globalThis assignments expose the helpers. It reads the
 * shared globalThis.haversineM (audit #1262), so geo-utils.js loads first.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const GEO_SRC = readFileSync(resolve(__dirname, '../geo-utils.js'), 'utf8');
const SRC = readFileSync(resolve(__dirname, '../loop-quality.js'), 'utf8');

beforeAll(() => {
    new vm.Script(GEO_SRC).runInThisContext();   // exposes globalThis.haversineM
    new vm.Script(SRC).runInThisContext();
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
        expect(overlap).toBeGreaterThan(0.4);
        expect(overlap).toBeLessThan(0.7);
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
