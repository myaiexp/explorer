// @vitest-environment node
/**
 * Tests for overpass.js POI/road element extractors — node vs way.center,
 * annulus distance filter, winter exclude (finding #7065). Retry coverage
 * lives in overpass.test.js.
 */
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { loadScripts } from './helpers/load.js';
import {
    CENTER, okJson, installFetch, northOf, settle,
} from './helpers/overpass-fetch.js';

beforeAll(() => {
    loadScripts('overpass');
});

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('fetchPOIsInRadius — element extractors + annulus', () => {
    async function poisFrom(elements, { minKm = 1, maxKm = 5, filter = '["leisure"="park"]' } = {}) {
        const fetchMock = installFetch({ interpreter: [okJson({ elements })] });
        const { v, e } = await settle(
            fetchPOIsInRadius(CENTER.lat, CENTER.lng, minKm, maxKm, filter),
        );
        expect(e).toBeUndefined();
        return { pois: v, fetchMock };
    }

    test('a node in the annulus is kept, with tags.name', async () => {
        const p = northOf(2);
        const { pois } = await poisFrom([
            { type: 'node', lat: p.lat, lon: p.lng, tags: { name: 'Central Park' } },
        ]);
        expect(pois).toEqual([{ lat: p.lat, lng: p.lng, name: 'Central Park' }]);
    });

    test('a way with center in the annulus is kept; missing name → null', async () => {
        const p = northOf(2);
        const { pois } = await poisFrom([
            { type: 'way', center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(pois).toEqual([{ lat: p.lat, lng: p.lng, name: null }]);
    });

    test('a way without center is dropped (would look like an empty Overpass result)', async () => {
        const { pois } = await poisFrom([{ type: 'way', id: 1, nodes: [1, 2] }]);
        expect(pois).toEqual([]);
    });

    test('a node outside the annulus (too close or too far) is dropped', async () => {
        const tooClose = northOf(0.2);
        const tooFar = northOf(10);
        const { pois } = await poisFrom([
            { type: 'node', lat: tooClose.lat, lon: tooClose.lng },
            { type: 'node', lat: tooFar.lat, lon: tooFar.lng },
        ]);
        expect(pois).toEqual([]);
    });

    test('relations and other types are ignored', async () => {
        const p = northOf(2);
        const { pois } = await poisFrom([
            { type: 'relation', lat: p.lat, lon: p.lng, tags: { name: 'nope' } },
        ]);
        expect(pois).toEqual([]);
    });

    test('POSTs a union of node+way filters inside the bbox', async () => {
        const { fetchMock } = await poisFrom([], { filter: '["leisure"="park"]' });
        const decoded = decodeURIComponent(fetchMock.mock.calls[0][1].body);
        expect(decoded).toContain(`node["leisure"="park"](`);
        expect(decoded).toContain(`way["leisure"="park"](`);
        expect(decoded).toContain(bboxAround(CENTER.lat, CENTER.lng, 5));
    });

    test('an array of filters unions every filter', async () => {
        const fetchMock = installFetch({ interpreter: [okJson({ elements: [] })] });
        const { e } = await settle(fetchPOIsInRadius(
            CENTER.lat, CENTER.lng, 1, 5,
            ['["leisure"="park"]', '["amenity"="cafe"]'],
        ));
        expect(e).toBeUndefined();
        const decoded = decodeURIComponent(fetchMock.mock.calls[0][1].body);
        expect(decoded).toContain('["leisure"="park"]');
        expect(decoded).toContain('["amenity"="cafe"]');
    });
});

describe('fetchRoadsInRadius — way.center + winter exclude', () => {
    async function roadsFrom(elements, { winterMode = false, minKm = 1, maxKm = 5 } = {}) {
        const fetchMock = installFetch({ interpreter: [okJson({ elements })] });
        const { v, e } = await settle(
            fetchRoadsInRadius(CENTER.lat, CENTER.lng, minKm, maxKm, undefined, winterMode),
        );
        expect(e).toBeUndefined();
        return { points: v, fetchMock };
    }

    test('a way with center in the annulus is kept', async () => {
        const p = northOf(2);
        const { points } = await roadsFrom([
            { type: 'way', center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(points).toEqual([{ lat: p.lat, lng: p.lng }]);
    });

    test('a way without center is dropped', async () => {
        const { points } = await roadsFrom([{ type: 'way', id: 1 }]);
        expect(points).toEqual([]);
    });

    test('nodes are ignored (roads only snap way.center)', async () => {
        const p = northOf(2);
        const { points } = await roadsFrom([
            { type: 'node', lat: p.lat, lon: p.lng },
        ]);
        expect(points).toEqual([]);
    });

    test('a way.center outside the annulus is dropped', async () => {
        const p = northOf(10);
        const { points } = await roadsFrom([
            { type: 'way', center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(points).toEqual([]);
    });

    test('default highway-exclude is the summer preset', async () => {
        const { fetchMock } = await roadsFrom([]);
        const decoded = decodeURIComponent(fetchMock.mock.calls[0][1].body);
        expect(decoded).toContain(`["highway"!~"${HIGHWAY_EXCLUDE_DEFAULT}"]`);
        expect(decoded).not.toContain(HIGHWAY_EXCLUDE_WINTER);
    });

    test('winterMode uses the winter highway-exclude list', async () => {
        const { fetchMock } = await roadsFrom([], { winterMode: true });
        const decoded = decodeURIComponent(fetchMock.mock.calls[0][1].body);
        expect(decoded).toContain(`["highway"!~"${HIGHWAY_EXCLUDE_WINTER}"]`);
        expect(decoded).toContain('|path|track|footway|bridleway|cycleway|pedestrian');
    });
});
