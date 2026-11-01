// @vitest-environment node
// The log line and JSON body every lookup route emits: the same fields on
// /junctions (anchored and bbox), /pois and /roads, with the per-route
// differences pinned — bbox mode has no `total`, the pools sample what they
// return and name the array `candidates`.

import { describe, test, expect, vi, type Mock } from 'vitest';
import { installIsolatedLifecycle, loadServer as loadIsolatedServer, post } from './helpers/isolated-app.js';
import { POOL_CAP } from '../src/lib/pool.js';
import type { OverpassElement } from '../src/overpass.js';

vi.mock('../src/overpass.js', async importOriginal => ({
    ...(await importOriginal<typeof import('../src/overpass.js')>()),
    runOverpassQuery: vi.fn(),
    fetchJunctionsFromOverpass: vi.fn(),
}));
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

async function loadServer() {
    return loadIsolatedServer(async () => {
        const overpass = await import('../src/overpass.js');
        const logMod = await import('../src/log.js');
        return {
            queryMock: overpass.runOverpassQuery as unknown as Mock,
            junctionsMock: overpass.fetchJunctionsFromOverpass as unknown as Mock,
            logMock: logMod.log as unknown as Mock,
        };
    }, 'jrespond-');
}

installIsolatedLifecycle({ fakeTimers: true });

const BBOX = '60,24,60.5,24.5';
const LOGGED_BBOX = '60.0000,24.0000,60.5000,24.5000';
// More decimals than a log line may carry: a start is usually the walker's home.
const START = { startLat: 60.2123456, startLng: 24.2654321 };
const LOGGED_START = '60.212,24.265';
const JUNCTIONS = [{ lat: 60.21, lng: 24.26 }, { lat: 60.22, lng: 24.27 }];

function lines(logMock: Mock, level: string): Record<string, unknown>[] {
    return logMock.mock.calls.filter(c => c[0] === level).map(c => c[1] as Record<string, unknown>);
}

// Roads are ways reported by their centre; POIs here are plain nodes.
function poolElements(kind: string, count: number): OverpassElement[] {
    return Array.from({ length: count }, (_, i): OverpassElement => {
        const point = { lat: START.startLat + 0.02 + i * 0.0001, lon: START.startLng };
        return kind === 'roads'
            ? { type: 'way', id: i + 1, center: point }
            : { type: 'node', id: i + 1, ...point };
    });
}

describe('anchored POST /junctions', () => {
    test('logs and returns the windowed count with the stored total', async () => {
        const { fetch, junctionsMock, logMock } = await loadServer();
        junctionsMock.mockResolvedValue([...JUNCTIONS, { lat: 61.5, lng: 24.2 }]);
        const { status, body } = await post(fetch, '/junctions', { bbox: BBOX, ...START, maxKm: 9.5 });
        expect(status).toBe(200);
        expect(body).toEqual({
            cache: 'miss',
            count: 2,
            total: 3,
            overpassMs: expect.any(Number),
            junctions: JUNCTIONS,
        });
        expect(lines(logMock, 'INFO')).toContainEqual({
            event: 'lookup',
            mode: 'anchored',
            cache: 'miss',
            start: LOGGED_START,
            maxKm: 10,
            bbox: LOGGED_BBOX,
            exclude: 'default',
            count: 2,
            total: 3,
            overpass_ms: expect.any(Number),
        });
    });

    test('a failure logs lookup_failed with the rounded start and answers 502', async () => {
        const { fetch, junctionsMock, logMock } = await loadServer();
        junctionsMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status } = await post(fetch, '/junctions', { bbox: BBOX, ...START, maxKm: 9.5 });
        expect(status).toBe(502);
        expect(lines(logMock, 'ERROR')).toContainEqual(expect.objectContaining({
            event: 'lookup_failed',
            mode: 'anchored',
            start: LOGGED_START,
            maxKm: 10,
            bbox: LOGGED_BBOX,
            exclude: 'default',
            err: 'overpass exhausted',
        }));
    });
});

