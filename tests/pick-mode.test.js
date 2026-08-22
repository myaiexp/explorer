/**
 * Tests for pick-mode.js — the pick-on-map route-build entry (audit #7069).
 *
 * pick-mode bypasses #generateBtn, so rejectIfBuilding must run BEFORE
 * exitPickMode: a click during a build stays armed instead of being swallowed
 * with the mode. Collaborators (map, resolveStart, buildAndDisplay, loading
 * mutex, result panel) are resolved as globals at call time; this suite stubs
 * them and loads only pick-mode — no SCRIPT_DEPS entry.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const FORM_HTML = `
  <input id="location" value="Jyväskylä">
  <button type="button" id="pickDestBtn">Pick on map</button>
  <button type="button" id="generateBtn"></button>
  <div id="loading"><p>Finding your random destination…</p></div>
  <input type="radio" name="tripMode" value="round" checked>
  <input type="radio" name="tripMode" value="one-way">
`;

let errors;
let warnings;
let successes;
let sessionClears;
let panelResets;
let clickHandlers;
let mapCursorEl;
let resolveStart;
let buildAndDisplay;

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function fakeMap() {
    clickHandlers = [];
    mapCursorEl = document.createElement('div');
    return {
        getContainer: () => mapCursorEl,
        on(ev, fn) { if (ev === 'click') clickHandlers.push(fn); },
        off(ev, fn) {
            if (ev === 'click') clickHandlers = clickHandlers.filter((h) => h !== fn);
        },
    };
}

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    errors = [];
    warnings = [];
    successes = [];
    sessionClears = 0;
    panelResets = 0;

    globalThis.showError = (msg) => { errors.push(msg); };
    globalThis.showWarning = (msg) => { warnings.push(msg); };
    globalThis.showSuccess = (msg) => { successes.push(msg); };
    globalThis.setCurrentSession = (v) => { if (v === null) sessionClears++; };
    globalThis.resetResultPanel = () => { panelResets++; };

    resolveStart = vi.fn(async () => ({
        startLat: 62.24, startLng: 25.75, locationInput: 'Jyväskylä',
    }));
    buildAndDisplay = vi.fn(async () => {});
    globalThis.resolveStart = resolveStart;
    globalThis.buildAndDisplay = buildAndDisplay;
    globalThis.map = fakeMap();

    // Real loading.js so rejectIfBuilding / withLoading are the production mutex,
    // not a stub that could drift from the "check BEFORE exitPickMode" contract.
    loadScripts('loading', 'pick-mode');
});

function pickBtn() {
    return document.getElementById('pickDestBtn');
}

describe('togglePickMode — start location required', () => {
    test('empty location shows an error and does not arm pick mode', () => {
        document.getElementById('location').value = '';
        togglePickMode();

        expect(errors).toEqual(['Please enter a starting location first.']);
        expect(pickBtn().textContent).toBe('Pick on map');
        expect(pickBtn().classList.contains('active')).toBe(false);
        expect(clickHandlers).toHaveLength(0);
        expect(successes).toHaveLength(0);
    });

    test('whitespace-only location is treated as empty', () => {
        document.getElementById('location').value = '   ';
        togglePickMode();

        expect(errors).toEqual(['Please enter a starting location first.']);
        expect(clickHandlers).toHaveLength(0);
    });

    test('a filled location arms the map-click handler and the cancel button', () => {
        togglePickMode();

        expect(errors).toHaveLength(0);
        expect(pickBtn().textContent).toBe('Cancel');
        expect(pickBtn().classList.contains('active')).toBe(true);
        expect(mapCursorEl.style.cursor).toBe('crosshair');
        expect(clickHandlers).toEqual([handlePickClick]);
        expect(successes).toHaveLength(1);
    });

    test('a second toggle exits pick mode and detaches the handler', () => {
        togglePickMode();
        togglePickMode();

        expect(pickBtn().textContent).toBe('Pick on map');
        expect(pickBtn().classList.contains('active')).toBe(false);
        expect(mapCursorEl.style.cursor).toBe('');
        expect(clickHandlers).toHaveLength(0);
    });
});

describe('handlePickClick — rejectIfBuilding before exitPickMode', () => {
    test('a click while building warns and does not exit pick mode', async () => {
        togglePickMode();
        const first = deferred();
        const inflight = withLoading(async () => { await first.promise; });

        await handlePickClick({ latlng: { lat: 62.3, lng: 25.8 } });

        expect(warnings).toEqual(['Still building your route — hang tight.']);
        expect(pickBtn().textContent).toBe('Cancel');
        expect(pickBtn().classList.contains('active')).toBe(true);
        expect(clickHandlers).toEqual([handlePickClick]);
        expect(sessionClears).toBe(0);
        expect(panelResets).toBe(0);
        expect(resolveStart).not.toHaveBeenCalled();
        expect(buildAndDisplay).not.toHaveBeenCalled();

        first.resolve();
        await inflight;
    });

    test('a successful click exits pick mode then builds to the clicked point', async () => {
        togglePickMode();

        await handlePickClick({ latlng: { lat: 62.3, lng: 25.8 } });

        expect(pickBtn().textContent).toBe('Pick on map');
        expect(clickHandlers).toHaveLength(0);
        expect(sessionClears).toBe(1);
        expect(panelResets).toBe(1);
        expect(resolveStart).toHaveBeenCalledOnce();
        expect(buildAndDisplay).toHaveBeenCalledOnce();
        expect(buildAndDisplay.mock.calls[0][0]).toBe(62.24);
        expect(buildAndDisplay.mock.calls[0][1]).toBe(25.75);
        expect(buildAndDisplay.mock.calls[0][2]).toBe(62.3);
        expect(buildAndDisplay.mock.calls[0][3]).toBe(25.8);
        expect(buildAndDisplay.mock.calls[0][4]).toEqual(expect.objectContaining({
            tripMode: 'round',
            locationInput: 'Jyväskylä',
            destName: null,
        }));
    });

    test('resolveStart throwing shows the error and does not build', async () => {
        togglePickMode();
        resolveStart.mockRejectedValue(new Error('Could not geocode that location.'));

        await handlePickClick({ latlng: { lat: 62.3, lng: 25.8 } });

        expect(errors).toEqual(['Could not geocode that location.']);
        expect(buildAndDisplay).not.toHaveBeenCalled();
        // Exit still happens first — the click consumed the armed mode.
        expect(pickBtn().textContent).toBe('Pick on map');
        expect(clickHandlers).toHaveLength(0);
    });
});
