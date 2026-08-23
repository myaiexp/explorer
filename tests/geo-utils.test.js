// @vitest-environment node
/**
 * Tests for geo-utils.js — haversineKm / haversineM plus the km→degree
 * projection (kmToDegLat / kmToDegLng / bboxAround). Finding #7589: the
 * projection helpers are the single source for Overpass radius bboxes and
 * osrm.js corridor padding; overpass-parse.test.js only asserted the query
 * contains bboxAround(...) — a tautology if the 111 km/deg formula drifted.
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

describe('kmToDegLat', () => {
    test('111 km = 1 degree — the 111 km/deg convention', () => {
        // Exact: 111/111. A copied 110.5 (mean-earth) would miss this.
        expect(globalThis.kmToDegLat(111)).toBe(1);
    });
});

describe('kmToDegLng', () => {
    test('at 60°N the lng pad is 2× the lat pad (cos(60°)=0.5)', () => {
        // Same convention as junctions-cache wideBboxFromStart.
        expect(globalThis.kmToDegLng(111, 60)).toBeCloseTo(2, 10);
        expect(globalThis.kmToDegLng(10, 60)).toBeCloseTo(10 / 55.5, 10);
        expect(globalThis.kmToDegLng(10, 60) / globalThis.kmToDegLat(10))
            .toBeCloseTo(2, 10);
    });

    test('at the equator lng pad equals lat pad (cos(0°)=1)', () => {
        expect(globalThis.kmToDegLng(10, 0)).toBe(globalThis.kmToDegLat(10));
    });
});

describe('bboxAround', () => {
    test('10 km box at 60°N, 24°E matches the 111 km/deg cache convention', () => {
        // Overpass string "minLat,minLng,maxLat,maxLng", no spaces.
        // latPad = 10/111; lngPad = 10/(111·cos60°) = 10/55.5.
        const s = globalThis.bboxAround(60, 24, 10);
        expect(s.includes(' ')).toBe(false);
        const parts = s.split(',');
        expect(parts).toHaveLength(4);
        expect(Number(parts[0])).toBeCloseTo(60 - 10 / 111, 10);
        expect(Number(parts[1])).toBeCloseTo(24 - 10 / 55.5, 10);
        expect(Number(parts[2])).toBeCloseTo(60 + 10 / 111, 10);
        expect(Number(parts[3])).toBeCloseTo(24 + 10 / 55.5, 10);
    });
});
