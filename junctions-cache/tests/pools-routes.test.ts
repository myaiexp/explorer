// @vitest-environment node
// POST /pois + POST /roads — the candidate-pool endpoints. Covers the wire
// contract (annulus + POOL_CAP, name presence, cache/total/count), the cache-key
// scheme (per-kind namespacing, re-sampling on a hit) and the shared guards
// (query-string anchor, body cap, unknown POI key, Overpass failure, rate limit).

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POI_FILTERS } from '../src/poi-catalog.js';
import { POOL_CAP, haversineKm } from '../src/lib/pool.js';
import { MAX_POST_BYTES } from '../src/lib/post-body.js';
import { HIGHWAY_EXCLUDE, type OverpassElement } from '../src/overpass.js';

// Both fetchers are faked: the pool routes go through runOverpassQuery, the
// junctions route through fetchJunctionsFromOverpass, and the cache-namespacing
// test needs to tell the two apart. importOriginal keeps HIGHWAY_EXCLUDE real.
vi.mock('../src/overpass.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/overpass.js')>()),
    runOverpassQuery: vi.fn(),
    fetchJunctionsFromOverpass: vi.fn(),
}));
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const tmpDirs: string[] = [];
function tmpCacheFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jpool-'));
    tmpDirs.push(dir);
    return join(dir, 'cache.json');
}

type FetchFn = (req: Request) => Promise<Response>;

async function loadServer() {
    vi.resetModules();
    process.env.CACHE_PATH = tmpCacheFile();
    const overpass = await import('../src/overpass.js');
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    return {
        fetch: app.fetch as FetchFn,
        queryMock: overpass.runOverpassQuery as unknown as Mock,
        junctionsMock: overpass.fetchJunctionsFromOverpass as unknown as Mock,
    };
}

