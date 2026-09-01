// @vitest-environment jsdom
/**
 * Tests for route-restore.js — restoreResult (re-display history/favorite) and
 * buildAndDisplay (pick-on-map / share-link build path).
 *
 * The contract that must not regress: restoreResult is a pure re-display and
 * must NEVER call saveToHistory. displayRoute used to persist on every list
 * click, duplicating history rows and cloud outbox mutations. buildAndDisplay
 * is the opposite path — a successful build does persist.
 *
 * route-restore.js resolves clearMap / buildRouteForMode / displayRoute /
 * readRouteBuildOptions / saveToHistory as free globals at call time; this
 * suite stubs them and loads only route-restore.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const SPREAD = { offsetKm: 1, spreadFactor: 0.5 };

const FORM_HTML = `
  <input type="checkbox" id="winterMode">
  <input id="maxDistance" value="5">`;

let clearMapCalls;
let displayRouteCalls;
let saveToHistoryCalls;
let buildRouteCalls;

beforeEach(() => {
  document.body.innerHTML = FORM_HTML;
  clearMapCalls = 0;
  displayRouteCalls = [];
  saveToHistoryCalls = [];
  buildRouteCalls = [];

  globalThis.clearMap = () => { clearMapCalls++; };
  globalThis.displayRoute = (args) => {
    displayRouteCalls.push(args);
    // Shape enough for buildAndDisplay to stash junctions on the session.
    return { ...args, junctions: null };
  };
  globalThis.saveToHistory = (session) => { saveToHistoryCalls.push(session); };
  globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
    tripMode,
    smartRouting: tripMode !== 'one-way',
    winterMode: false,
    maxKm: 5,
    spread: SPREAD,
  }));
  globalThis.buildRouteForMode = async (...args) => {
    buildRouteCalls.push(args);
    return {
      outbound: { coords: [[62.1, 25.7], [62.2, 25.8]], distance: 3000, duration: 2000 },
      return: { coords: [[62.2, 25.8], [62.1, 25.7]], distance: 3000, duration: 2000 },
      junctions: [{ lat: 62.15, lng: 25.75 }],
    };
  };

  loadScripts('route-restore');
});

function sampleEntry(over = {}) {
  return {
    startLat: 62.1,
    startLng: 25.7,
    destLat: 62.2,
    destLng: 25.8,
    startLabel: 'Jyväskylä',
    destName: 'Harju',
    tripMode: 'round',
    distance: 6,
    routeDistance: 3,
    returnRouteDistance: 3,
    routeCoords: [[62.1, 25.7], [62.2, 25.8]],
    returnRouteCoords: [[62.2, 25.8], [62.1, 25.7]],
    routeDuration: 2000,
    returnRouteDuration: 2000,
    ...over,
  };
}

describe('restoreResult — re-display must not persist', () => {
  test('calls displayRoute once and never saveToHistory', () => {
    restoreResult(sampleEntry());

    expect(clearMapCalls).toBe(1);
    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('forwards entry fields into displayRoute with km→metres distances', () => {
    restoreResult(sampleEntry());

    const args = displayRouteCalls[0];
    expect(args.startLat).toBe(62.1);
    expect(args.startLng).toBe(25.7);
    expect(args.destLat).toBe(62.2);
    expect(args.destLng).toBe(25.8);
    expect(args.locationInput).toBe('Jyväskylä');
    expect(args.destName).toBe('Harju');
    expect(args.tripMode).toBe('round');
    // Persisted km become OSRM-shaped metres for computeRouteTotals.
    expect(args.outbound.distance).toBe(3000);
    expect(args.ret.distance).toBe(3000);
    expect(args.outbound.coords).toEqual([[62.1, 25.7], [62.2, 25.8]]);
  });

  test('forwards entry.poiCategory so restore does not inherit the live form', () => {
    restoreResult(sampleEntry({ poiCategory: 'culture' }));
    expect(displayRouteCalls[0].poiCategory).toBe('culture');
  });

  test('passes poiCategory: null when the entry has none (history/favorite)', () => {
    restoreResult(sampleEntry());
    expect(displayRouteCalls[0].poiCategory).toBeNull();
  });

  test('legacy entries without per-leg distances assign the total to outbound', () => {
    restoreResult(sampleEntry({
      routeDistance: undefined,
      returnRouteDistance: undefined,
      distance: 5.5,
    }));

    const args = displayRouteCalls[0];
    expect(args.outbound.distance).toBe(5500);
    // No per-leg data → return leg distance falls back to 0.
    expect(args.ret.distance).toBe(0);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('entries with no stored coords still re-display without persisting', () => {
    restoreResult(sampleEntry({
      routeCoords: null,
      returnRouteCoords: null,
      routeDistance: undefined,
      returnRouteDistance: undefined,
    }));

    expect(displayRouteCalls[0].outbound).toBeNull();
    expect(displayRouteCalls[0].ret).toBeNull();
    expect(saveToHistoryCalls).toHaveLength(0);
  });
});

describe('buildAndDisplay — successful build persists', () => {
  // Landmine 1 regression guard, at this call site: buildAndDisplay is what
  // pick-on-map and share-link's restoreFromHash use to build a route to a
  // destination the user already chose. It never reads #smartRouting itself
  // (only forwards whatever readRouteBuildOptions returns), and that element
  // is gone from FORM_HTML above entirely — a shared-link restore must still
  // build cleanly.
  test('a shared-link restore works with no #smartRouting element in the DOM', async () => {
    expect(document.getElementById('smartRouting')).toBeNull();

    await expect(buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'Jyväskylä',
      destName: 'Harju',
      onProgress: () => {},
    })).resolves.toBeUndefined();

    expect(buildRouteCalls).toHaveLength(1);
    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(1);
  });

  test('clears, builds, displays, and saveToHistory after a successful build', async () => {
    const onProgress = vi.fn();
    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'Jyväskylä',
      destName: 'Harju',
      onProgress,
      loadingMessage: 'Building…',
      buildingMessage: 'Routing…',
    });

    expect(clearMapCalls).toBe(1);
    expect(onProgress).toHaveBeenCalledWith('Building…');
    expect(buildRouteCalls).toHaveLength(1);
    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(1);
    // Junction pool from the build is stashed on the session that was persisted.
    expect(saveToHistoryCalls[0].junctions).toEqual([{ lat: 62.15, lng: 25.75 }]);
    // Pick-on-map / share-link have no category of their own; passing null
    // (not omitting the field) is what stops displayRoute inheriting the form.
    expect(displayRouteCalls[0].poiCategory).toBeNull();
  });

  test('forwards an explicit poiCategory option through to displayRoute', async () => {
    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      poiCategory: 'activity',
      onProgress: () => {},
    });
    expect(displayRouteCalls[0].poiCategory).toBe('activity');
  });

  // #3663 — buildAndDisplay used to clearMap() before an awaited build. When
  // that build threw (OSRM down, a junction fetch failing), displayRoute was
  // never reached, so the dashed straight-line fallback never ran either: the
  // user was left with a blank map while the result panel and the session still
  // described the route that had just been wiped off it. Nothing is destroyed
  // until the replacement exists — the principle finding #7303 established for
  // the spread reroute, applied to the two "we know where we're going" flows.
  test('a throwing build leaves the previous map view intact', async () => {
    globalThis.buildRouteForMode = async () => { throw new Error('OSRM down'); };

    await expect(buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    })).rejects.toThrow('OSRM down');

    expect(clearMapCalls).toBe(0);
    expect(displayRouteCalls).toHaveLength(0);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('clearMap runs before displayRoute, so the old view is replaced not stacked', async () => {
    // displayRoute adds markers/circles/polylines on top rather than replacing
    // them, so deferring the clear must not defer it past the draw.
    const order = [];
    globalThis.clearMap = () => { clearMapCalls++; order.push('clear'); };
    const realDisplay = globalThis.displayRoute;
    globalThis.displayRoute = (args) => { order.push('display'); return realDisplay(args); };

    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    expect(order).toEqual(['clear', 'display']);
  });

  test('spreads readRouteBuildOptions into buildRouteForMode', async () => {
    const blob = {
      tripMode: 'round', smartRouting: true, winterMode: true,
      maxKm: 9, spread: { offsetKm: 2 },
    };
    readRouteBuildOptions.mockReturnValue(blob);

    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    expect(readRouteBuildOptions).toHaveBeenCalledWith('round');
    expect(buildRouteCalls[0][4]).toEqual(expect.objectContaining(blob));
  });

  test('one-way helper result (smart off) is forwarded into buildRouteForMode', async () => {
    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'one-way',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    expect(readRouteBuildOptions).toHaveBeenCalledWith('one-way');
    const opts = buildRouteCalls[0][4];
    expect(opts.tripMode).toBe('one-way');
    expect(opts.smartRouting).toBe(false);
    expect(opts.winterMode).toBe(false);
    expect(opts.spread).toBe(SPREAD);
    expect(saveToHistoryCalls).toHaveLength(1);
  });

  test('does not call saveToHistory when the build throws', async () => {
    globalThis.buildRouteForMode = async () => {
      throw new Error('OSRM down');
    };

    await expect(buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    })).rejects.toThrow('OSRM down');

    expect(displayRouteCalls).toHaveLength(0);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('does not persist a fake walk when the build returns no outbound leg', async () => {
    globalThis.buildRouteForMode = async () => ({
      outbound: undefined, return: undefined, junctions: null,
    });

    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('does not persist a truthy outbound with empty coords (finding #7926)', async () => {
    globalThis.buildRouteForMode = async () => ({
      outbound: { coords: [], duration: 1, distance: 1 }, return: null, junctions: null,
    });

    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'round',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(0);
  });
});
