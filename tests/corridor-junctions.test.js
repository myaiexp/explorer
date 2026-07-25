/**
 * Tests for fetchCorridorJunctions (osrm.js) — the start-anchored junction
 * cache fetch.
 *
 * fetchCorridorJunctions lives inside osrm.js, which can't be imported wholesale
 * (its other functions reference cross-module globals like calculateDistance).
 * The function is self-contained — it only uses Math / URLSearchParams / Number
 * / String / fetch and an optional onProgress callback — so we pull osrm.js's
 * source via helpers/load.js's readScript('osrm'), extract just this one
 * function's text, and instantiate it in the current realm with a faked global
 * `fetch`.
 *
 * Guards the audit #1268 invariant: maxKm is an explicit parameter, NOT read
 * from the DOM. The "no DOM read" test fails RED if anyone reverts to reading
 * document.getElementById('maxDistance').value inside the helper.
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

function urlOf(fetchMock) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return new URL(fetchMock.mock.calls[0][0], 'https://example.test');
}

describe('fetchCorridorJunctions', () => {
    // (a) explicit maxKm flows through to the start-anchored cache URL
    test('explicit maxKm is passed through to the cache URL params', async () => {
        const f = fakeFetch();
        const out = await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, false);

        const url = urlOf(f);
        const p = url.searchParams;
        expect(p.get('maxKm')).toBe('7');
        expect(p.get('startLat')).toBe('60');
        expect(p.get('startLng')).toBe('24');
        expect(p.get('exclude')).toBe('default');
        expect(p.get('bbox')).toBeTruthy();
        expect(out).toEqual([{ lat: 60.2, lng: 24.9 }]);
    });

    test('winterMode selects the winter exclude preset', async () => {
        const f = fakeFetch([]);
        await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, true);
        expect(urlOf(f).searchParams.get('exclude')).toBe('winter');
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
        // and the explicit param — not any DOM value — is what reached the URL
        expect(urlOf(f).searchParams.get('maxKm')).toBe('9');
    });

    // Guard: a missing/invalid budget drops to legacy bbox mode (no anchoring).
    test('omitted/NaN maxKm → no startLat/startLng/maxKm params (legacy bbox mode)', async () => {
        const f = fakeFetch();
        await fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, NaN, null, false);

        const p = urlOf(f).searchParams;
        expect(p.has('maxKm')).toBe(false);
        expect(p.has('startLat')).toBe(false);
        expect(p.has('startLng')).toBe(false);
        expect(p.get('bbox')).toBeTruthy();
    });

    test('throws a friendly error on non-ok response', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false }));
        await expect(
            fetchCorridorJunctions(60, 24, 60.5, 24.5, 1, 7, null, false)
        ).rejects.toThrow(/try again/i);
    });
});
