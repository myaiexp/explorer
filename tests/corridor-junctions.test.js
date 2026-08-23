/**
 * Tests for fetchCorridorJunctions (osrm.js) — the start-anchored junction
 * cache fetch.
 *
 * fetchCorridorJunctions lives inside osrm.js, which can't be imported wholesale
 * (its other functions reference cross-module globals like haversineKm).
 * The function is self-contained — it only uses Math / Number / JSON / fetch
 * and an optional onProgress callback — so we pull osrm.js's source via
 * helpers/load.js's readScript('osrm'), extract just this one function's
 * text, and instantiate it in the current realm with a faked global `fetch`.
 *
 * Guards two invariants:
 *   - audit #1268: maxKm is an explicit parameter, NOT read from the DOM.
 *   - finding #7559: start/radius travel in the POST body, never the query
 *     string, so nginx access logs cannot persist home-precision coordinates.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadScripts, readScript } from './helpers/load.js';

const OSRM_SRC = readScript('osrm');

// Pull out the `async function fetchCorridorJunctions(...) { ... }` block by
// brace-matching from the signature. Template literals here are brace-balanced
// (`${...}`) and no string literal contains a stray brace, so a naive counter
// is correct for this function.
function extractFn(name) {
    const start = OSRM_SRC.indexOf(`async function ${name}(`);
    if (start === -1) throw new Error(`${name} not found in osrm.js`);
    let i = OSRM_SRC.indexOf('{', start);
    let depth = 0;
    for (; i < OSRM_SRC.length; i++) {
        if (OSRM_SRC[i] === '{') depth++;
        else if (OSRM_SRC[i] === '}' && --depth === 0) { i++; break; }
    }
    return OSRM_SRC.slice(start, i);
}

let fetchCorridorJunctions;

beforeAll(() => {
    // fetchCorridorJunctions pads its bbox via geo-utils.js's kmToDegLat/kmToDegLng
    // globals and fetches through net.js's fetchWithTimeout; load both real
    // sources so they resolve through the new Function scope. fetchWithTimeout
    // internally calls the faked global `fetch`, so the per-test fakeFetch still
    // observes the request (and its timer is cleared once the fake resolves).
    loadScripts('net', 'geo-utils');
    const src = extractFn('fetchCorridorJunctions');
    // Evaluate the declaration and hand back a reference. new Function() bootstraps
    // the extracted source in the global scope (static local file content, not
    // user input); `fetch` resolves to globalThis.fetch (faked per test) through
    // the scope chain. evalScript() doesn't fit here — it discards its return
    // value, and we need the extracted function's reference back — so this one
    // stays an explicit new Function.
    fetchCorridorJunctions = new Function( // eslint-disable-line no-new-func
        `${src}\n return fetchCorridorJunctions;`
    )();
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
});

function fakeFetch(junctions = [{ lat: 60.2, lng: 24.9 }]) {
    const fn = vi.fn(async () => ({ ok: true, json: async () => ({ junctions }) }));
    globalThis.fetch = fn;
    return fn;
}

function requestOf(fetchMock) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    return {
        url: new URL(url, 'https://example.test'),
        init: init || {},
    };
}

function bodyOf(fetchMock) {
    const { init } = requestOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(String(init.headers?.['content-type'] || init.headers?.['Content-Type']))
        .toMatch(/application\/json/i);
    return JSON.parse(init.body);
}

describe('fetchCorridorJunctions', () => {
    test('POSTs start/radius in the JSON body, never on the query string', async () => {
        const f = fakeFetch();
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
        const f = fakeFetch([]);
        await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, true);
        expect(bodyOf(f).exclude).toBe('winter');
    });

    // (b) no DOM read — the helper must never touch document. Reverting to
    //     parseFloat(document.getElementById('maxDistance').value) makes this RED
    //     (both via the getElementById spy and the null.value throw).
    test('reads no DOM element — works with no #maxDistance present', async () => {
        expect(document.getElementById('maxDistance')).toBeNull(); // precondition
        const spy = vi.spyOn(document, 'getElementById');
        const f = fakeFetch();

        await expect(
            fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 9, null, false)
        ).resolves.toEqual([{ lat: 60.2, lng: 24.9 }]);

        expect(spy).not.toHaveBeenCalled();
        expect(bodyOf(f).maxKm).toBe(9);
    });

    // Guard: a missing/invalid budget drops to legacy bbox mode (no anchoring).
    test('omitted/NaN maxKm → POST body has bbox but no start/radius', async () => {
        const f = fakeFetch();
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
        globalThis.fetch = vi.fn(async () => ({ ok: false }));
        await expect(
            fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, false)
        ).rejects.toThrow(/try again/i);
    });
});
