// @vitest-environment jsdom
/**
 * Tests for settings.js — restoreSettings applies the trip-mode radio then
 * delegates the distance-label copy to syncDistanceLabel (finding #7316), and
 * saveSettings/restoreSettings round-trip every SETTINGS_FIELDS key including
 * checkbox booleans and skipEmpty blanks (finding #7580).
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
  <input type="checkbox" id="smartRouting">
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
    smartRouting: false,
    tripMode: 'round',
};

const NON_DEFAULTS = {
    location: 'Jyväskylä',
    minDistance: '2',
    maxDistance: '12',
    poiType: 'cafe',
    spread: '75',
    winterMode: true,
    smartRouting: true,
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
        smartRouting: document.getElementById('smartRouting').checked,
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
    document.getElementById('smartRouting').checked = values.smartRouting;
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

    test('checkbox false restores over a checked box (locks .checked, not .value)', () => {
        applyForm({ ...DEFAULTS, winterMode: false, smartRouting: false });
        saveSettings();
        expect(stored().winterMode).toBe(false);
        expect(stored().smartRouting).toBe(false);

        document.getElementById('winterMode').checked = true;
        document.getElementById('smartRouting').checked = true;
        restoreSettings();
        expect(document.getElementById('winterMode').checked).toBe(false);
        expect(document.getElementById('smartRouting').checked).toBe(false);
    });

    test('checkbox true restores over an unchecked box', () => {
        applyForm({ ...DEFAULTS, winterMode: true, smartRouting: true });
        saveSettings();
        document.getElementById('winterMode').checked = false;
        document.getElementById('smartRouting').checked = false;
        restoreSettings();
        expect(document.getElementById('winterMode').checked).toBe(true);
        expect(document.getElementById('smartRouting').checked).toBe(true);
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
        ['smartRouting', () => { document.getElementById('smartRouting').checked = true; }, { smartRouting: true }],
        ['oneWay', () => { document.getElementById('oneWay').checked = true; }, { tripMode: 'one-way' }],
    ])('%s change persists via saveSettings', (id, apply, expected) => {
        initSettingsListeners();
        apply();
        document.getElementById(id).dispatchEvent(new Event('change'));
        expect(stored()).toEqual(expect.objectContaining(expected));
    });
});
