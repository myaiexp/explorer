// @vitest-environment jsdom
/**
 * Tests for settings.js — restoreSettings applies the trip-mode radio then
 * delegates the distance-label copy to syncDistanceLabel (finding #7316).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const FORM_HTML = `
  <input id="location" value="">
  <input id="minDistance" value="0">
  <input id="maxDistance" value="5">
  <select id="locationTypeSelect"><option value="park">park</option></select>
  <input id="spreadSlider" type="range" value="50">
  <input type="checkbox" id="winterMode">
  <input type="checkbox" id="smartRouting">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <label id="distanceLabel">Round-trip distance (km)</label>
`;

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    localStorage.clear();
    globalThis.syncDistanceLabel = vi.fn();
    loadScripts('settings');
});

describe('restoreSettings', () => {
    test('applies one-way radio then calls syncDistanceLabel', () => {
        localStorage.setItem('walk_settings', JSON.stringify({ tripMode: 'one-way' }));
        restoreSettings();
        expect(document.getElementById('oneWay').checked).toBe(true);
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
    });

    test('still syncs the label when tripMode is missing from the saved blob', () => {
        localStorage.setItem('walk_settings', JSON.stringify({ maxDistance: '8' }));
        restoreSettings();
        expect(document.getElementById('maxDistance').value).toBe('8');
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
    });
});
