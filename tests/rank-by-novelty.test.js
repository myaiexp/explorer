/**
 * Tests for novelty.js — rankByNovelty.
 *
 * Loading: novelty.js is a non-module browser script. We load its source
 * and run it in the current realm via Node's vm module; the script's
 * explicit globalThis assignments expose the helpers.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

// novelty.js depends on the shared haversineKm from geo-utils.js, so load
// geo-utils.js into the realm first.
const GEO_SRC = readFileSync(resolve(__dirname, '../geo-utils.js'), 'utf8');
const SRC = readFileSync(resolve(__dirname, '../novelty.js'), 'utf8');

beforeAll(() => {
    new vm.Script(GEO_SRC).runInThisContext();
    new vm.Script(SRC).runInThisContext();
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
