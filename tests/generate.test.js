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
  <input type="checkbox" id="avoidBacktracking">
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

  // session.js for real: the history gate is its isMeasuredWalk, a pure
  // predicate with no collaborators of its own to clobber.
  loadScripts('session', 'generate');
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

  // The wider envelope adds length for the same destination distance, so the
  // destination has to be picked closer or the loop runs past the budget. The
  // toggle owns both halves; splitting them would ship the length without the
  // allowance for it.
  test('avoid-backtracking round-trips divide by the wider 3.4 instead', async () => {
    document.getElementById('roundTrip').checked = true;
    document.getElementById('oneWay').checked = false;
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', winterMode: false, spread: SPREAD,
      maxKm: parseFloat(document.getElementById('maxDistance').value),
      avoidBacktracking: true,
    });

    await generate();

    const opts = resolveOpts();
    expect(opts.straightMin).toBeCloseTo(1 / 3.4);
    expect(opts.straightMax).toBeCloseTo(5.2 / 3.4);
  });

  test('one-way ignores it — there is no envelope to widen', async () => {
    document.getElementById('roundTrip').checked = false;
    document.getElementById('oneWay').checked = true;
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'one-way', winterMode: false, spread: SPREAD,
      maxKm: parseFloat(document.getElementById('maxDistance').value),
      avoidBacktracking: true,
    });

    await generate();

    const opts = resolveOpts();
    expect(opts.straightMax).toBeCloseTo(5.2 / 1.3);
  });
});

