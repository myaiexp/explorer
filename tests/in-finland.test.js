// @vitest-environment node
/**
 * Tests for bbox.js — inFinland helper.
 *
 * Loading: bbox.js is a non-module browser script. We load its source and
 * run it in the current realm via Node's vm module; the script's explicit
 * globalThis assignments expose the helpers to the test scope.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const BBOX_SRC = readFileSync(resolve(__dirname, '../bbox.js'), 'utf8');

beforeAll(() => {
    new vm.Script(BBOX_SRC).runInThisContext();
});

describe('inFinland bbox helper', () => {
    test('Helsinki is inside', () => {
        expect(globalThis.inFinland(60.1699, 24.9384)).toBe(true);
    });

    test('Mariehamn (Åland) is inside', () => {
        expect(globalThis.inFinland(60.0971, 19.9348)).toBe(true);
    });

    test('Utsjoki (north) is inside', () => {
        expect(globalThis.inFinland(69.9089, 27.0287)).toBe(true);
    });

    test('Tornio (FI/SE border) is inside', () => {
        expect(globalThis.inFinland(65.8482, 24.1465)).toBe(true);
    });

    test('Stockholm is outside (lng < 19)', () => {
        expect(globalThis.inFinland(59.3293, 18.0686)).toBe(false);
    });

    test('Oslo is outside', () => {
        expect(globalThis.inFinland(59.9139, 10.7522)).toBe(false);
    });

    test('exact minLat boundary (59.0) is inside', () => {
        expect(globalThis.inFinland(59.0, 24.0)).toBe(true);
    });

    test('just below minLat is outside', () => {
        expect(globalThis.inFinland(58.999, 24.0)).toBe(false);
    });

    test('just past maxLng is outside', () => {
        expect(globalThis.inFinland(60.0, 32.001)).toBe(false);
    });

    // The remaining two box edges (maxLat 71.0, minLng 19.0) had no coverage, so
    // an off-by-one shrinking either edge would pass unnoticed (audit).
    test('exact maxLat boundary (71.0) is inside', () => {
        expect(globalThis.inFinland(71.0, 25.0)).toBe(true);
    });

    test('just past maxLat is outside', () => {
        expect(globalThis.inFinland(71.001, 25.0)).toBe(false);
    });

    test('exact minLng boundary (19.0) is inside', () => {
        expect(globalThis.inFinland(60.0, 19.0)).toBe(true);
    });

    test('just below minLng is outside', () => {
        expect(globalThis.inFinland(60.0, 18.999)).toBe(false);
    });
});