async function post(
    fetch: FetchFn,
    path: string,
    body: unknown,
    raw?: string,
): Promise<{ status: number; body: any }> {
    const res = await fetch(new Request('http://localhost' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => {
    vi.useRealTimers();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The Overpass query string the route built for its (single) outbound call.
function firstQuery(queryMock: Mock): string {
    return queryMock.mock.calls[0]![0] as string;
}

const START = { startLat: 60.2, startLng: 24.2 };
const ANCHOR = { ...START, minKm: 1, maxKm: 5 };
const POI_BODY = { ...ANCHOR, types: ['park'] };

// km north of the start — the annulus is measured from it.
function northOf(km: number) {
    return { lat: START.startLat + km / 111, lng: START.startLng };
}
function node(km: number, name?: string): OverpassElement {
    const p = northOf(km);
    return { type: 'node', id: Math.round(km * 1000), lat: p.lat, lon: p.lng, ...(name ? { tags: { name } } : {}) };
}
function way(km: number): OverpassElement {
    const p = northOf(km);
    return { type: 'way', id: Math.round(km * 1000) + 1, center: { lat: p.lat, lon: p.lng } };
}
function spread(
    count: number,
    minKm: number,
    maxKm: number,
    build: (km: number) => OverpassElement = node,
): OverpassElement[] {
    const step = (maxKm - minKm) / (count + 1);
    return Array.from({ length: count }, (_, i) => build(minKm + step * (i + 1)));
}

describe('POST /pois', () => {
    test('returns candidates filtered to the annulus and capped at POOL_CAP', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([
            ...spread(50, 1.5, 4.5),
            node(0.2),   // inside the fetched bbox, inside minKm
            node(8),     // inside the fetched bbox, past maxKm
        ]);
        const { status, body } = await post(fetch, '/pois', POI_BODY);
        expect(status).toBe(200);
        expect(body.total).toBe(50);
        expect(body.count).toBe(POOL_CAP);
        expect(body.candidates).toHaveLength(POOL_CAP);
        for (const p of body.candidates) {
            const d = haversineKm(START.startLat, START.startLng, p.lat, p.lng);
            expect(d).toBeGreaterThanOrEqual(1);
            expect(d).toBeLessThanOrEqual(5);
        }
    });

    test('candidates carry name when the OSM element is named, and omit it otherwise', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(2, 'Kaivopuisto'), way(3)]);
        const { body } = await post(fetch, '/pois', POI_BODY);
        expect(body.count).toBe(2);
        const named = body.candidates.find((p: any) => p.name);
        const unnamed = body.candidates.find((p: any) => !p.name);
        expect(named.name).toBe('Kaivopuisto');
        expect(unnamed).not.toHaveProperty('name');
    });

    test('types "all" queries the full catalog union', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([]);
        await post(fetch, '/pois', { ...ANCHOR, types: 'all' });
        const query = firstQuery(queryMock);
        for (const filter of Object.values(POI_FILTERS)) {
            expect(query).toContain(`node${filter}(`);
            expect(query).toContain(`way${filter}(`);
        }
    });

    test('a second request from the same start hits the cache', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(2)]);
        const first = await post(fetch, '/pois', POI_BODY);
        const second = await post(fetch, '/pois', POI_BODY);
        expect(first.body.cache).toBe('miss');
        expect(second.body.cache).toBe('hit');
        expect(second.body.overpassMs).toBeUndefined();
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    test('a different maxKm keys separately', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(2)]);
        const first = await post(fetch, '/pois', POI_BODY);
        const second = await post(fetch, '/pois', { ...POI_BODY, maxKm: 9 });
        expect(first.body.cache).toBe('miss');
        expect(second.body.cache).toBe('miss');
        expect(queryMock).toHaveBeenCalledTimes(2);
    });

    test('a different minKm keys separately (the cached set is annulus-filtered)', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(0.5), node(2)]);
        const wide = await post(fetch, '/pois', { ...POI_BODY, minKm: 0 });
        const narrow = await post(fetch, '/pois', POI_BODY);
        expect(wide.body.total).toBe(2);
        // Same start and same ceil(maxKm) bucket, but a set filtered to [1,5] km
        // cannot answer a [0,5] km request — so it must be its own entry.
        expect(narrow.body.cache).toBe('miss');
        expect(narrow.body.total).toBe(1);
        expect(queryMock).toHaveBeenCalledTimes(2);
    });

    test('the same keys in a different order hit the same entry', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(2)]);
        const first = await post(fetch, '/pois', { ...ANCHOR, types: ['park', 'cafe'] });
        const second = await post(fetch, '/pois', { ...ANCHOR, types: ['cafe', 'park'] });
        expect(first.body.cache).toBe('miss');
        expect(second.body.cache).toBe('hit');
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    test('a cached POI set is re-sampled per request, not frozen', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue(spread(250, 1.5, 4.5));
        const first = await post(fetch, '/pois', POI_BODY);
        expect(first.body.total).toBe(250);
        const head = JSON.stringify(first.body.candidates[0]);
        let differed = false;
        for (let i = 0; i < 8; i++) {
            const again = await post(fetch, '/pois', POI_BODY);
            expect(again.body.cache).toBe('hit');
            expect(again.body.total).toBe(250);
            if (JSON.stringify(again.body.candidates[0]) !== head) differed = true;
        }
        expect(differed).toBe(true);
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    test('an unknown POI key → 400 with a reason, and no Overpass call', async () => {
        const { fetch, queryMock } = await loadServer();
        const { status, body } = await post(fetch, '/pois', { ...ANCHOR, types: ['park', 'casino'] });
        expect(status).toBe(400);
        expect(body.error).toMatch(/unknown POI type\(s\): casino/);
        expect(queryMock).not.toHaveBeenCalled();
    });

    test('an empty Overpass result is a 200 with no candidates, not a failure', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([]);
        const { status, body } = await post(fetch, '/pois', POI_BODY);
        expect(status).toBe(200);
        expect(body.candidates).toEqual([]);
        expect(body.count).toBe(0);
        expect(body.total).toBe(0);
    });

    test('an Overpass failure → 502 with the busy message', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status, body } = await post(fetch, '/pois', POI_BODY);
        expect(status).toBe(502);
        expect(body.error).toBe('POI search is busy. Please try again.');
    });

    test('a body over MAX_POST_BYTES → 413 before parsing', async () => {
        const { fetch, queryMock } = await loadServer();
        const fat = { ...POI_BODY, pad: 'x'.repeat(MAX_POST_BYTES + 1000) };
        const { status, body } = await post(fetch, '/pois', fat);
        expect(status).toBe(413);
        expect(body.error).toMatch(/too large/);
        expect(queryMock).not.toHaveBeenCalled();
    });

    test('startLat on the query string → 400 (coords belong in the body)', async () => {
        const { fetch, queryMock } = await loadServer();
        const { status, body } = await post(fetch, '/pois?startLat=60.2', POI_BODY);
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('POST /roads', () => {
    test('returns way centroids in the annulus, capped at POOL_CAP', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([...spread(50, 1.5, 4.5, way), way(8), node(2)]);
        const { status, body } = await post(fetch, '/roads', ANCHOR);
        expect(status).toBe(200);
        // Nodes are not road candidates, and the 8 km way is past maxKm.
        expect(body.total).toBe(50);
        expect(body.count).toBe(POOL_CAP);
        for (const p of body.candidates) {
            const d = haversineKm(START.startLat, START.startLng, p.lat, p.lng);
            expect(d).toBeGreaterThanOrEqual(1);
            expect(d).toBeLessThanOrEqual(5);
        }
    });

    test('the winter exclude preset reaches the query', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([]);
        await post(fetch, '/roads', { ...ANCHOR, exclude: 'winter' });
        const query = firstQuery(queryMock);
        expect(query).toContain(`["highway"!~"${HIGHWAY_EXCLUDE.winter}"]`);
    });

    test('an Overpass failure → 502 with the busy message', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status, body } = await post(fetch, '/roads', ANCHOR);
        expect(status).toBe(502);
        expect(body.error).toBe('POI search is busy. Please try again.');
    });

    test('startLat on the query string → 400 (coords belong in the body)', async () => {
        const { fetch, queryMock } = await loadServer();
        const { status, body } = await post(fetch, '/roads?startLat=60.2', ANCHOR);
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(queryMock).not.toHaveBeenCalled();
    });
});