describe('pipeline wiring', () => {
  test('happy path displays, persists, and forwards dests / modes / spread', async () => {
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', winterMode: true,
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
      spread: SPREAD, winterMode: true,
      existingDests: [[62, 26]],
    }));
    // Smart routing is no longer a flag generate.js threads through — it is
    // unconditional inside destination-resolve.js's buildRouteForDestination
    // for any non-degraded round trip. generate.js must not even forward a
    // smartRouting key any more (the silent-downgrade guard, generate.js
    // side: see destination-resolve.test.js for the deeper one).
    expect(buildRouteForDestination.mock.calls[0][2]).not.toHaveProperty('smartRouting');

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

  test('winterMode from the helper reaches dest-pool and buildRouteForDestination', async () => {
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', winterMode: true,
      maxKm: 5.2, spread: SPREAD,
    });

    await generate();

    expect(resolveCandidatePool).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      winterMode: true,
    }));
    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      winterMode: true,
    }));
  });

  // The toggle's other half: the 3.4 divisor only picks a closer destination.
  // The wider envelope is built downstream, so the flag has to reach
  // buildRouteForDestination too — dropping it would shrink the walk while the
  // loop kept the legacy geometry.
  test('avoidBacktracking from the helper reaches buildRouteForDestination', async () => {
    readRouteBuildOptions.mockReturnValue({
      tripMode: 'round', winterMode: false,
      maxKm: 5.2, spread: SPREAD, avoidBacktracking: true,
    });

    await generate();

    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      avoidBacktracking: true,
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

// The silent-downgrade guard, at the real route-view.js ↔ generate.js seam:
// unlike every other test in this file, these load the REAL readRouteBuildOptions
// (route-view.js) instead of faking it, so a mistake in how route-view.js
// derives smartRouting — or in how generate.js threads tripMode/degraded down
// — shows up here even though buildRouteForDestination itself stays faked.
// FORM_HTML above has no #smartRouting element (the toggle is gone); loading
// route-view.js here proves readRouteBuildOptions works without it.
describe('real route-view.js wiring (no #smartRouting element anywhere)', () => {
  beforeEach(() => {
    expect(document.getElementById('smartRouting')).toBeNull();
    globalThis.isSelfHostedDown = vi.fn(() => false);
    // Overwrites the faked readRouteBuildOptions installed by the outer
    // beforeEach with the real implementation from route-view.js. route-view's
    // SCRIPT_DEPS (session-state.js, result-panel.js) and route-view.js itself
    // also overwrite this file's setCurrentSession / resetResultPanel /
    // displayRoute fakes with real implementations that need DOM this suite's
    // minimal FORM_HTML doesn't carry (markVisitedBtn, resultPanel, …) — restore
    // them so only readRouteBuildOptions is actually real for this describe.
    loadScripts('route-view');
    globalThis.setCurrentSession = (v) => { if (v === null) sessionClears++; };
    globalThis.resetResultPanel = () => { panelResets++; };
    globalThis.displayRoute = (args) => {
      displayRouteCalls.push(args);
      return { id: 'sess-1', ...args };
    };
  });

  test('a round-trip generate still takes the multi-candidate findBestLoop path (smartRouting is not lost between route-view.js and generate.js)', async () => {
    document.getElementById('roundTrip').checked = true;
    document.getElementById('oneWay').checked = false;

    await generate();

    // destination-resolve.js runs findBestLoop unconditionally for any
    // non-degraded round trip — generate.js just needs to get tripMode and
    // degraded down there correctly, which is what this pins.
    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      tripMode: 'round', degraded: false,
    }));
  });

  // The checkbox end to end: route-view.js reads #avoidBacktracking, and
  // generate.js has to both widen the divisor and forward the flag.
  test('a checked #avoidBacktracking widens the divisor and reaches the route build', async () => {
    document.getElementById('roundTrip').checked = true;
    document.getElementById('oneWay').checked = false;
    document.getElementById('avoidBacktracking').checked = true;

    await generate();

    expect(resolveOpts().straightMax).toBeCloseTo(5.2 / 3.4);
    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      tripMode: 'round', avoidBacktracking: true,
    }));
  });

  test('an unchecked #avoidBacktracking keeps the 2.6 divisor and forwards false', async () => {
    document.getElementById('roundTrip').checked = true;
    document.getElementById('oneWay').checked = false;
    document.getElementById('avoidBacktracking').checked = false;

    await generate();

    expect(resolveOpts().straightMax).toBeCloseTo(5.2 / 2.6);
    expect(buildRouteForDestination.mock.calls[0][2].avoidBacktracking).toBe(false);
  });

  test('one-way builds are unchanged', async () => {
    document.getElementById('roundTrip').checked = false;
    document.getElementById('oneWay').checked = true;

    await generate();

    expect(buildRouteForDestination).toHaveBeenCalledWith(60, 24, expect.objectContaining({
      tripMode: 'one-way',
    }));
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

  // Idea #3807: computeRouteTotals substitutes the crow-flies distance for a
  // missing return leg, so a round trip that only routed outbound was stored in
  // history and the cloud backup with half its distance fabricated — presented
  // as measured km, and with the missing leg's time dropped from the duration.
  test('does not persist a round trip whose return leg failed', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: null,
      junctions: null, overlap: null,
    });

    await generate();

    expect(displayRouteCalls).toHaveLength(1);
    expect(saveToHistoryCalls).toHaveLength(0);
  });

  test('does not persist a round trip whose return leg has empty coords', async () => {
    buildRouteForDestination.mockResolvedValue({
      dest: DEST, destName: 'Park',
      outbound: OUTBOUND, return: { coords: [], distance: 1, duration: 1 },
      junctions: null, overlap: null,
    });

    await generate();

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

describe('the build that discovers the outage', () => {
  test('warns even though it started before the latch tripped', async () => {
    // The first build after a page load reads degraded:false — the latch is
    // per-page-load module state and nothing has failed yet. Layer 1 then
    // falls back mid-flight, so the build IS degraded by the time it finishes.
    // It is also the slowest one (it pays the self-hosted timeout first), so
    // it is precisely the build that needs explaining.
    let call = 0;
    globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
      tripMode,
      smartRouting: tripMode !== 'one-way',
      winterMode: false,
      maxKm: parseFloat(document.getElementById('maxDistance').value),
      spread: SPREAD,
      degraded: call++ > 0,
    }));

    await generate();

    expect(warnings.some((w) => /public/i.test(w))).toBe(true);
  });

  test('still reduces nothing on that first build — the flag it passed was false', async () => {
    let call = 0;
    globalThis.readRouteBuildOptions = vi.fn((tripMode) => ({
      tripMode,
      smartRouting: tripMode !== 'one-way',
      winterMode: false,
      maxKm: parseFloat(document.getElementById('maxDistance').value),
      spread: SPREAD,
      degraded: call++ > 0,
    }));

    await generate();

    // Pipeline reduction is decided up front and must not be retro-applied.
    expect(buildRouteForDestination.mock.calls[0][2].degraded).toBe(false);
  });
});
