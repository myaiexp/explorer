// @vitest-environment node
// Query building + element extraction for the POI and road pools.
//
// PORTED from wander/tests/overpass-parse.test.js, which covered exactly this
// logic while it lived in the browser (fetchPOIsInRadius / fetchRoadsInRadius).
// That file is deleted with the frontend fetchers, so its 13 assertions land
// here. The annulus cases go through fetch + filterToAnnulus together, because
// that pair is what the frontend's single function did (and what lookups.ts now
// composes); the fetchers themselves cover the wide bbox and never filter.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    HIGHWAY_EXCLUDE,
    runOverpassQuery,
    type ExcludePreset,
    type OverpassElement,
} from '../src/overpass.js';
import { fetchPoisFromOverpass, fetchRoadsFromOverpass } from '../src/overpass-pools.js';
import { filterToAnnulus } from '../src/lib/pool.js';

// importOriginal keeps HIGHWAY_EXCLUDE (and the types) real — only the outbound
// call is faked, so the exclude-preset assertions test the shipped strings.
vi.mock('../src/overpass.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/overpass.js')>()),
    runOverpassQuery: vi.fn(),
}));

const CENTER = { lat: 62, lng: 25 };
const northOf = (km: number) => ({ lat: CENTER.lat + km / 111, lng: CENTER.lng });

// Roughly the wide bbox for a 5 km radius around CENTER.
const BBOX = { minLat: 61.9, minLng: 24.8, maxLat: 62.1, maxLng: 25.2 };
const BBOX_LITERAL = '61.9,24.8,62.1,25.2';

const queryMock = vi.mocked(runOverpassQuery);
const lastQuery = (): string => queryMock.mock.calls.at(-1)![0];

beforeEach(() => { queryMock.mockReset(); });

type Fixture = OverpassElement[];

async function poisFrom(
    elements: Fixture,
    { minKm = 1, maxKm = 5, filters = ['["leisure"="park"]'] } = {},
) {
    queryMock.mockResolvedValue(elements);
    const pois = await fetchPoisFromOverpass(BBOX, filters);
    return filterToAnnulus(pois, CENTER.lat, CENTER.lng, minKm, maxKm);
}

async function roadsFrom(
    elements: Fixture,
    { minKm = 1, maxKm = 5, exclude = 'default' }: {
        minKm?: number; maxKm?: number; exclude?: ExcludePreset;
    } = {},
) {
    queryMock.mockResolvedValue(elements);
    const roads = await fetchRoadsFromOverpass(BBOX, exclude);
    return filterToAnnulus(roads, CENTER.lat, CENTER.lng, minKm, maxKm);
}

describe('fetchPoisFromOverpass — element extractors + annulus', () => {
    test('a node in the annulus is kept, with tags.name', async () => {
        const p = northOf(2);
        const pois = await poisFrom([
            { type: 'node', id: 1, lat: p.lat, lon: p.lng, tags: { name: 'Central Park' } },
        ]);
        expect(pois).toEqual([{ lat: p.lat, lng: p.lng, name: 'Central Park' }]);
    });

    test('a way with center in the annulus is kept; missing name → no name field', async () => {
        const p = northOf(2);
        const pois = await poisFrom([
            { type: 'way', id: 2, center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(pois).toEqual([{ lat: p.lat, lng: p.lng }]);
        expect(pois[0]).not.toHaveProperty('name');
    });

    test('a way without center is dropped (would look like an empty Overpass result)', async () => {
        const pois = await poisFrom([{ type: 'way', id: 1, nodes: [1, 2] }]);
        expect(pois).toEqual([]);
    });

    test('a node outside the annulus (too close or too far) is dropped', async () => {
        const tooClose = northOf(0.2);
        const tooFar = northOf(10);
        const pois = await poisFrom([
            { type: 'node', id: 1, lat: tooClose.lat, lon: tooClose.lng },
            { type: 'node', id: 2, lat: tooFar.lat, lon: tooFar.lng },
        ]);
        expect(pois).toEqual([]);
    });

    test('relations and other types are ignored', async () => {
        const p = northOf(2);
        const pois = await poisFrom([
            { type: 'relation', id: 1, lat: p.lat, lon: p.lng, tags: { name: 'nope' } },
        ]);
        expect(pois).toEqual([]);
    });

    test('queries a union of node+way filters inside the bbox', async () => {
        await poisFrom([], { filters: ['["leisure"="park"]'] });
        const q = lastQuery();
        expect(q).toContain('node["leisure"="park"](');
        expect(q).toContain('way["leisure"="park"](');
        expect(q).toContain(BBOX_LITERAL);
        expect(q).toContain('out center tags;');
    });

    test('an array of filters unions every filter', async () => {
        await poisFrom([], { filters: ['["leisure"="park"]', '["amenity"="cafe"]'] });
        const q = lastQuery();
        expect(q).toContain('node["leisure"="park"](');
        expect(q).toContain('way["leisure"="park"](');
        expect(q).toContain('node["amenity"="cafe"](');
        expect(q).toContain('way["amenity"="cafe"](');
    });
});

describe('fetchRoadsFromOverpass — way.center + winter exclude', () => {
    test('a way with center in the annulus is kept', async () => {
        const p = northOf(2);
        const points = await roadsFrom([
            { type: 'way', id: 1, center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(points).toEqual([{ lat: p.lat, lng: p.lng }]);
    });

    test('a way without center is dropped', async () => {
        const points = await roadsFrom([{ type: 'way', id: 1 }]);
        expect(points).toEqual([]);
    });

    test('nodes are ignored (roads only snap way.center)', async () => {
        const p = northOf(2);
        const points = await roadsFrom([
            { type: 'node', id: 1, lat: p.lat, lon: p.lng },
        ]);
        expect(points).toEqual([]);
    });

    test('a way.center outside the annulus is dropped', async () => {
        const p = northOf(10);
        const points = await roadsFrom([
            { type: 'way', id: 1, center: { lat: p.lat, lon: p.lng } },
        ]);
        expect(points).toEqual([]);
    });

    test('the default preset is the summer highway-exclude list', async () => {
        await roadsFrom([]);
        const q = lastQuery();
        expect(q).toContain(`["highway"!~"${HIGHWAY_EXCLUDE.default}"]`);
        expect(q).not.toContain(HIGHWAY_EXCLUDE.winter);
        expect(q).toContain(BBOX_LITERAL);
        expect(q).toContain('out center;');
    });

    test('the winter preset uses the winter highway-exclude list', async () => {
        await roadsFrom([], { exclude: 'winter' });
        const q = lastQuery();
        expect(q).toContain(`["highway"!~"${HIGHWAY_EXCLUDE.winter}"]`);
        expect(q).toContain('|path|track|footway|bridleway|cycleway|pedestrian');
    });
});
