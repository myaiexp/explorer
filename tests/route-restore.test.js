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
 * getSpreadParams / saveToHistory as free globals at call time; this suite
 * stubs them and loads only route-restore.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const FORM_HTML = `
  <input type="checkbox" id="smartRouting">
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
  globalThis.getSpreadParams = () => ({ offsetKm: 1, spreadFactor: 0.5 });
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
  });

  test('one-way never enables smart routing even when the checkbox is on', async () => {
    document.getElementById('smartRouting').checked = true;
    await buildAndDisplay(62.1, 25.7, 62.2, 25.8, {
      tripMode: 'one-way',
      locationInput: 'x',
      destName: 'y',
      onProgress: () => {},
    });

    const opts = buildRouteCalls[0][4];
    expect(opts.tripMode).toBe('one-way');
    expect(opts.smartRouting).toBe(false);
    expect(opts.winterMode).toBe(false);
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
});
