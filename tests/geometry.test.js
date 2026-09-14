// @vitest-environment node
/**
 * Tests for geometry.js — pure geometry helpers extracted from app.js during the
 * god-file split (audit). These were previously untestable in isolation because
 * they lived in app.js (which touches Leaflet `L` at top level). geometry.js is a
 * non-module browser script; we run it via vm and read the helpers off globalThis.
 *
 * The helpers read globalThis.haversineKm and globalThis.kmToDegLat from
 * geo-utils.js, so geo-utils.js must load before geometry.js — helpers/load.js's
 * SCRIPT_DEPS encodes that edge, so loading 'geometry' pulls it in automatically.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    // geo-utils.js supplies haversineKm plus kmToDegLat/kmToDegLng, used inside
    // the helpers below. geometry.js does not re-alias haversineKm.
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
    // The two tests above also pass when the envelope term is dropped and both
    // sides return the plain interpolated point — which collapses every round
    // trip onto the start→dest line (finding #10113). These pin the offset itself.
    test('t=0.5 sits maxOffsetKm off the segment, on opposite sides for ±1', () => {
        // East-west segment, so the perpendicular runs due north/south.
        const [midLat, midLng] = [60, 25.1];
        const left  = globalThis.envelopeOffsetPoint(60, 25, 60, 25.2, 0.5, 1, +1);
        const right = globalThis.envelopeOffsetPoint(60, 25, 60, 25.2, 0.5, 1, -1);
        // kmToDegLat is the flat 111 km/deg projection while haversineKm uses
        // R=6371, so 1 km out comes back as ~1.002 km.
        expect(globalThis.haversineKm(midLat, midLng, left.lat, left.lng)).toBeCloseTo(1, 1);
        expect(globalThis.haversineKm(midLat, midLng, right.lat, right.lng)).toBeCloseTo(1, 1);
        expect(Math.sign(left.lat - midLat)).not.toBe(0);
        expect(Math.sign(left.lat - midLat)).toBe(-Math.sign(right.lat - midLat));
        expect(globalThis.haversineKm(left.lat, left.lng, right.lat, right.lng)).toBeCloseTo(2, 1);
    });
    test('displacement is perpendicular to A→B and scales with sin(πt)', () => {
        const [aLat, aLng, bLat, bLng] = [60, 25, 60.1, 25.1];
        const along = globalThis.bearingRad(aLat, aLng, bLat, bLng);
        for (const t of [0.25, 0.5, 0.75]) {
            // The point on the A→B segment the envelope displaces sideways.
            const lat0 = aLat + t * (bLat - aLat);
            const lng0 = aLng + t * (bLng - aLng);
            const p = globalThis.envelopeOffsetPoint(aLat, aLng, bLat, bLng, t, 1, -1);
            expect(globalThis.haversineKm(lat0, lng0, p.lat, p.lng))
                .toBeCloseTo(Math.sin(Math.PI * t), 1);
            const off = globalThis.bearingRad(lat0, lng0, p.lat, p.lng) - along;
            const rel = Math.atan2(Math.sin(off), Math.cos(off)); // wrap to (-π, π]
            expect(Math.abs(rel)).toBeCloseTo(Math.PI / 2, 1);
        }
    });
});

describe('generateRandomPointAnnulus', () => {
    test('300 samples all land within [minKm, maxKm] of the center', () => {
        const cLat = 62, cLng = 25, minKm = 1, maxKm = 3;
        for (let i = 0; i < 300; i++) {
            const p = globalThis.generateRandomPointAnnulus(cLat, cLng, minKm, maxKm);
            const d = globalThis.haversineKm(cLat, cLng, p.lat, p.lng);
            // Degree-space sampling + the 111 km/deg approximation → allow a small margin.
            expect(d).toBeGreaterThanOrEqual(minKm - 0.1);
            expect(d).toBeLessThanOrEqual(maxKm + 0.1);
        }
    });
});

describe('globalThis exports', () => {
    test('does not re-export haversineKm as calculateDistance', () => {
        // Finding #7313: the km helper has one name. A leftover alias splits
        // call sites across two vocabularies and hides half of them from search.
        expect(globalThis.calculateDistance).toBeUndefined();
        expect(typeof globalThis.haversineKm).toBe('function');
        expect(globalThis.haversineKm(60, 25, 60, 25)).toBe(0);
    });
});
