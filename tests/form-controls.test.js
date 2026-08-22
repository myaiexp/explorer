// @vitest-environment jsdom
/**
 * Tests for form-controls.js — the trip-mode change listener must call
 * syncDistanceLabel rather than inlining the two label strings (finding #7316).
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const FORM_HTML = `
  <input id="location">
  <input id="minDistance">
  <input id="maxDistance">
  <input type="radio" name="tripMode" id="roundTrip" value="round" checked>
  <input type="radio" name="tripMode" id="oneWay" value="one-way">
  <label id="distanceLabel">Round-trip distance (km)</label>
`;

beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
    globalThis.generateDestination = () => {};
    globalThis.syncDistanceLabel = vi.fn();
    loadScripts('form-controls');
});

describe('trip-mode change', () => {
    test('calls syncDistanceLabel instead of writing the label itself', () => {
        document.getElementById('oneWay').checked = true;
        document.getElementById('oneWay').dispatchEvent(new Event('change'));
        expect(syncDistanceLabel).toHaveBeenCalledTimes(1);
        expect(document.getElementById('distanceLabel').textContent)
            .toBe('Round-trip distance (km)');
    });
});
