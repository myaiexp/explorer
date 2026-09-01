// @vitest-environment node
// Tests for src/lib/parse-pool-request.ts — /pois and /roads body validation.

import { describe, test, expect } from 'vitest';
import { parsePoiRequest, parseRoadRequest } from '../src/lib/parse-pool-request.js';
import { MAX_RADIUS_KM } from '../src/lib/parse-request.js';

const START = { startLat: 62.24, startLng: 25.75 };
const poi = (over: Record<string, unknown> = {}) =>
    parsePoiRequest({ ...START, maxKm: 4, types: 'all', ...over });
const road = (over: Record<string, unknown> = {}) =>
    parseRoadRequest({ ...START, maxKm: 4, ...over });

describe('parsePoiRequest', () => {
    test('accepts a well-formed body', () => {
        const r = poi();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor).toEqual({ startLat: 62.24, startLng: 25.75, minKm: 0, maxKm: 4 });
        expect(r.types).toBe('all');
    });

    test('accepts numbers or numeric strings for the anchor', () => {
        const r = parsePoiRequest({ startLat: '62.24', startLng: '25.75', maxKm: '4', minKm: '1', types: ['cafe'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor).toEqual({ startLat: 62.24, startLng: 25.75, minKm: 1, maxKm: 4 });
    });

    // minKm defaults to 0; maxKm is required. Unlike the junctions anchor, bbox
    // is not part of the request at all — the server derives it.
    test('minKm defaults to 0 when absent', () => {
        const r = poi();
        expect(r.ok && r.anchor.minKm).toBe(0);
    });

    test('rejects a missing start', () => {
        expect(parsePoiRequest({ maxKm: 4, types: 'all' }).ok).toBe(false);
        expect(poi({ startLat: undefined }).ok).toBe(false);
        expect(poi({ startLng: null }).ok).toBe(false);
    });

    test('rejects a missing maxKm', () => {
        expect(parsePoiRequest({ ...START, types: 'all' }).ok).toBe(false);
    });

    test('rejects a non-numeric anchor field', () => {
        expect(poi({ maxKm: 'lots' }).ok).toBe(false);
        expect(poi({ startLat: {} }).ok).toBe(false);
        expect(poi({ startLat: NaN }).ok).toBe(false);
    });

    test('rejects a start outside coordinate range', () => {
        expect(poi({ startLat: 91 }).ok).toBe(false);
        expect(poi({ startLng: -181 }).ok).toBe(false);
    });

    test('rejects minKm >= maxKm', () => {
        expect(poi({ minKm: 4, maxKm: 4 }).ok).toBe(false);
        expect(poi({ minKm: 5, maxKm: 4 }).ok).toBe(false);
    });

    test('rejects a negative minKm', () => {
        expect(poi({ minKm: -1 }).ok).toBe(false);
    });

    test('rejects maxKm at or below zero', () => {
        expect(poi({ maxKm: 0 }).ok).toBe(false);
        expect(poi({ maxKm: -3 }).ok).toBe(false);
    });

    test('rejects maxKm above MAX_RADIUS_KM', () => {
        expect(poi({ maxKm: MAX_RADIUS_KM + 0.1 }).ok).toBe(false);
        expect(poi({ maxKm: MAX_RADIUS_KM }).ok).toBe(true);
    });

    test('rejects an unknown POI key', () => {
        const r = poi({ types: ['nope'] });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toContain('nope');
    });

    test('rejects an empty types array', () => {
        expect(poi({ types: [] }).ok).toBe(false);
    });

    test('rejects missing types', () => {
        expect(parsePoiRequest({ ...START, maxKm: 4 }).ok).toBe(false);
    });

    test("accepts the string 'all'", () => {
        const r = poi({ types: 'all' });
        expect(r.ok && r.types).toBe('all');
    });

    test('accepts an explicit key list', () => {
        const r = poi({ types: ['cafe', 'park'] });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.types).toEqual(['cafe', 'park']);
    });

    test('rejects a non-object body', () => {
        expect(parsePoiRequest(null).ok).toBe(false);
        expect(parsePoiRequest('cafe').ok).toBe(false);
        expect(parsePoiRequest([1, 2]).ok).toBe(false);
    });
});

describe('parseRoadRequest', () => {
    test('accepts a well-formed body', () => {
        const r = road();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor).toEqual({ startLat: 62.24, startLng: 25.75, minKm: 0, maxKm: 4 });
    });

    test('defaults exclude to "default" when absent', () => {
        const r = road();
        expect(r.ok && r.exclude).toBe('default');
    });

    test('accepts the winter preset', () => {
        const r = road({ exclude: 'winter' });
        expect(r.ok && r.exclude).toBe('winter');
    });

    test('rejects an exclude that is neither default nor winter', () => {
        expect(road({ exclude: 'summer' }).ok).toBe(false);
        expect(road({ exclude: 7 }).ok).toBe(false);
    });

    test('applies the same anchor validation as /pois', () => {
        expect(road({ minKm: 9, maxKm: 4 }).ok).toBe(false);
        expect(road({ maxKm: MAX_RADIUS_KM + 1 }).ok).toBe(false);
        expect(parseRoadRequest({ maxKm: 4 }).ok).toBe(false);
    });

    test('rejects a non-object body', () => {
        expect(parseRoadRequest(null).ok).toBe(false);
        expect(parseRoadRequest([]).ok).toBe(false);
    });
});