describe('bbox /junctions', () => {
    test('carries no total and no start on either artifact', async () => {
        const { fetch, junctionsMock, logMock } = await loadServer();
        junctionsMock.mockResolvedValue(JUNCTIONS);
        const res = await fetch(new Request(`http://localhost/junctions?bbox=${BBOX}`));
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual({
            cache: 'miss',
            count: 2,
            overpassMs: expect.any(Number),
            junctions: JUNCTIONS,
        });
        const [line] = lines(logMock, 'INFO').filter(l => l.event === 'lookup');
        expect(line).toMatchObject({ mode: 'bbox', bbox: LOGGED_BBOX, exclude: 'default', count: 2 });
        expect(line!.total).toBeUndefined();
        expect(line).not.toHaveProperty('start');
    });

    test('a cache hit omits overpassMs from both artifacts', async () => {
        const { fetch, junctionsMock, logMock } = await loadServer();
        junctionsMock.mockResolvedValue(JUNCTIONS);
        await fetch(new Request(`http://localhost/junctions?bbox=${BBOX}`));
        logMock.mockClear();
        const res = await fetch(new Request(`http://localhost/junctions?bbox=${BBOX}`));
        const body = await res.json() as Record<string, unknown>;
        expect(body).toEqual({ cache: 'hit', count: 2, junctions: JUNCTIONS });
        const [line] = lines(logMock, 'INFO').filter(l => l.event === 'lookup');
        expect(line!.cache).toBe('hit');
        expect(line!.overpass_ms).toBeUndefined();
    });
});

describe.each([
    { path: '/pois', kind: 'pois', extra: { types: ['park'] }, select: 'park' },
    { path: '/roads', kind: 'roads', extra: { exclude: 'default' }, select: 'default' },
])('POST $path', ({ path, kind, extra, select }) => {
    const request = { ...START, minKm: 1, maxKm: 5, ...extra };

    test('count is the sampled pool, total the stored one, and the array is `candidates`', async () => {
        const { fetch, queryMock, logMock } = await loadServer();
        queryMock.mockResolvedValue(poolElements(kind, POOL_CAP + 20));
        const { status, body } = await post(fetch, path, request);
        expect(status).toBe(200);
        expect(body).toEqual({
            cache: 'miss',
            count: POOL_CAP,
            total: POOL_CAP + 20,
            overpassMs: expect.any(Number),
            candidates: expect.any(Array),
        });
        expect(body.candidates).toHaveLength(POOL_CAP);
        expect(lines(logMock, 'INFO')).toContainEqual({
            event: 'pool_lookup',
            kind,
            cache: 'miss',
            start: LOGGED_START,
            minKm: 1,
            maxKm: 5,
            select,
            count: POOL_CAP,
            total: POOL_CAP + 20,
            overpass_ms: expect.any(Number),
        });
    });

    test('a failure logs pool_lookup_failed with the rounded start and answers 502', async () => {
        const { fetch, queryMock, logMock } = await loadServer();
        queryMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status } = await post(fetch, path, request);
        expect(status).toBe(502);
        expect(lines(logMock, 'ERROR')).toContainEqual(expect.objectContaining({
            event: 'pool_lookup_failed',
            kind,
            start: LOGGED_START,
            select,
            err: 'overpass exhausted',
        }));
    });
});

test('no lookup log line carries a full-precision start', async () => {
    const { fetch, junctionsMock, queryMock, logMock } = await loadServer();
    junctionsMock.mockRejectedValue(new Error('overpass exhausted'));
    queryMock.mockRejectedValue(new Error('overpass exhausted'));
    await post(fetch, '/junctions', { bbox: BBOX, ...START, maxKm: 5 });
    await post(fetch, '/pois', { ...START, minKm: 1, maxKm: 5, types: ['park'] });
    const logged = JSON.stringify(logMock.mock.calls);
    expect(logged).not.toContain(String(START.startLat));
    expect(logged).not.toContain(String(START.startLng));
});
