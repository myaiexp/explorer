// @vitest-environment node
/**
 * Tests for overpass.js — the two POSTs to the server-side Overpass cache
 * (/api/junctions/pois, /api/junctions/roads).
 *
 * What used to be tested here (the 3-attempt retry loop, the status-slot probe)
 * and in overpass-parse.test.js (element extraction, the annulus filter, query
 * assembly, the HIGHWAY_EXCLUDE presets) is server-side now; its coverage lives
 * in junctions-cache/tests/overpass-pools.test.ts. What is left in the browser
 * is request shape and response normalization, which is what this file pins.
 *
 * Fake fetch, no real HTTP and no fake timers — the stub settles immediately, so
 * fetchWithTimeout's AbortController timer is cleared before it can fire.
 * SCRIPT_DEPS pulls net.js (fetchWithTimeout); tests stub global fetch under it.
 */
import { describe, test, expect, vi, beforeAll, afterEach } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse, installCannedFetch, requestOf } from './helpers/fetch-stub.js';

beforeAll(() => {
    loadScripts('overpass');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const START = { lat: 62.123456, lng: 25.654321 };

// The junctions-cache error envelope: a non-2xx status with `{ error }`.
const errStatus = (status, error = 'nope') => jsonResponse({ error }, { status });
const abortErr = () =>
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

describe('fetchPOIsInRadius — request shape', () => {
    test('fetchPOIsInRadius POSTs to /api/junctions/pois with start in the body', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']);

        const { url, init, body } = requestOf(fetchMock);
        expect(url.pathname).toBe('/api/junctions/pois');
        expect(init.method).toBe('POST');
        expect(body).toEqual({
            startLat: START.lat, startLng: START.lng, minKm: 1, maxKm: 5, types: ['park'],
        });
        // Finding #7559: a walker's start is usually their home, and nginx logs
        // the query string. It must stay empty — coords ride in the body.
        expect(url.search).toBe('');
        expect(url.href).not.toContain('62.12');
        expect(url.href).not.toContain('25.65');
    });

    test('fetchPOIsInRadius sends types "all" verbatim, not an expanded filter list', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchPOIsInRadius(START.lat, START.lng, 1, 5, 'all');

        const { init, body } = requestOf(fetchMock);
        expect(body.types).toBe('all');
        // Filter strings are the server's business — sending one would make the
        // service an arbitrary-query injection point against our own Overpass.
        expect(init.body).not.toContain('leisure');
        expect(init.body).not.toContain('amenity');
    });

    test('fetchPOIsInRadius sends an explicit key list through unchanged', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park', 'cafe']);
        expect(requestOf(fetchMock).body.types).toEqual(['park', 'cafe']);
    });

    test('a scalar catalog key is wrapped into a one-element list', async () => {
        // destination-resolve.js passes poiType.key straight through, so the
        // wrapping has to happen here or the service 400s on a bare string.
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchPOIsInRadius(START.lat, START.lng, 1, 5, 'park');
        expect(requestOf(fetchMock).body.types).toEqual(['park']);
    });
});

describe('fetchPOIsInRadius — response normalization', () => {
    test('fetchPOIsInRadius maps the response candidates array through', async () => {
        installCannedFetch(jsonResponse({
            cache: 'hit',
            count: 2,
            total: 40,
            candidates: [
                { lat: 62.2, lng: 25.1, name: 'Central Park' },
                { lat: 62.3, lng: 25.2, name: 'Kahvila' },
            ],
        }));
        const pois = await fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']);
        expect(pois).toEqual([
            { lat: 62.2, lng: 25.1, name: 'Central Park' },
            { lat: 62.3, lng: 25.2, name: 'Kahvila' },
        ]);
    });

    test('an unnamed candidate comes back with name null, not undefined', async () => {
        // The wire OMITS name on an unnamed OSM element; this function's
        // contract has always been an explicit null (session.js persists
        // destName, and an absent key is not the same row as a null one).
        installCannedFetch(jsonResponse({ candidates: [{ lat: 62.2, lng: 25.1 }] }));
        const pois = await fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']);
        expect(pois).toEqual([{ lat: 62.2, lng: 25.1, name: null }]);
        expect(Object.keys(pois[0])).toContain('name');
        expect(pois[0].name).toBeNull();
        expect(pois[0].name).not.toBeUndefined();
    });
});

