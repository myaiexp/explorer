/**
 * Tests for generate.js — the only entry that picks a *new* destination
 * (audit finding #7066). pick-mode / share-link route to a dest the user
 * already chose; this file is the form → resolve → screen → build → display
 * → persist pipeline, plus surpriseMe's form scramble.
 *
 * generate.js is a non-module script. Collaborators (resolveStart,
 * resolveCandidatePool, screenCandidatePool, buildRouteForDestination,
 * displayRoute, saveToHistory, withLoading, rejectIfBuilding, …) are
 * resolved as globals at call time, so this suite stubs them and loads
 * only generate — no SCRIPT_DEPS entry.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const DEST = { lat: 61, lng: 25, name: 'Park' };

const FORM_HTML = `
  <input id="minDistance" value="1">
  <input id="maxDistance" value="5.2">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <select id="locationTypeSelect">
    <option value="any">any</option>
    <option value="roads">roads</option>
    <option value="any_poi">any_poi</option>
    <option value="park" selected>park</option>
  </select>
  <input type="checkbox" id="winterMode">
  <input type="checkbox" id="smartRouting">
  <input type="range" id="spreadSlider" min="0" max="100" value="50">
  <div id="notification" class="active"></div>
  <button id="generateBtn"></button>
  <div id="loading"><p></p></div>
`;

const SPREAD = { offsetMult: 0.5, viaTs: [0.25, 0.5, 0.75] };
const OUTBOUND = { coords: [[60, 24], [61, 25]], distance: 3000, duration: 2000 };
const RETURN = { coords: [[61, 25], [60, 24]], distance: 3000, duration: 2000 };

let errors;
let warnings;
let sessionClears;
let panelResets;
let clearMapCalls;
let saveSettingsCalls;
let displayRouteCalls;
let saveToHistoryCalls;
let inflight;
let rejectBuilding;
let resolveStart;
let resolveCandidatePool;
let screenCandidatePool;
let buildRouteForDestination;

beforeEach(() => {
  document.body.innerHTML = FORM_HTML;
  errors = [];
  warnings = [];
  sessionClears = 0;
  panelResets = 0;
  clearMapCalls = 0;
  saveSettingsCalls = 0;
  displayRouteCalls = [];
  saveToHistoryCalls = [];
  inflight = undefined;
  rejectBuilding = false;

  globalThis.showError = (msg) => { errors.push(msg); };
  globalThis.showWarning = (msg) => { warnings.push(msg); };
  globalThis.setCurrentSession = (v) => { if (v === null) sessionClears++; };
  globalThis.resetResultPanel = () => { panelResets++; };
  globalThis.clearMap = () => { clearMapCalls++; };
  globalThis.saveSettings = () => { saveSettingsCalls++; };
  globalThis.getVisits = () => [{ destLat: 62, destLng: 26 }];
  globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
    tripMode,
    smartRouting: false,
    winterMode: false,
    maxKm: parseFloat(document.getElementById('maxDistance').value),
    spread: SPREAD,
  }));
  globalThis.OVERLAP_BAD_THRESHOLD = 0.4;
  globalThis.POI_TYPES = [{ key: 'park' }, { key: 'cafe' }];

  globalThis.rejectIfBuilding = () => rejectBuilding;
  globalThis.withLoading = (fn) => {
    inflight = (async () => { await fn(() => {}); return true; })();
    return inflight;
  };

  resolveStart = vi.fn(async () => ({ startLat: 60, startLng: 24, locationInput: 'Home' }));
  resolveCandidatePool = vi.fn(async () => ({
    candidatePool: [DEST], dest: DEST, destName: 'Park',
  }));
  screenCandidatePool = vi.fn(async (_lat, _lng, { candidatePool, dest, destName }) => ({
    candidatePool, dest, destName, waterLocked: false,
  }));
  buildRouteForDestination = vi.fn(async () => ({
    dest: DEST, destName: 'Park',
    outbound: OUTBOUND, return: RETURN,
    junctions: [{ lat: 60.5, lng: 24.5 }],
    overlap: 0.1,
  }));
  globalThis.resolveStart = resolveStart;
  globalThis.resolveCandidatePool = resolveCandidatePool;
  globalThis.screenCandidatePool = screenCandidatePool;
  globalThis.buildRouteForDestination = buildRouteForDestination;

  globalThis.displayRoute = (args) => {
    displayRouteCalls.push(args);
    return { id: 'sess-1', ...args };
  };
  globalThis.saveToHistory = (session) => { saveToHistoryCalls.push(session); };

  loadScripts('generate');
});

async function generate() {
  await globalThis.generateDestination();
}

function resolveOpts() {
  return resolveCandidatePool.mock.calls.at(-1)[2];
}

describe('rejectIfBuilding runs before any mutation', () => {
  test('bails without clearing the session, panel, or starting the pipeline', async () => {
    rejectBuilding = true;
    await generate();

    expect(sessionClears).toBe(0);
    expect(panelResets).toBe(0);
    expect(errors).toHaveLength(0);
    expect(resolveStart).not.toHaveBeenCalled();
    expect(inflight).toBeUndefined();
  });
});

describe('min/max distance guards', () => {
  test.each([
    ['0', '0', 'Please enter a valid maximum distance greater than 0.'],
    ['0', '-1', 'Please enter a valid maximum distance greater than 0.'],
    ['1', '', 'Please enter a valid maximum distance greater than 0.'],
    ['1', 'abc', 'Please enter a valid maximum distance greater than 0.'],
    ['-1', '5', 'Minimum distance cannot be negative.'],
    ['5', '5', 'Minimum distance must be less than maximum distance.'],
    ['6', '5', 'Minimum distance must be less than maximum distance.'],
  ])('min=%s max=%s → %s', async (min, max, message) => {
    document.getElementById('minDistance').value = min;
    document.getElementById('maxDistance').value = max;

    await generate();

    expect(errors).toEqual([message]);
    expect(sessionClears).toBe(0);
    expect(panelResets).toBe(0);
    expect(resolveStart).not.toHaveBeenCalled();
    expect(displayRouteCalls).toHaveLength(0);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  // Empty / non-numeric min is "no floor" — parseFloat → NaN → 0. Invalid max
  // still errors above; a missing budget cannot start a search. Finding #7786.
  test.each([
    ['', '5'],
    ['abc', '5'],
  ])('min=%s max=%s coerces minKm to 0 and starts the pipeline', async (min, max) => {
    document.getElementById('minDistance').value = min;
    document.getElementById('maxDistance').value = max;

    await generate();

    expect(errors).toHaveLength(0);
    expect(resolveStart).toHaveBeenCalledOnce();
    expect(resolveOpts().straightMin).toBe(0);
    expect(resolveOpts().straightMax).toBeCloseTo(Number(max) / 2.6);
  });
});

describe('routingStrategy mapping', () => {
  test.each([
    ['park', 'poi'],
    ['unknown_thing', 'poi'],
    ['any', 'any'],
    ['roads', 'roads'],
    ['any_poi', 'any_poi'],
  ])('select value %s → routingStrategy %s (raw kept)', async (raw, strategy) => {
    const sel = document.getElementById('locationTypeSelect');
    if (![...sel.options].some((o) => o.value === raw)) {
      sel.add(new Option(raw, raw));
    }
    sel.value = raw;

    await generate();

    const opts = resolveOpts();
    expect(opts.routingStrategy).toBe(strategy);
    expect(opts.rawLocationType).toBe(raw);
  });
});

describe('straight-line scale', () => {
  test('round-trip divides the budget by 2.6', async () => {
    document.getElementById('roundTrip').checked = true;
    document.getElementById('oneWay').checked = false;

    await generate();

    const opts = resolveOpts();
    expect(opts.straightMin).toBeCloseTo(1 / 2.6);
    expect(opts.straightMax).toBeCloseTo(5.2 / 2.6);
  });

  test('one-way divides the budget by 1.3', async () => {
    document.getElementById('roundTrip').checked = false;
    document.getElementById('oneWay').checked = true;

    await generate();

    const opts = resolveOpts();
    expect(opts.straightMin).toBeCloseTo(1 / 1.3);
    expect(opts.straightMax).toBeCloseTo(5.2 / 1.3);
    expect(readRouteBuildOptions).toHaveBeenCalledWith('one-way');
  });
});

describe('pipeline wiring', () => {
  test('happy path displays, persists, and forwards dests / modes / spread', async () => {
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', smartRouting: true, winterMode: true,
      maxKm: 5.2, spread: SPREAD,
    });

    await generate();

    expect(resolveStart).toHaveBeenCalledOnce();
    expect(clearMapCalls).toBe(1);
    expect(readRouteBuildOptions).toHaveBeenCalledWith('round');
    expect(resolveCandidatePool).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      existingDests: [[62, 26]],
      winterMode: true,
    }));
    expect(screenCandidatePool).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      dest: DEST, destName: 'Park', existingDests: [[62, 26]],
    }));
    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      dest: DEST, destName: 'Park', maxKm: 5.2, tripMode: 'round',
      spread: SPREAD, smartRouting: true, winterMode: true,
      existingDests: [[62, 26]],
    }));

    expect(displayRouteCalls).toHaveLength(1);
    expect(displayRouteCalls[0]).toEqual(expect.objectContaining({
      startLat: 60, startLng: 24, destLat: 61, destLng: 25,
      outbound: OUTBOUND, ret: RETURN,
      locationInput: 'Home', destName: 'Park', tripMode: 'round',
      poiCategory: 'park',
    }));
    expect(saveToHistoryCalls).toHaveLength(1);
    expect(saveToHistoryCalls[0].junctions).toEqual([{ lat: 60.5, lng: 24.5 }]);
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
    expect(document.getElementById('notification').classList.contains('active')).toBe(false);
  });

  test('winterMode from the helper reaches dest-pool even when smartRouting is off', async () => {
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', smartRouting: false, winterMode: true,
      maxKm: 5.2, spread: SPREAD,
    });

    await generate();

    expect(resolveCandidatePool).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      winterMode: true,
    }));
    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      smartRouting: false, winterMode: true,
    }));
  });

  test('getAllExistingDestinations maps visits to [lat, lng] pairs', () => {
    expect(globalThis.getAllExistingDestinations()).toEqual([[62, 26]]);
  });

  test('resolveStart throw surfaces via showError and does not persist', async () => {
    resolveStart.mockRejectedValue(new Error('geocode failed'));

    await generate();

    expect(errors).toEqual(['geocode failed']);
    expect(displayRouteCalls).toHaveLength(0);
    expect(saveToHistoryCalls).toHaveLength(0);
  });
});

describe('waterLocked / overlap warnings', () => {
  test('waterLocked warns and skips the overlap warning even when overlap is bad', async () => {
    screenCandidatePool.mockResolvedValue({
      candidatePool: [DEST], dest: DEST, destName: 'Park', waterLocked: true,
    });
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: RETURN,
      junctions: null, overlap: 0.9,
    });

    await generate();

    expect(warnings).toEqual([
      'This area is mostly water — try a different start or larger radius.',
    ]);
    expect(saveToHistoryCalls).toHaveLength(1);
  });

  test('overlap at the bad threshold warns when not water-locked', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: RETURN,
      junctions: null, overlap: 0.4,
    });

    await generate();

    expect(warnings).toEqual([
      'This area has limited routing options — the loop overlaps significantly.',
    ]);
  });

  test('overlap just under the threshold does not warn', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: RETURN,
      junctions: null, overlap: 0.399,
    });

    await generate();

    expect(warnings).toHaveLength(0);
  });

  test('null overlap (non-smart / one-way) does not warn', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: null,
      junctions: null, overlap: null,
    });

    await generate();

    expect(warnings).toHaveLength(0);
  });
});

describe('undefined-legs path (smart routing built nothing)', () => {
  beforeEach(() => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: undefined, return: undefined,
      junctions: null, overlap: null,
    });
  });

  test('still displays the dest (dashed straight-line fallback is first-render UX)', async () => {
    await generate();

    expect(displayRouteCalls).toHaveLength(1);
    expect(displayRouteCalls[0].outbound).toBeUndefined();
    expect(displayRouteCalls[0].ret).toBeUndefined();
    expect(displayRouteCalls[0].destLat).toBe(61);
    expect(displayRouteCalls[0].destLng).toBe(25);
  });

  test('does not persist a fake walk to history / cloud', async () => {
    await generate();

    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('does not persist a truthy outbound with empty coords (finding #7926)', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: { coords: [], duration: 1, distance: 1 }, return: null,
      junctions: null, overlap: null,
    });

    await generate();

    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('one-way with an outbound leg still persists (return is always absent)', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: null,
      junctions: null, overlap: null,
    });
    document.getElementById('oneWay').checked = true;
    document.getElementById('roundTrip').checked = false;

    await generate();

    expect(saveToHistoryCalls).toHaveLength(1);
  });
});

describe('surpriseMe', () => {
  test('rejectIfBuilding runs before scrambling the form', () => {
    rejectBuilding = true;
    document.getElementById('locationTypeSelect').value = 'park';
    document.getElementById('minDistance').value = '1';
    document.getElementById('maxDistance').value = '5.2';
    document.getElementById('spreadSlider').value = '50';

    globalThis.surpriseMe();

    expect(document.getElementById('locationTypeSelect').value).toBe('park');
    expect(document.getElementById('minDistance').value).toBe('1');
    expect(document.getElementById('maxDistance').value).toBe('5.2');
    expect(document.getElementById('spreadSlider').value).toBe('50');
    expect(saveSettingsCalls).toBe(0);
    expect(inflight).toBeUndefined();
    expect(resolveStart).not.toHaveBeenCalled();
  });

  test('scrambles type / distance / spread, saves settings, then generates', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    globalThis.surpriseMe();
    await inflight;

    // random=0 → choices[0] = 'any_poi'; min=0; max=1; spread=0
    expect(document.getElementById('locationTypeSelect').value).toBe('any_poi');
    expect(document.getElementById('minDistance').value).toBe('0');
    expect(document.getElementById('maxDistance').value).toBe('1');
    expect(document.getElementById('spreadSlider').value).toBe('0');
    expect(saveSettingsCalls).toBe(1);
    expect(resolveStart).toHaveBeenCalledOnce();
    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(1);

    Math.random.mockRestore();
  });
});

describe('degraded routing (self-hosted OSRM unreachable)', () => {
  function degradedOptions() {
    globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
      tripMode,
      smartRouting: false,
      winterMode: false,
      maxKm: parseFloat(document.getElementById('maxDistance').value),
      spread: SPREAD,
      degraded: true,
    }));
  }

  test('threads degraded into the route build', async () => {
    degradedOptions();

    await generate();

    expect(buildRouteForDestination.mock.calls[0][2].degraded).toBe(true);
  });

  test('warns that routing is on the public backup', async () => {
    degradedOptions();

    await generate();

    expect(warnings.some((w) => /public/i.test(w))).toBe(true);
  });

  test('warns only once per page load, not once per generate', async () => {
    degradedOptions();

    await generate();
    await generate();

    expect(warnings.filter((w) => /public/i.test(w))).toHaveLength(1);
  });

  test('says nothing about a backup while self-hosted is healthy', async () => {
    await generate();

    expect(warnings.filter((w) => /public/i.test(w))).toHaveLength(0);
  });
});

describe('straight-line placeholder is announced', () => {
  test('warns that the dashed line is not a walking route', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: undefined, return: undefined,
      junctions: null, overlap: null,
    });

    await generate();

    expect(warnings.some((w) => /straight[- ]line/i.test(w))).toBe(true);
  });

  test('treats empty coords as no route, same as undefined legs', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: { coords: [], distance: 0, duration: 0 }, return: null,
      junctions: null, overlap: null,
    });

    await generate();

    expect(warnings.some((w) => /straight[- ]line/i.test(w))).toBe(true);
  });

  test('stays quiet about straight lines when a real route was built', async () => {
    await generate();

    expect(warnings.filter((w) => /straight[- ]line/i.test(w))).toHaveLength(0);
  });
});
