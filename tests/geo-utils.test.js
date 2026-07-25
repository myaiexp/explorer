// @vitest-environment node
/**
 * Tests for geo-utils.js — haversineKm + haversineM.
 *
 * Loading: geo-utils.js is a non-module browser script, loaded via
 * helpers/load.js's loadScripts('geo-utils'); the script's explicit
 * globalThis assignment exposes the helper.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('geo-utils');
});

describe('haversineKm', () => {
    const h = (...args) => globalThis.haversineKm(...args);

    test('identical points → 0', () => {
        expect(h(60.17, 24.94, 60.17, 24.94)).toBe(0);
    });

    test('one degree of latitude ≈ 111.195 km', () => {
        // R·π/180 = 6371·π/180 ≈ 111.19493 km. Flipping R=6371 breaks this.
        expect(h(0, 0, 1, 0)).toBeCloseTo(111.195, 2);
    });

    test('one degree of longitude at 60°N ≈ 55.597 km (cos-scaled)', () => {
        // Longitude spacing shrinks by cos(lat): 111.195·cos(60°) ≈ 55.597 km.
        // Swapping dLat/dLng would drop the cos factor and yield ≈111.2.
        expect(h(60, 24, 60, 25)).toBeCloseTo(55.597, 2);
    });

    test('symmetric in argument order', () => {
        expect(h(60.17, 24.94, 61.50, 23.76))
            .toBeCloseTo(h(61.50, 23.76, 60.17, 24.94), 10);
    });
});

describe('haversineM', () => {
    const hKm = (...args) => globalThis.haversineKm(...args);
    const hM  = (...args) => globalThis.haversineM(...args);

    test('identical points → 0', () => {
        expect(hM(60.17, 24.94, 60.17, 24.94)).toBe(0);
    });

    test('is exactly km × 1000 — same separate-args shape', () => {
        // Exact equality, not approximate: haversineM delegates to haversineKm.
        // Mutation-kill: flipping the internal multiplier (1000 → 100) breaks this.
        const cases = [
            [0, 0, 1, 0],
            [60, 24, 60, 25],
            [60.17, 24.94, 61.50, 23.76],
            [60.1699, 24.9384, 61.4978, 23.7610],
        ];
        for (const c of cases) {
            expect(hM(...c)).toBe(hKm(...c) * 1000);
        }
    });

    test('one degree of latitude ≈ 111194.93 m', () => {
        // R·π/180 · 1000 = 6371000·π/180 ≈ 111194.93 m.
        expect(hM(0, 0, 1, 0)).toBeCloseTo(111194.93, 1);
    });

    test('symmetric in argument order', () => {
        expect(hM(60.17, 24.94, 61.50, 23.76))
            .toBeCloseTo(hM(61.50, 23.76, 60.17, 24.94), 6);
    });
});
