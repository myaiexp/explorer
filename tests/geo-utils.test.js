/**
 * Tests for geo-utils.js — haversineKm.
 *
 * Loading: geo-utils.js is a non-module browser script. We load its source
 * and run it in the current realm via Node's vm module; the script's
 * explicit globalThis assignment exposes the helper.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const SRC = readFileSync(resolve(__dirname, '../geo-utils.js'), 'utf8');

beforeAll(() => {
    new vm.Script(SRC).runInThisContext();
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
