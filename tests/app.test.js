// @vitest-environment jsdom
/**
 * Tests for app.js — the composition root. No other suite loads this file,
 * so three wirings were unguarded (finding #7583):
 *   • wander-sync-state-change → refreshDataViews (own-device merge used
 *     to stay invisible until reload; sync.test.js only asserts the event
 *     is dispatched, not that lists/visited/favorites re-render)
 *   • WanderSync.init().finally(updateSyncMenu)
 *   • restoreSettings() after poi-types has filled #locationTypeSelect
 *
 * Collaborators the composition root only *calls* are faked; poi-types and
 * settings load for real so a saved poiType has to match a catalog <option>.
 * app.js is not a SCRIPT_DEPS key — adding it would pull the root into every
 * suite that names it, clobbering those fakes.
 */
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { loadScripts, readScript } from './helpers/load.js';

const FORM_HTML = `
  <input id="location" value="">
  <input id="minDistance" value="0">
  <input id="maxDistance" value="5">
  <select id="locationTypeSelect"></select>
  <input id="spreadSlider" type="range" value="50">
  <input type="checkbox" id="winterMode">
  <input type="checkbox" id="avoidBacktracking">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
`;

const STUB_NAMES = [
    'renderVisitedLayer',
    'updateVisitedCounter',
    'renderFavoritesSection',
    'renderHistorySection',
    'renderSavedLocations',
    'updateSaveLocationBtn',
    'updateSyncMenu',
    'restoreFromHash',
    'syncDistanceLabel',
];

let initDeferred;
let initPromise;
let menuCallsAtLoad;

beforeAll(() => {
    document.body.innerHTML = FORM_HTML;
    localStorage.clear();
    localStorage.setItem('walk_settings', JSON.stringify({ poiType: 'museum' }));

    for (const name of STUB_NAMES) {
        globalThis[name] = vi.fn();
    }
    initPromise = new Promise((resolve) => {
        initDeferred = { resolve };
    });
    globalThis.WanderSync = { init: vi.fn(() => initPromise) };

    loadScripts('poi-types', 'settings');
    vi.spyOn(globalThis, 'restoreSettings');
    vi.spyOn(globalThis, 'initSettingsListeners');

    loadScripts('app');
    // Snapshot before any test settles init — the immediate updateSyncMenu()
    // at load is what the overflow menu shows while the GET is in flight.
    menuCallsAtLoad = updateSyncMenu.mock.calls.length;
});

afterAll(() => {
    // Leave no hanging thenables if a test filter skipped the settlement case.
    initDeferred.resolve();
});

describe('app.js composition root', () => {
    // Landmine 2 regression guard: settings.js's SETTINGS_FIELDS used to carry
    // a { id: 'smartRouting', ... } entry, and initSettingsListeners does an
    // unconditional getElementById(f.id).addEventListener(...) for every
    // entry — a stale entry throws `null.addEventListener` the moment the
    // element is deleted from the DOM, which (via app.js's init → restoreSettings
    // + initSettingsListeners) blanks the whole page at bootstrap. settings.js
    // loads for real in this suite (not faked), and FORM_HTML above has no
    // #smartRouting element at all, so beforeAll already exercised this path;
    // this test just makes the guarantee explicit and independently checkable.
    test('app bootstrap survives with no #smartRouting element in the DOM', () => {
        expect(document.getElementById('smartRouting')).toBeNull();
        expect(restoreSettings).toHaveBeenCalled();
        expect(initSettingsListeners).toHaveBeenCalled();
    });

    test('restoreSettings runs after poi-types filled the catalog select', () => {
        const sel = document.getElementById('locationTypeSelect');
        expect(restoreSettings).toHaveBeenCalledTimes(1);
        expect(initSettingsListeners).toHaveBeenCalledTimes(1);
        expect(sel.querySelector('optgroup')).not.toBeNull();
        expect([...sel.options].map((o) => o.value)).toContain('museum');
        // First option is 'any'; restore is what moves the selection to museum.
        expect(sel.value).toBe('museum');
    });

    test('init() is kicked off and updateSyncMenu runs immediately, before init settles', () => {
        expect(WanderSync.init).toHaveBeenCalledTimes(1);
        expect(menuCallsAtLoad).toBe(1);
        expect(restoreFromHash).toHaveBeenCalledTimes(1);
    });

    test('wander-sync-state-change re-renders visited, favorites, history, saved locations', () => {
        const snapshot = Object.fromEntries(
            [
                'renderVisitedLayer',
                'updateVisitedCounter',
                'renderFavoritesSection',
                'renderHistorySection',
                'renderSavedLocations',
            ].map((name) => [name, globalThis[name].mock.calls.length]),
        );
        // Top-level paint already ran each of these once; the listener is the
        // extra call that made own-device merges visible without a reload.
        for (const name of Object.keys(snapshot)) {
            expect(snapshot[name], name).toBeGreaterThanOrEqual(1);
        }

        window.dispatchEvent(new CustomEvent('wander-sync-state-change'));

        for (const [name, before] of Object.entries(snapshot)) {
            expect(globalThis[name].mock.calls.length, name).toBe(before + 1);
        }
    });

    test('init().finally calls updateSyncMenu once init settles', async () => {
        const before = updateSyncMenu.mock.calls.length;
        initDeferred.resolve();
        await initPromise;
        expect(updateSyncMenu.mock.calls.length).toBe(before + 1);
    });

    test('init chains updateSyncMenu with finally, not then', () => {
        // .then(updateSyncMenu) would skip the menu refresh on a rejected GET.
        // Runtime resolve() can't tell them apart, so pin the chain in source.
        expect(readScript('app')).toMatch(
            /WanderSync\.init\(\)\s*\.finally\(\s*updateSyncMenu\s*\)/,
        );
    });
});
