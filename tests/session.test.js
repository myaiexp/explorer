// @vitest-environment node
/**
 * Tests for session.js — computeRouteTotals, routeSessionFields, snapshotSession.
 *
 * session.js is a non-module browser script, loaded via helpers/load.js's
 * loadScripts('session') and read the pure helpers off globalThis (same
 * harness as geometry/route-dispatch tests). snapshotSession uses
 * crypto.randomUUID() + new Date(), both Node globals.
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
    loadScripts('session');
});

describe('computeRouteTotals', () => {
    const OUT = { distance: 6000, duration: 3600 };
    const RET = { distance: 5000, duration: 3000 };

    test('round-trip with both legs: per-leg km + summed duration', () => {
        const t = globalThis.computeRouteTotals(OUT, RET, 5, 'round');
        expect(t).toEqual({ outKm: 6, retKm: 5, totalWalkKm: 11, totalDuration: 6600 });
    });

    // The bug fix: a one-way trip has no return leg, so retKm is 0 — NOT the
    // straight-line fallback. displayRoute's old inlined copy omitted this guard
    // and double-counted one-way distance (out + straight). This test is RED
    // against that old behavior.
    test('one-way: absent return leg contributes 0, never the straight-line', () => {
        const t = globalThis.computeRouteTotals(OUT, null, 5, 'one-way');
        expect(t.retKm).toBe(0);
        expect(t.totalWalkKm).toBe(6);
        expect(t.totalDuration).toBe(3600);
    });

    test('round-trip with a failed return leg falls back to straight-line', () => {
        const t = globalThis.computeRouteTotals(OUT, null, 5, 'round');
        expect(t.retKm).toBe(5);
        expect(t.totalWalkKm).toBe(11);
    });

    test('both legs missing (round-trip): both fall back to straight-line', () => {
        const t = globalThis.computeRouteTotals(null, null, 5, 'round');
        expect(t).toEqual({ outKm: 5, retKm: 5, totalWalkKm: 10, totalDuration: 0 });
    });
});

describe('routeSessionFields', () => {
    test('maps both legs, converting metres to km', () => {
        const out = { coords: [[1, 2]], distance: 6000, duration: 3600, steps: ['a'] };
        const ret = { coords: [[3, 4]], distance: 5000, duration: 3000, steps: ['b'] };
        expect(globalThis.routeSessionFields(out, ret)).toEqual({
            routeCoords: [[1, 2]], routeDistance: 6, routeDuration: 3600, routeSteps: ['a'],
            returnRouteCoords: [[3, 4]], returnRouteDistance: 5, returnRouteDuration: 3000, returnRouteSteps: ['b'],
        });
    });

    test('missing legs → all eight fields null (one-way / no route)', () => {
        expect(globalThis.routeSessionFields(null, null)).toEqual({
            routeCoords: null, routeDistance: null, routeDuration: null, routeSteps: null,
            returnRouteCoords: null, returnRouteDistance: null, returnRouteDuration: null, returnRouteSteps: null,
        });
    });
});

describe('snapshotSession', () => {
    const session = {
        startLat: 60, startLng: 24, startLabel: 'home',
        destLat: 61, destLng: 25, destName: 'Lake', tripMode: 'round', distance: 4.2,
        routeCoords: [[1, 2]], routeDistance: 2, routeDuration: 1200,
        returnRouteCoords: [[3, 4]], returnRouteDistance: 2.2, returnRouteDuration: 1300,
        // steps live on the session but must NOT be persisted:
        routeSteps: ['x'], returnRouteSteps: ['y'],
    };

    test('stamps a fresh uuid id + ISO date', () => {
        const row = globalThis.snapshotSession(session);
        expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
        expect(new Date(row.date).toISOString()).toBe(row.date);
    });

    test('copies the fourteen shared trip fields', () => {
        const row = globalThis.snapshotSession(session);
        for (const k of ['startLat', 'startLng', 'startLabel', 'destLat', 'destLng',
            'destName', 'tripMode', 'distance', 'routeCoords', 'routeDistance',
            'routeDuration', 'returnRouteCoords', 'returnRouteDistance', 'returnRouteDuration']) {
            expect(row[k]).toEqual(session[k]);
        }
    });

    test('omits route steps — only the live session carries them (for FIT export)', () => {
        const row = globalThis.snapshotSession(session);
        expect('routeSteps' in row).toBe(false);
        expect('returnRouteSteps' in row).toBe(false);
    });

    test('extras spread on top (poiCategory for visits)', () => {
        const row = globalThis.snapshotSession(session, { poiCategory: 'nature' });
        expect(row.poiCategory).toBe('nature');
    });

    // Distances use ?? (0 is a real value); durations/coords use || (0/'' → null).
    // Guards the exact normalization the three call sites relied on.
    test('?? preserves a zero distance; || coerces a zero duration to null', () => {
        const row = globalThis.snapshotSession({
            ...session, routeDistance: 0, routeDuration: 0, returnRouteDistance: 0,
            destName: '', routeCoords: null,
        });
        expect(row.routeDistance).toBe(0);
        expect(row.returnRouteDistance).toBe(0);
        expect(row.routeDuration).toBeNull();
        expect(row.destName).toBeNull();
        expect(row.routeCoords).toBeNull();
    });
});