describe('cache-key namespacing across query kinds', () => {
    test('/roads and /junctions from the same start+exclude do not share an entry', async () => {
        const { fetch, queryMock, junctionsMock } = await loadServer();
        const road = northOf(2);
        const junction = northOf(3);
        queryMock.mockResolvedValue([{ type: 'way', id: 1, center: { lat: road.lat, lon: road.lng } }]);
        junctionsMock.mockResolvedValue([{ lat: junction.lat, lng: junction.lng }]);

        const roads = await post(fetch, '/roads', { ...ANCHOR, exclude: 'default' });
        const junctions = await post(fetch, '/junctions', {
            bbox: '60.1,24.1,60.3,24.3',
            startLat: START.startLat,
            startLng: START.startLng,
            maxKm: 5,
            exclude: 'default',
        });

        expect(roads.body.cache).toBe('miss');
        expect(roads.body.candidates).toEqual([{ lat: road.lat, lng: road.lng }]);
        // A shared key would have served the road centroids here as a 'hit'.
        expect(junctions.body.cache).toBe('miss');
        expect(junctions.body.junctions).toEqual([{ lat: junction.lat, lng: junction.lng }]);
        expect(junctionsMock).toHaveBeenCalledTimes(1);
    });
});

describe('per-IP rate limiting', () => {
    test('both pool endpoints 429 past their budget', async () => {
        const { fetch, queryMock } = await loadServer();
        queryMock.mockResolvedValue([node(2)]);
        const poiStatuses: number[] = [];
        for (let i = 0; i < 61; i++) poiStatuses.push((await post(fetch, '/pois', POI_BODY)).status);
        expect(poiStatuses.slice(0, 60).every(s => s === 200)).toBe(true);
        expect(poiStatuses[60]).toBe(429);

        // Its own bucket, so an exhausted /pois budget does not spend /roads'.
        const roadStatuses: number[] = [];
        for (let i = 0; i < 61; i++) roadStatuses.push((await post(fetch, '/roads', ANCHOR)).status);
        expect(roadStatuses.slice(0, 60).every(s => s === 200)).toBe(true);
        expect(roadStatuses[60]).toBe(429);
    });
});