describe('fetchRoadsInRadius', () => {
    test('fetchRoadsInRadius POSTs to /api/junctions/roads with start in the body', async () => {
        const fetchMock = installCannedFetch(jsonResponse({
            candidates: [{ lat: 62.2, lng: 25.1 }],
        }));
        const roads = await fetchRoadsInRadius(START.lat, START.lng, 1, 5);

        const { url, init, body } = requestOf(fetchMock);
        expect(url.pathname).toBe('/api/junctions/roads');
        expect(init.method).toBe('POST');
        expect(body.startLat).toBe(START.lat);
        expect(body.startLng).toBe(START.lng);
        expect(body.minKm).toBe(1);
        expect(body.maxKm).toBe(5);
        expect(url.search).toBe('');
        expect(roads).toEqual([{ lat: 62.2, lng: 25.1 }]);
    });

    test('fetchRoadsInRadius sends exclude "winter" when winterMode is true', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchRoadsInRadius(START.lat, START.lng, 1, 5, undefined, true);
        expect(requestOf(fetchMock).body.exclude).toBe('winter');
    });

    test('fetchRoadsInRadius sends exclude "default" when winterMode is false', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchRoadsInRadius(START.lat, START.lng, 1, 5, undefined, false);
        expect(requestOf(fetchMock).body.exclude).toBe('default');
    });

    test('winterMode defaults to the summer preset when omitted', async () => {
        const fetchMock = installCannedFetch(jsonResponse({ candidates: [] }));
        await fetchRoadsInRadius(START.lat, START.lng, 1, 5);
        expect(requestOf(fetchMock).body.exclude).toBe('default');
    });
});

// resolveCandidatePool branches on reject-vs-empty with different user-facing
// progress messages ("Overpass unavailable…" vs "No matching places found
// nearby…"). Collapsing the two here would silently retire one of them.
describe('failure vs empty', () => {
    test('a 502 rejects, so resolveCandidatePool falls back to the random pool', async () => {
        installCannedFetch(errStatus(502, 'POI search is busy. Please try again.'));
        await expect(fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']))
            .rejects.toThrow(/busy/i);
        installCannedFetch(errStatus(502));
        await expect(fetchRoadsInRadius(START.lat, START.lng, 1, 5))
            .rejects.toThrow(/busy/i);
    });

    test.each([400, 413, 500])('a %i also rejects rather than resolving empty', async (status) => {
        installCannedFetch(errStatus(status));
        await expect(fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']))
            .rejects.toThrow(Error);
    });

    test('an empty candidates array resolves to [] — the no-results branch, not the error branch', async () => {
        installCannedFetch(jsonResponse({ cache: 'hit', count: 0, total: 0, candidates: [] }));
        await expect(fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']))
            .resolves.toEqual([]);
        installCannedFetch(jsonResponse({ cache: 'hit', count: 0, total: 0, candidates: [] }));
        await expect(fetchRoadsInRadius(START.lat, START.lng, 1, 5))
            .resolves.toEqual([]);
    });

    test('a network timeout rejects rather than resolving empty', async () => {
        // fetchWithTimeout aborts a stalled request; an AbortError must reach
        // the caller, not be swallowed into an empty pool (which would read as
        // "nothing nearby" and hide a dead service).
        installCannedFetch({ throw: abortErr() });
        await expect(fetchPOIsInRadius(START.lat, START.lng, 1, 5, ['park']))
            .rejects.toThrow(/aborted/);
        installCannedFetch({ throw: abortErr() });
        await expect(fetchRoadsInRadius(START.lat, START.lng, 1, 5))
            .rejects.toThrow(/aborted/);
    });
});
