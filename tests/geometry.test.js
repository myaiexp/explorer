// @vitest-environment node
/**
 * Tests for geometry.js — pure geometry helpers extracted from app.js during the
 * god-file split (audit). These were previously untestable in isolation because
 * they lived in app.js (which touches Leaflet `L` at top level). geometry.js is a
 * non-module browser script; we run it via vm and read the helpers off globalThis.
 *
 * calculateDistance aliases globalThis.haversineKm (geo-utils.js in the browser),
 * and the helpers now read globalThis.kmToDegLat for the km→degree projection, so
 * geo-utils.js must load before geometry.js — helpers/load.js's SCRIPT_DEPS
 * encodes that edge, so loading 'geometry' pulls it in automatically.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    // geo-utils.js supplies haversineKm (the calculateDistance alias geometry.js
    // reads at load) plus kmToDegLat/kmToDegLng, used inside the helpers below.
    loadScripts('geometry');
});

describe('computeSpreadParams', () => {
    test('quadratic curve: 0 → 0.03, 50 → 0.1225, 100 → 0.40', () => {
        expect(globalThis.computeSpreadParams(0).offsetMult).toBeCloseTo(0.03, 6);
        expect(globalThis.computeSpreadParams(50).offsetMult).toBeCloseTo(0.1225, 6);
        expect(globalThis.computeSpreadParams(100).offsetMult).toBeCloseTo(0.40, 6);
    });
    test('always returns the three fixed via t-positions', () => {
        expect(globalThis.computeSpreadParams(37).viaTs).toEqual([0.25, 0.5, 0.75]);
    });
    test('non-finite input falls back to the 50% params', () => {
        expect(globalThis.computeSpreadParams(NaN).offsetMult).toBeCloseTo(0.1225, 6);
        expect(globalThis.computeSpreadParams(undefined).offsetMult).toBeCloseTo(0.1225, 6);
    });
});

describe('bearingRad', () => {
    test('due north ≈ 0 rad', () => {
        expect(globalThis.bearingRad(60, 25, 61, 25)).toBeCloseTo(0, 6);
    });
    test('due east ≈ +π/2 rad', () => {
        expect(globalThis.bearingRad(0, 0, 0, 1)).toBeCloseTo(Math.PI / 2, 6);
    });
});

describe('envelopeOffsetPoint', () => {
    test('endpoints (t=0, t=1) sit exactly on A and B (zero envelope)', () => {
        const a = globalThis.envelopeOffsetPoint(60, 25, 60.1, 25.1, 0, 1, -1);
        expect(a.lat).toBeCloseTo(60, 6);
        expect(a.lng).toBeCloseTo(25, 6);
        const b = globalThis.envelopeOffsetPoint(60, 25, 60.1, 25.1, 1, 1, -1);
        expect(b.lat).toBeCloseTo(60.1, 6);
        expect(b.lng).toBeCloseTo(25.1, 6);
    });
    test('opposite sides are symmetric about the segment midpoint', () => {
        // Midpoint of (60,25)→(60,25.2) is (60, 25.1); the two side offsets are
        // equal and opposite, so their average returns to the midpoint exactly.
        const left  = globalThis.envelopeOffsetPoint(60, 25, 60, 25.2, 0.5, 1, +1);
        const right = globalThis.envelopeOffsetPoint(60, 25, 60, 25.2, 0.5, 1, -1);
        expect((left.lat + right.lat) / 2).toBeCloseTo(60, 6);
        expect((left.lng + right.lng) / 2).toBeCloseTo(25.1, 6);
    });
});

describe('generateRandomPointAnnulus', () => {
    test('300 samples all land within [minKm, maxKm] of the center', () => {
        const cLat = 62, cLng = 25, minKm = 1, maxKm = 3;
        for (let i = 0; i < 300; i++) {
            const p = globalThis.generateRandomPointAnnulus(cLat, cLng, minKm, maxKm);
            const d = globalThis.calculateDistance(cLat, cLng, p.lat, p.lng);
            // Degree-space sampling + the 111 km/deg approximation → allow a small margin.
            expect(d).toBeGreaterThanOrEqual(minKm - 0.1);
            expect(d).toBeLessThanOrEqual(maxKm + 0.1);
        }
    });
});

describe('globalThis exports', () => {
    test('calculateDistance is wired to haversineKm (0 for identical points)', () => {
        expect(typeof globalThis.calculateDistance).toBe('function');
        expect(globalThis.calculateDistance(60, 25, 60, 25)).toBe(0);
    });
});
