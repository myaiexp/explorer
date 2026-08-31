// @vitest-environment jsdom
/**
 * Tests for settings.js — restoreSettings applies the trip-mode radio then
 * delegates the distance-label copy to syncDistanceLabel (finding #7316), and
 * saveSettings/restoreSettings round-trip every SETTINGS_FIELDS key including
 * checkbox booleans and skipEmpty blanks (finding #7580).
 *
 * Smart routing is no longer a checkbox — the #smartRouting element does not
 * exist in FORM_HTML below, and SETTINGS_FIELDS no longer has an entry for it
 * (a stale entry would throw at bootstrap: initSettingsListeners does an
 * unconditional getElementById(f.id) for every entry in the array). Any
 * smartRouting key left over in a previously-saved localStorage blob is
 * simply ignored by restoreSettings — there is no matching SETTINGS_FIELDS
 * entry to apply it to.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const SETTINGS_KEY = 'walk_settings';

const FORM_HTML = `
  <input id="location" value="Helsinki">
  <input id="minDistance" value="0">
  <input id="maxDistance" value="5">
  <select id="locationTypeSelect">
    <option value="park">park</option>
    <option value="cafe">cafe</option>
    <option value="any">any</option>
  </select>
  <input id="spreadSlider" type="range" min="0" max="100" value="50">
  <input type="checkbox" id="winterMode">
  <input type="checkbox" id="avoidBacktracking">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <label id="distanceLabel">Round-trip distance (km)</label>
`;

const DEFAULTS = {
    location: 'Helsinki',
    minDistance: '0',
    maxDistance: '5',
    poiType: 'park',
    spread: '50',
    winterMode: false,
    avoidBacktracking: false,
    tripMode: 'round',
};

const NON_DEFAULTS = {
    location: 'Jyväskylä',
    minDistance: '2',
    maxDistance: '12',
    poiType: 'cafe',
    spread: '75',
    winterMode: true,
    avoidBacktracking: true,
    tripMode: 'one-way',
};

function readForm() {
    return {
        location: document.getElementById('location').value,
        minDistance: document.getElementById('minDistance').value,
        maxDistance: document.getElementById('maxDistance').value,
        poiType: document.getElementById('locationTypeSelect').value,
        spread: document.getElementById('spreadSlider').value,
        winterMode: document.getElementById('winterMode').checked,
        avoidBacktracking: document.getElementById('avoidBacktracking').checked,
        tripMode: document.querySelector('input[name="tripMode"]:checked').value,
    };
}

function applyForm(values) {
    document.getElementById('location').value = values.location;
    document.getElementById('minDistance').value = values.minDistance;
    document.getElementById('maxDistance').value = values.maxDistance;
    document.getElementById('locationTypeSelect').value = values.poiType;
    document.getElementById('spreadSlider').value = values.spread;
    document.getElementById('winterMode').checked = values.winterMode;
    document.getElementById('avoidBacktracking').checked = values.avoidBacktracking;
    document.getElementById('roundTrip').checked = values.tripMode !== 'one-way';
    document.getElementById('oneWay').checked = values.tripMode === 'one-way';
}

function stored() {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    localStorage.clear();
    globalThis.syncDistanceLabel = vi.fn();
    loadScripts('settings');
});

describe('restoreSettings', () => {
    test('applies one-way radio then calls syncDistanceLabel', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ tripMode: 'one-way' }));
        restoreSettings();
        expect(document.getElementById('oneWay').checked).toBe(true);
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
    });

    test('still syncs the label when tripMode is missing from the saved blob', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ maxDistance: '8' }));
        restoreSettings();
        expect(document.getElementById('maxDistance').value).toBe('8');
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
    });

    test('corrupt JSON is a no-op — the form and the label stay as they are', () => {
        localStorage.setItem(SETTINGS_KEY, '{not json');
        restoreSettings();
        expect(readForm()).toEqual(DEFAULTS);
        expect(syncDistanceLabel).not.toHaveBeenCalled();
    });

    test('skipEmpty blanks do not clobber location / poiType defaults', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            location: '',
            poiType: '',
            maxDistance: '8',
        }));
        restoreSettings();
        expect(document.getElementById('location').value).toBe('Helsinki');
        expect(document.getElementById('locationTypeSelect').value).toBe('park');
        expect(document.getElementById('maxDistance').value).toBe('8');
    });

    // Landmine 2 regression test: a leftover smartRouting key in a
    // previously-saved blob (from before the checkbox was removed) must be
    // silently ignored, not crash restoreSettings by trying to find an
    // element that is gone.
    test('a leftover smartRouting key in a saved blob is ignored harmlessly', () => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...NON_DEFAULTS, smartRouting: true }));
        expect(() => restoreSettings()).not.toThrow();
        expect(readForm()).toEqual(NON_DEFAULTS);
    });
});

describe('saveSettings / restoreSettings round-trip', () => {
    test('every SETTINGS_FIELDS key plus tripMode survives save then restore', () => {
        applyForm(NON_DEFAULTS);
        saveSettings();

        applyForm(DEFAULTS);
        expect(readForm()).toEqual(DEFAULTS);

        restoreSettings();
        expect(readForm()).toEqual(NON_DEFAULTS);
    });

    test('saveSettings does not persist a smartRouting key any more', () => {
        applyForm(NON_DEFAULTS);
        saveSettings();
        expect(stored()).not.toHaveProperty('smartRouting');
    });

    test('checkbox false restores over a checked box (locks .checked, not .value)', () => {
        applyForm({ ...DEFAULTS, winterMode: false });
        saveSettings();
        expect(stored().winterMode).toBe(false);

        document.getElementById('winterMode').checked = true;
        restoreSettings();
        expect(document.getElementById('winterMode').checked).toBe(false);
    });

    test('checkbox true restores over an unchecked box', () => {
        applyForm({ ...DEFAULTS, winterMode: true });
        saveSettings();
        document.getElementById('winterMode').checked = false;
        restoreSettings();
        expect(document.getElementById('winterMode').checked).toBe(true);
    });
});

describe('initSettingsListeners', () => {
    test.each([
        ['location', () => { document.getElementById('location').value = 'Tampere'; }, { location: 'Tampere' }],
        ['minDistance', () => { document.getElementById('minDistance').value = '1.5'; }, { minDistance: '1.5' }],
        ['maxDistance', () => { document.getElementById('maxDistance').value = '9'; }, { maxDistance: '9' }],
        ['locationTypeSelect', () => { document.getElementById('locationTypeSelect').value = 'any'; }, { poiType: 'any' }],
        ['spreadSlider', () => { document.getElementById('spreadSlider').value = '20'; }, { spread: '20' }],
        ['winterMode', () => { document.getElementById('winterMode').checked = true; }, { winterMode: true }],
        ['oneWay', () => { document.getElementById('oneWay').checked = true; }, { tripMode: 'one-way' }],
    ])('%s change persists via saveSettings', (id, apply, expected) => {
        initSettingsListeners();
        apply();
        document.getElementById(id).dispatchEvent(new Event('change'));
        expect(stored()).toEqual(expect.objectContaining(expected));
    });

    // Landmine 2's crash site, directly: SETTINGS_FIELDS used to carry a
    // { id: 'smartRouting', ... } entry, and this function does an
    // unconditional document.getElementById(f.id).addEventListener(...) for
    // every entry — a stale entry throws `null.addEventListener` at app
    // bootstrap the moment the element is deleted from the DOM. FORM_HTML
    // above has no #smartRouting element at all; this pins that
    // initSettingsListeners (and, by extension, app bootstrap) survives that.
    test('app bootstrap survives with no #smartRouting element in the DOM', () => {
        expect(document.getElementById('smartRouting')).toBeNull();
        expect(() => initSettingsListeners()).not.toThrow();
        expect(() => saveSettings()).not.toThrow();
        expect(() => restoreSettings()).not.toThrow();
    });
});
