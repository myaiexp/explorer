// @vitest-environment node
// Unit tests for junctions-cache/src/lib/parse-request.ts — /junctions query
// validation (bbox parsing/range/area caps, exclude, all-or-nothing anchors,
// start coord/maxKm caps). These used to live inline in the route handler;
// the HTTP suite in server.test.ts still proves they are wired, this file
// pins the parser in isolation.

import { describe, test, expect } from 'vitest';
import { parseJunctionsQuery, MAX_AREA_DEG2, MAX_RADIUS_KM } from '../src/lib/parse-request.js';

const OK_BBOX = '60,24,60.5,24.5';

function q(over: Record<string, string | undefined> = {}) {
    return parseJunctionsQuery({ bbox: OK_BBOX, ...over });
}

describe('bbox required + exclude + parsing', () => {
    test('missing bbox → missing bbox', () => {
        expect(parseJunctionsQuery({})).toEqual({ ok: false, error: 'missing bbox' });
    });

    test('empty bbox → missing bbox', () => {
        expect(parseJunctionsQuery({ bbox: '' })).toEqual({ ok: false, error: 'missing bbox' });
    });

    test('start params present but no bbox → still missing bbox', () => {
        const r = parseJunctionsQuery({ startLat: '60.2', startLng: '24.2', maxKm: '10' });
        expect(r).toEqual({ ok: false, error: 'missing bbox' });
    });

    test('exclude other than default|winter → error', () => {
        const r = q({ exclude: 'bogus' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/exclude must be/);
    });

    test('absent exclude defaults to "default"', () => {
        const r = q();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.exclude).toBe('default');
        expect(r.anchor).toBeNull();
    });

    test('exclude=winter is accepted', () => {
        const r = q({ exclude: 'winter' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.exclude).toBe('winter');
    });

    test('bbox with wrong component count → bbox must be …', () => {
        const r = parseJunctionsQuery({ bbox: '60,24,60.5' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/bbox must be/);
    });

    test('bbox with non-numeric components → bbox must be …', () => {
        const r = parseJunctionsQuery({ bbox: 'a,b,c,d' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/bbox must be/);
    });

    test('bbox out of range (maxLat > 90) → out of range or inverted', () => {
        const r = parseJunctionsQuery({ bbox: '0,0,91,1' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/out of range or inverted/);
    });

    test('inverted bbox (minLat ≥ maxLat) → out of range or inverted', () => {
        const r = parseJunctionsQuery({ bbox: '61,24,60,25' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/out of range or inverted/);
    });

    test('bbox area above the cap → bbox too large', () => {
        // 3°×3° = 9 deg² > MAX_AREA_DEG2 (4)
        const r = parseJunctionsQuery({ bbox: '0,0,3,3' });
        expect(r).toEqual({ ok: false, error: 'bbox too large' });
    });

    test('bbox area exactly at the cap is accepted, not "too large"', () => {
        // 2°×2° = 4 deg²
        const r = parseJunctionsQuery({ bbox: '60,24,62,26' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.bbox).toEqual({ minLat: 60, minLng: 24, maxLat: 62, maxLng: 26 });
        expect(r.bboxLog).toBe('60.0000,24.0000,62.0000,26.0000');
    });

    test('MAX_AREA_DEG2 is 4 (the comparator the area cap uses)', () => {
        expect(MAX_AREA_DEG2).toBe(4);
    });
});

describe('start-anchored validation', () => {
    const anchored = (over: Record<string, string>) =>
        q({ startLat: '60.2', startLng: '24.2', maxKm: '10', ...over });

    test('full set parses to an anchor', () => {
        const r = anchored({});
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor).toEqual({ startLat: 60.2, startLng: 24.2, maxKm: 10 });
    });

    test('non-numeric start param → invalid startLat/startLng/maxKm', () => {
        const r = anchored({ startLat: 'abc' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/invalid startLat\/startLng\/maxKm/);
    });

    test('startLat out of range (> 90) → startLat/startLng out of range', () => {
        const r = anchored({ startLat: '91' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/startLat\/startLng out of range/);
    });

    test('startLng out of range (> 180) → startLat/startLng out of range', () => {
        const r = anchored({ startLng: '181' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/startLat\/startLng out of range/);
    });

    test('maxKm = 0 → 400 (lower bound is exclusive)', () => {
        const r = anchored({ maxKm: '0' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/maxKm must be in/);
    });

    test('maxKm = MAX_RADIUS_KM (boundary) is accepted', () => {
        const r = anchored({ maxKm: String(MAX_RADIUS_KM) });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor?.maxKm).toBe(MAX_RADIUS_KM);
    });

    test('maxKm just over the cap is rejected', () => {
        const r = anchored({ maxKm: String(MAX_RADIUS_KM + 0.001) });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/maxKm must be in/);
    });

    test('MAX_RADIUS_KM is 50', () => {
        expect(MAX_RADIUS_KM).toBe(50);
    });
});

describe('partial start params → incomplete anchor', () => {
    test('only startLat names the missing startLng and maxKm', () => {
        const r = q({ startLat: '60.2' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/incomplete anchor/);
        expect(r.error).toMatch(/startLng/);
        expect(r.error).toMatch(/maxKm/);
        expect(r.error).not.toMatch(/missing startLat/);
    });

    test('only startLng names the missing startLat and maxKm', () => {
        const r = q({ startLng: '24.2' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/startLat/);
        expect(r.error).toMatch(/maxKm/);
    });

    test('only maxKm names the missing startLat and startLng', () => {
        const r = q({ maxKm: '10' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/startLat/);
        expect(r.error).toMatch(/startLng/);
    });

    test('startLat + startLng but no maxKm names the missing maxKm', () => {
        const r = q({ startLat: '60.2', startLng: '24.2' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/incomplete anchor/);
        expect(r.error).toMatch(/maxKm/);
    });

    test('partial set with an out-of-range startLat is incomplete, not a range error', () => {
        const r = q({ startLat: '999', startLng: '24.2' });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toMatch(/incomplete anchor/);
        expect(r.error).not.toMatch(/out of range/);
    });

    test('no anchor params at all → bbox mode (anchor null)', () => {
        const r = q();
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.anchor).toBeNull();
    });
});
