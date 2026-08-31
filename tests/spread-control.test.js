// @vitest-environment jsdom
/**
 * Tests for spread-control.js — slider/stepper debounce, re-arm while a build
 * owns the app, cachedJunctions reuse, and the session rewrite that must keep
 * visitId so the mark-visited button stays honest (finding #7067). Finding #7303:
 * tryOsrm's {outbound:null,return:null} resolve (HTTP/parse failure, not a throw)
 * must not wipe the previous session or clear the drawn polylines first.
 *
 * spread-control.js binds the slider listener at load time, so the DOM has to
 * exist before loadScripts. Collaborators other than loading.js / session-state.js
 * / session.js are faked on globalThis; withLoading + isBuilding stay real so
 * the retry path is the production mutex, not a stub of it.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const SPREAD = { offsetMult: 0.5, viaTs: [0.25, 0.5, 0.75] };
const JUNCTIONS = [{ lat: 62.15, lng: 25.75 }];
const NEW_JUNCTIONS = [{ lat: 62.16, lng: 25.76 }];
const OUTBOUND = { coords: [[62.1, 25.7], [62.2, 25.8]], distance: 1200, duration: 700, steps: [] };
const RETURN = { coords: [[62.2, 25.8], [62.1, 25.7]], distance: 1100, duration: 650, steps: [] };

const FORM_HTML = `
  <input type="range" id="spreadSlider" min="0" max="100" value="50" step="5">
  <input type="checkbox" id="winterMode">
  <input type="checkbox" id="avoidBacktracking">
  <input id="maxDistance" value="5">
  <div id="loading"><p>Finding your random destination…</p></div>
  <button id="generateBtn"></button>
`;

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function baseSession(extra = {}) {
    return {
        visitId: 'visit-1',
        startLat: 62.1,
        startLng: 25.7,
        destLat: 62.2,
        destLng: 25.8,
        destName: 'Park',
        tripMode: 'round',
        junctions: JUNCTIONS,
        distance: 2.0,
        ...extra,
    };
}

let errors;
let warnings;
let clearRouteLines;
let buildRouteForMode;
let renderRouteTail;

beforeEach(() => {
    errors = [];
    warnings = [];
    document.body.innerHTML = FORM_HTML;

    globalThis.showError = (msg) => { errors.push(msg); };
    globalThis.showWarning = (msg) => { warnings.push(msg); };
    globalThis.getRouteColor = () => '#ff0000';
    globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
        tripMode,
        smartRouting: tripMode !== 'one-way',
        winterMode: false,
        maxKm: 5,
        spread: SPREAD,
    }));
    clearRouteLines = vi.fn();
    globalThis.clearRouteLines = clearRouteLines;
    renderRouteTail = vi.fn(() => ({ totalWalkKm: 2.4 }));
    globalThis.renderRouteTail = renderRouteTail;
    buildRouteForMode = vi.fn(async () => ({
        outbound: OUTBOUND,
        return: RETURN,
        junctions: NEW_JUNCTIONS,
    }));
    globalThis.buildRouteForMode = buildRouteForMode;

    vi.useFakeTimers();
    loadScripts('session-state', 'session', 'loading', 'spread-control');
});

afterEach(() => {
    vi.useRealTimers();
});

function fireSlider() {
    document.getElementById('spreadSlider').dispatchEvent(new Event('input'));
}

describe('slider input', () => {
    test('no session → no schedule', async () => {
        fireSlider();
        await vi.advanceTimersByTimeAsync(2000);
        expect(buildRouteForMode).not.toHaveBeenCalled();
        expect(clearRouteLines).not.toHaveBeenCalled();
    });

    test('coalesces rapid input into one reroute after the 400ms debounce', async () => {
        setCurrentSession(baseSession());
        fireSlider();
        fireSlider();
        fireSlider();
        await vi.advanceTimersByTimeAsync(399);
        expect(buildRouteForMode).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(buildRouteForMode).toHaveBeenCalledTimes(1);
    });
});

describe('runSpreadReroute retry while building', () => {
    test('input while a build owns the app re-arms after 400ms and runs once the mutex clears', async () => {
        setCurrentSession(baseSession());
        const held = deferred();
        const build = withLoading(async () => { await held.promise; });

        fireSlider();
        await vi.advanceTimersByTimeAsync(400); // debounce → sees isBuilding, re-arms
        expect(buildRouteForMode).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(400); // retry, still building, re-arms again
        expect(buildRouteForMode).not.toHaveBeenCalled();

        held.resolve();
        await build;
        expect(isBuilding()).toBe(false);

        await vi.advanceTimersByTimeAsync(400);
        expect(buildRouteForMode).toHaveBeenCalledTimes(1);
    });
});

describe('rerouteWithCurrentSpread', () => {
    // Landmine 1 regression guard, at this call site: the #smartRouting
    // checkbox is gone from FORM_HTML above entirely (spread-control.js never
    // reads it directly — it only forwards whatever readRouteBuildOptions
    // returns), so a spread reroute must complete cleanly with no such
    // element anywhere in the DOM.
    test('a spread reroute works with no #smartRouting element in the DOM', async () => {
        expect(document.getElementById('smartRouting')).toBeNull();
        setCurrentSession(baseSession());
        readRouteBuildOptions.mockReturnValue({
            tripMode: 'round', smartRouting: true, winterMode: true,
            maxKm: 5, spread: SPREAD,
        });

        await expect(rerouteWithCurrentSpread()).resolves.toBeUndefined();

        expect(buildRouteForMode).toHaveBeenCalledTimes(1);
        expect(getCurrentSession().junctions).toBe(NEW_JUNCTIONS);
    });

    test('preserves visitId, reuses cachedJunctions, and writes the new junctions', async () => {
        const session = baseSession();
        setCurrentSession(session);
        readRouteBuildOptions.mockReturnValue({
            tripMode: 'round', smartRouting: true, winterMode: true,
            maxKm: 5, spread: SPREAD,
        });

        await rerouteWithCurrentSpread();

        expect(buildRouteForMode).toHaveBeenCalledTimes(1);
        expect(readRouteBuildOptions).toHaveBeenCalledWith('round');
        const [lat, lng, dLat, dLng, opts] = buildRouteForMode.mock.calls[0];
        expect([lat, lng, dLat, dLng]).toEqual([62.1, 25.7, 62.2, 25.8]);
        expect(opts.cachedJunctions).toBe(JUNCTIONS);
        expect(opts.tripMode).toBe('round');
        expect(opts.smartRouting).toBe(true);
        expect(opts.winterMode).toBe(true);
        expect(opts.spread).toBe(SPREAD);
        expect(opts.maxKm).toBe(5);
        expect(clearRouteLines).toHaveBeenCalledTimes(1);

        const next = getCurrentSession();
        expect(next).not.toBe(session);
        expect(next.visitId).toBe('visit-1');
        expect(next.destName).toBe('Park');
        expect(next.junctions).toBe(NEW_JUNCTIONS);
        expect(next.distance).toBe(2.4);
        expect(next.routeCoords).toBe(OUTBOUND.coords);
        expect(next.returnRouteCoords).toBe(RETURN.coords);
    });

    test('one-way keeps the previous junctions (OSRM does not return a loop set)', async () => {
        setCurrentSession(baseSession({ tripMode: 'one-way' }));
        await rerouteWithCurrentSpread();
        expect(getCurrentSession().junctions).toBe(JUNCTIONS);
        expect(getCurrentSession().visitId).toBe('visit-1');
        expect(readRouteBuildOptions).toHaveBeenCalledWith('one-way');
        expect(buildRouteForMode.mock.calls[0][4].smartRouting).toBe(false);
    });

    test('one-way with outbound and no return is a usable replacement', async () => {
        setCurrentSession(baseSession({ tripMode: 'one-way', routeCoords: OUTBOUND.coords }));
        buildRouteForMode.mockResolvedValue({ outbound: OUTBOUND, return: null, junctions: null });
        await rerouteWithCurrentSpread();
        expect(errors).toEqual([]);
        expect(clearRouteLines).toHaveBeenCalledTimes(1);
        expect(renderRouteTail).toHaveBeenCalled();
        expect(getCurrentSession().routeCoords).toBe(OUTBOUND.coords);
    });

    test('buildRouteForMode throw shows the error without wiping the previous session', async () => {
        const session = baseSession({
            routeCoords: OUTBOUND.coords,
            returnRouteCoords: RETURN.coords,
        });
        setCurrentSession(session);
        buildRouteForMode.mockRejectedValue(new Error('OSRM unreachable'));

        await rerouteWithCurrentSpread();

        expect(errors).toEqual(['OSRM unreachable']);
        expect(getCurrentSession()).toBe(session);
        expect(getCurrentSession().visitId).toBe('visit-1');
        expect(getCurrentSession().routeCoords).toBe(OUTBOUND.coords);
        expect(getCurrentSession().distance).toBe(2.0);
        expect(renderRouteTail).not.toHaveBeenCalled();
        // tryOsrm-style failure must not blank the map before the replacement
        // exists — clearRouteLines used to run above the await, so a throw left
        // markers with no polylines and no way to redraw the previous route.
        expect(clearRouteLines).not.toHaveBeenCalled();
    });

    test('null legs keep the previous session and do not clear the drawn route', async () => {
        // tryOsrm returns {outbound:null,return:null} on HTTP/parse failure —
        // it does not throw. That used to fall through to setCurrentSession
        // with nulled coords after the map had already been wiped.
        const session = baseSession({
            routeCoords: OUTBOUND.coords,
            returnRouteCoords: RETURN.coords,
            distance: 2.0,
        });
        setCurrentSession(session);
        buildRouteForMode.mockResolvedValue({ outbound: null, return: null, junctions: null });

        await rerouteWithCurrentSpread();

        expect(getCurrentSession()).toBe(session);
        expect(getCurrentSession().visitId).toBe('visit-1');
        expect(getCurrentSession().routeCoords).toBe(OUTBOUND.coords);
        expect(getCurrentSession().returnRouteCoords).toBe(RETURN.coords);
        expect(getCurrentSession().distance).toBe(2.0);
        expect(clearRouteLines).not.toHaveBeenCalled();
        expect(renderRouteTail).not.toHaveBeenCalled();
        expect(errors).toEqual(['Failed to adjust route.']);
    });

    test('loop with outbound but no return keeps the previous route', async () => {
        // A usable replacement for a loop is BOTH legs. Outbound-only used to
        // clear the map and rewrite the session (finding #7301).
        const session = baseSession({
            routeCoords: OUTBOUND.coords,
            returnRouteCoords: RETURN.coords,
            distance: 2.0,
        });
        setCurrentSession(session);
        buildRouteForMode.mockResolvedValue({ outbound: OUTBOUND, return: null, junctions: null });

        await rerouteWithCurrentSpread();

        expect(getCurrentSession()).toBe(session);
        expect(getCurrentSession().returnRouteCoords).toBe(RETURN.coords);
        expect(clearRouteLines).not.toHaveBeenCalled();
        expect(renderRouteTail).not.toHaveBeenCalled();
        expect(errors).toEqual(['Failed to adjust route.']);
    });

    test('one-way with no outbound keeps the previous route even if a return is present', async () => {
        const session = baseSession({
            tripMode: 'one-way',
            routeCoords: OUTBOUND.coords,
            distance: 2.0,
        });
        setCurrentSession(session);
        buildRouteForMode.mockResolvedValue({ outbound: null, return: RETURN, junctions: null });

        await rerouteWithCurrentSpread();

        expect(getCurrentSession()).toBe(session);
        expect(getCurrentSession().routeCoords).toBe(OUTBOUND.coords);
        expect(clearRouteLines).not.toHaveBeenCalled();
        expect(renderRouteTail).not.toHaveBeenCalled();
        expect(errors).toEqual(['Failed to adjust route.']);
    });

    test('no session is a no-op', async () => {
        await rerouteWithCurrentSpread();
        expect(buildRouteForMode).not.toHaveBeenCalled();
    });
});

describe('adjustSpread', () => {
    test('clamps to 0–100 and still moves the slider with no session (no reroute)', async () => {
        const slider = document.getElementById('spreadSlider');
        slider.value = '5';
        adjustSpread(-10);
        expect(slider.value).toBe('0');
        slider.value = '95';
        adjustSpread(10);
        expect(slider.value).toBe('100');
        await vi.advanceTimersByTimeAsync(2000);
        expect(buildRouteForMode).not.toHaveBeenCalled();
    });

    test('with a session, reroutes after the 200ms stepper debounce', async () => {
        setCurrentSession(baseSession());
        adjustSpread(5);
        expect(document.getElementById('spreadSlider').value).toBe('55');
        await vi.advanceTimersByTimeAsync(199);
        expect(buildRouteForMode).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(buildRouteForMode).toHaveBeenCalledTimes(1);
    });
});
