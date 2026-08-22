/**
 * Tests for saved-locations.js — named start-location CRUD plus the
 * syncedPut/syncedDelete write-gating that visits/favorites/history already
 * pin (audit finding #7072, desync class from #5721/#5711).
 *
 * saved-locations.js is a non-module script that assigns
 * globalThis.{toggleSaveLocation,selectSavedLocation,deleteSavedLocation,
 * renderSavedLocations,updateSaveLocationBtn}. Collaborators
 * (getSavedLocations, syncedPut/syncedDelete, maybeRequestConsent,
 * showError/showSuccess, saveSettings) resolve as globals at call time, so
 * we install stubs then load it via helpers/load.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { installSyncedMirrorStubs } from './helpers/synced-mirror.js';

const SAVED_LOCATIONS_KEY = 'walk_saved_locations';
let putCalls;
let deleteCalls;
let setWriteOk;
let errors;
let successes;
let consentCalls;
let saveSettingsCalls;

function stored() {
  return JSON.parse(localStorage.getItem(SAVED_LOCATIONS_KEY) || '[]');
}

beforeEach(() => {
  localStorage.clear();
  errors = [];
  successes = [];
  consentCalls = 0;
  saveSettingsCalls = 0;

  document.body.innerHTML =
    '<input id="location" value="">' +
    '<button id="saveLocationBtn"><svg fill="none"></svg></button>' +
    '<div id="savedLocations"></div>';

  globalThis.SAVED_LOCATIONS_KEY = SAVED_LOCATIONS_KEY;
  globalThis.getSavedLocations = () =>
    JSON.parse(localStorage.getItem(SAVED_LOCATIONS_KEY) || '[]');
  globalThis.showError = (msg) => { errors.push(msg); };
  globalThis.showSuccess = (msg) => { successes.push(msg); };
  globalThis.maybeRequestConsent = () => { consentCalls++; };
  globalThis.saveSettings = () => { saveSettingsCalls++; };
  globalThis.prompt = vi.fn(() => 'Home');
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('sl-new');
  ({ putCalls, deleteCalls, setWriteOk } = installSyncedMirrorStubs());

  loadScripts('saved-locations');
});

function starFill() {
  return document.querySelector('#saveLocationBtn svg').getAttribute('fill');
}

describe('toggleSaveLocation: empty input', () => {
  test('errors and writes nothing when the input is blank', () => {
    document.getElementById('location').value = '   ';
    window.toggleSaveLocation();

    expect(errors).toEqual(['Enter a location first.']);
    expect(stored()).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
    expect(successes).toHaveLength(0);
  });
});

describe('toggleSaveLocation: add/remove round trip', () => {
  test('first call stores the location, fills the star, mirrors one put, and asks consent', () => {
    document.getElementById('location').value = 'Jyväskylä';
    window.toggleSaveLocation();

    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'sl-new', label: 'Home', value: 'Jyväskylä',
    });
    expect(starFill()).toBe('#fbbf24');
    expect(putCalls).toEqual([{ section: 'savedLocations', id: 'sl-new' }]);
    expect(deleteCalls).toHaveLength(0);
    expect(consentCalls).toBe(1);
    expect(successes).toEqual(['Location saved.']);
    expect(document.getElementById('savedLocations').children).toHaveLength(1);
    expect(globalThis.prompt).toHaveBeenCalledWith('Name for this location:', 'Jyväskylä');
  });

  test('an empty prompt label falls back to the input value', () => {
    globalThis.prompt.mockReturnValueOnce('');
    document.getElementById('location').value = 'Tampere';
    window.toggleSaveLocation();

    expect(stored()[0].label).toBe('Tampere');
    expect(stored()[0].value).toBe('Tampere');
  });

  test('cancelling the name prompt writes nothing', () => {
    globalThis.prompt.mockReturnValueOnce(null);
    document.getElementById('location').value = 'Oulu';
    window.toggleSaveLocation();

    expect(stored()).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
    expect(consentCalls).toBe(0);
    expect(successes).toHaveLength(0);
  });

  test('a second call for the same value removes it, unfills the star, and mirrors a delete', () => {
    document.getElementById('location').value = 'Jyväskylä';
    window.toggleSaveLocation();
    putCalls.length = 0;

    window.toggleSaveLocation();

    expect(stored()).toHaveLength(0);
    expect(starFill()).toBe('none');
    expect(deleteCalls).toEqual([{ section: 'savedLocations', id: 'sl-new' }]);
    expect(putCalls).toHaveLength(0);
    expect(successes).toEqual(['Location saved.', 'Location removed from saved.']);
    expect(document.getElementById('savedLocations').children).toHaveLength(0);
  });
});

describe('toggleSaveLocation: delete id fallback', () => {
  test('delete uses removed.id when present', () => {
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify([
      { id: 'legacy-1', label: 'Work', value: 'Office' },
    ]));
    document.getElementById('location').value = 'Office';

    window.toggleSaveLocation();

    expect(stored()).toHaveLength(0);
    expect(deleteCalls).toEqual([{ section: 'savedLocations', id: 'legacy-1' }]);
  });

  test('delete falls back to String(removed.value) when id is missing', () => {
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify([
      { label: 'Work', value: 'Office' },
    ]));
    document.getElementById('location').value = 'Office';

    window.toggleSaveLocation();

    expect(stored()).toHaveLength(0);
    expect(deleteCalls).toEqual([{ section: 'savedLocations', id: 'Office' }]);
  });
});

describe('toggleSaveLocation: hard-quota write failure (audit #5721)', () => {
  test('a failed put leaves the star unfilled, stores nothing, and does not toast success', () => {
    setWriteOk(false);
    document.getElementById('location').value = 'Jyväskylä';
    window.toggleSaveLocation();

    expect(stored()).toHaveLength(0);
    expect(starFill()).toBe('none');
    expect(putCalls).toHaveLength(0);
    expect(consentCalls).toBe(0);
    expect(successes).toHaveLength(0);
    expect(document.getElementById('savedLocations').children).toHaveLength(0);
  });

  test('a failed delete leaves the row and keeps the star filled', () => {
    document.getElementById('location').value = 'Jyväskylä';
    window.toggleSaveLocation();
    expect(stored()).toHaveLength(1);
    setWriteOk(false);

    window.toggleSaveLocation();

    expect(stored()).toHaveLength(1);
    expect(starFill()).toBe('#fbbf24');
    expect(deleteCalls).toHaveLength(0);
    expect(document.getElementById('savedLocations').children).toHaveLength(1);
  });
});

describe('deleteSavedLocation: index-based delete', () => {
  test("deletes by index, mirrors removed.id || String(value), and stops propagation", () => {
    const seed = [
      { id: 'a', label: 'A', value: 'one' },
      { id: 7, label: 'B', value: 'two' },
      { label: 'C', value: 'three' },
    ];
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(seed));
    window.renderSavedLocations();

    let stopped = false;
    window.deleteSavedLocation(1, { stopPropagation: () => { stopped = true; } });

    expect(stopped).toBe(true);
    expect(stored().map((s) => s.value)).toEqual(['one', 'three']);
    // Numeric id is forwarded as-is through `removed.id || …` (7 is truthy),
    // unlike favorites.js which always String()s. Pin the actual contract.
    expect(deleteCalls).toEqual([{ section: 'savedLocations', id: 7 }]);
    expect(document.getElementById('savedLocations').children).toHaveLength(2);
  });

  test('falls back to String(removed.value) when the row has no id', () => {
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify([
      { label: 'A', value: 'helsinki' },
    ]));
    window.renderSavedLocations();

    window.deleteSavedLocation(0, { stopPropagation: () => {} });

    expect(stored()).toHaveLength(0);
    expect(deleteCalls).toEqual([{ section: 'savedLocations', id: 'helsinki' }]);
  });

  test('a failed delete leaves storage and the rendered list unchanged', () => {
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify([
      { id: 'keep', label: 'Keep', value: 'stay' },
    ]));
    window.renderSavedLocations();
    setWriteOk(false);

    window.deleteSavedLocation(0, { stopPropagation: () => {} });

    expect(stored()).toEqual([{ id: 'keep', label: 'Keep', value: 'stay' }]);
    expect(deleteCalls).toHaveLength(0);
    expect(document.getElementById('savedLocations').children).toHaveLength(1);
  });
});
