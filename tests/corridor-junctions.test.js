/**
 * Tests for fetchCorridorJunctions (osrm.js) — the start-anchored junction
 * cache fetch.
 *
 * Loading: loadScripts('osrm') evaluates the production module with its real
 * SCRIPT_DEPS (net, geometry, loop-quality → geo-utils), the same way
 * osrm.test.js does, and the tests drive the globalThis.fetchCorridorJunctions
 * it exports. fetchWithTimeout is the real one: it calls the per-test fake
 * `fetch` and clears its abort timer once the fake resolves.
 *
 * Guards two invariants:
 *   - audit #1268: maxKm is an explicit parameter, NOT read from the DOM.
 *   - finding #7559: start/radius travel in the POST body, never the query
 *     string, so nginx access logs cannot persist home-precision coordinates.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse, installCannedFetch, requestOf } from './helpers/fetch-stub.js';

let fetchCorridorJunctions;

beforeAll(() => {
    loadScripts('osrm');
    fetchCorridorJunctions = globalThis.fetchCorridorJunctions;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** Every fetch answers 200 with this junction list. */
function installJunctionsFetch(junctions = [{ lat: 60.2, lng: 24.9 }]) {
    return installCannedFetch(jsonResponse({ junctions }));
}

/** requestOf's parsed body, after pinning that it was sent as a JSON POST. */
function bodyOf(fetchMock) {
    const { init, body } = requestOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(String(init.headers?.['content-type'] || init.headers?.['Content-Type']))
        .toMatch(/application\/json/i);
    return body;
}

describe('fetchCorridorJunctions', () => {
    test('POSTs start/radius in the JSON body, never on the query string', async () => {
        const f = installJunctionsFetch();
        const out = await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, false);

        const { url } = requestOf(f);
        expect(url.pathname).toBe('/api/junctions/junctions');
        expect(url.search).toBe('');
        expect(url.searchParams.has('startLat')).toBe(false);
        expect(url.searchParams.has('startLng')).toBe(false);
        expect(url.searchParams.has('maxKm')).toBe(false);

        const body = bodyOf(f);
        expect(body.maxKm).toBe(7);
        expect(body.startLat).toBe(60);
        expect(body.startLng).toBe(24);
        expect(body.exclude).toBe('default');
        expect(body.bbox).toBeTruthy();
        expect(out).toEqual([{ lat: 60.2, lng: 24.9 }]);
    });

    test('winterMode selects the winter exclude preset', async () => {
        const f = installJunctionsFetch([]);
        await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, true);
        expect(bodyOf(f).exclude).toBe('winter');
    });

    // (b) no DOM read — the helper must never touch document. Reverting to
    //     parseFloat(document.getElementById('maxDistance').value) makes this RED
    //     (both via the getElementById spy and the null.value throw).
    test('reads no DOM element — works with no #maxDistance present', async () => {
        expect(document.getElementById('maxDistance')).toBeNull(); // precondition
        const spy = vi.spyOn(document, 'getElementById');
        const f = installJunctionsFetch();

        await expect(
            fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 9, null, false)
        ).resolves.toEqual([{ lat: 60.2, lng: 24.9 }]);

        expect(spy).not.toHaveBeenCalled();
        expect(bodyOf(f).maxKm).toBe(9);
    });

    // Guard: a missing/invalid budget drops to legacy bbox mode (no anchoring).
    test('omitted/NaN maxKm → POST body has bbox but no start/radius', async () => {
        const f = installJunctionsFetch();
        await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, NaN, null, false);

        const { url } = requestOf(f);
        expect(url.search).toBe('');
        const body = bodyOf(f);
        expect(body.maxKm).toBeUndefined();
        expect(body.startLat).toBeUndefined();
        expect(body.startLng).toBeUndefined();
        expect(body.bbox).toBeTruthy();
    });

    test('throws a friendly error on non-ok response', async () => {
        installCannedFetch(jsonResponse({}, { status: 502 }));
        await expect(
            fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, false)
        ).rejects.toThrow(/try again/i);
    });
});
