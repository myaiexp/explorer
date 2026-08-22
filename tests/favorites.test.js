/**
 * Tests for favorites.js — the star-button add/remove/list CRUD paths, which
 * had zero coverage before this file (audit finding #5400, favorites half).
 *
 * favorites.js is a non-module script that assigns globalThis.{toggleFavorite,
 * updateFavoriteBtn,deleteFavorite,renderFavoritesSection,sameFavoriteDest}. It
 * resolves its collaborators (getFavorites, syncedPut/syncedDelete,
 * snapshotSession, getCurrentSession, buildListItem, restoreResult,
 * maybeRequestConsent) as globals at call time, so we install stubs on
 * globalThis before loading it via helpers/load.js.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { installSyncedMirrorStubs } from './helpers/synced-mirror.js';

const FAVORITES_KEY = 'walk_favorites';
let putCalls;
let deleteCalls;
let setWriteOk;
let currentSession;

function storedFavs() {
  return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
}

// Minimal session fixture: destLat/destLng drive sameFavoriteDest; id/date
// stand in for what the real snapshotSession would stamp via crypto.randomUUID
// + new Date().toISOString() (stubbed below to a shallow copy).
function session(overrides) {
  return {
    id: 's1',
    date: '2026-01-01T00:00:00.000Z',
    startLat: 60, startLng: 25, startLabel: 'Home',
    destLat: 60.1, destLng: 25.1, destName: 'Park',
    tripMode: 'round-trip', distance: 3,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  currentSession = null;

  document.body.innerHTML =
    '<button id="favoriteBtn"></button>' +
    '<div id="favoritesSection"><div id="favoritesList"></div></div>';

  globalThis.FAVORITES_KEY = FAVORITES_KEY;
  globalThis.getFavorites = () => JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
  globalThis.getCurrentSession = () => currentSession;
  // snapshotSession normally stamps a fresh crypto.randomUUID() id + date; the
  // fixture sessions above already carry the fields we need, so a shallow
  // copy is faithful (same simplification history.test.js makes).
  globalThis.snapshotSession = (s) => ({ ...s });
  globalThis.buildListItem = (label, meta) => {
    const item = document.createElement('div');
    item.className = 'fav-item';
    item.dataset.label = label;
    item.dataset.meta = meta;
    return item;
  };
  globalThis.restoreResult = () => {};
  globalThis.maybeRequestConsent = () => {};
  ({ putCalls, deleteCalls, setWriteOk } = installSyncedMirrorStubs());

  loadScripts('visit-shape', 'favorites');
});

describe('toggleFavorite: add/remove round trip', () => {
  test('first call stores the favorite, marks the button active, and mirrors exactly one put', () => {
    currentSession = session({ id: 42, destLat: 60.1, destLng: 25.1 });
    window.toggleFavorite();

    const favs = storedFavs();
    expect(favs).toHaveLength(1);
    expect(favs[0].id).toBe(42);
    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(true);
    // put does NOT coerce the id — it forwards newFav.id through as-is.
    expect(putCalls).toEqual([{ section: 'favorites', id: 42 }]);
    expect(deleteCalls).toHaveLength(0);
  });

  test('a second call for the same destination removes it, drops .active, and mirrors a delete with the id cast to a string', () => {
    currentSession = session({ id: 42, destLat: 60.1, destLng: 25.1 });
    window.toggleFavorite(); // add
    putCalls.length = 0; // isolate the second call's mirror

    window.toggleFavorite(); // same dest → remove

    expect(storedFavs()).toHaveLength(0);
    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(false);
    // delete DOES coerce via String(removed.id) — 42 (number) becomes '42'
    // (string), unlike the put path above. This asymmetry is deliberate in
    // the source (matches the String() cast history.js also applies); pin it
    // so a refactor that "cleans up" one call site without the other is caught.
    expect(deleteCalls).toEqual([{ section: 'favorites', id: '42' }]);
    expect(putCalls).toHaveLength(0);
  });
});

describe('sameFavoriteDest: matches by dest coords at 6-decimal precision', () => {
  test('a dest differing only past the 6th decimal rounds to the same favorite (toggle removes, no duplicate)', () => {
    // 62.1234561 and 62.1234564 differ at the 7th decimal digit (1 vs 4) but
    // both round DOWN there, so toFixed(6) agrees for both. sameFavoriteDest
    // must treat these as the SAME destination.
    expect((62.1234561).toFixed(6)).toBe('62.123456');
    expect((62.1234564).toFixed(6)).toBe('62.123456');

    currentSession = session({ id: 'p', destLat: 62.1234561, destLng: 25 });
    window.toggleFavorite(); // adds
    expect(storedFavs()).toHaveLength(1);

    // The matching branch deletes the STORED favorite's id ('p'), not this
    // session's id — the session's own id is irrelevant to the match.
    currentSession = session({ id: 'not-used-by-the-match-branch', destLat: 62.1234564, destLng: 25 });
    window.toggleFavorite(); // matches the stored favorite → removes, does not add a 2nd

    expect(storedFavs()).toHaveLength(0);
    expect(deleteCalls).toEqual([{ section: 'favorites', id: 'p' }]);
  });

  test('a dest differing at the 6th decimal itself (or coarser) is a distinct favorite (toggle adds a second entry)', () => {
    // 62.123456 vs 62.123457 differ in the 6th decimal digit itself — no
    // rounding ambiguity, toFixed(6) disagrees, so these are different dests.
    expect((62.123456).toFixed(6)).toBe('62.123456');
    expect((62.123457).toFixed(6)).toBe('62.123457');

    currentSession = session({ id: 'q', destLat: 62.123456, destLng: 25 });
    window.toggleFavorite(); // adds #1

    currentSession = session({ id: 'r', destLat: 62.123457, destLng: 25 });
    window.toggleFavorite(); // adds #2 — distinct destination, no match found

    expect(storedFavs()).toHaveLength(2);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe('toggleFavorite: new favorites go to the head', () => {
  test('after adding two different destinations, the most recent is at index 0', () => {
    currentSession = session({ id: 'first', destLat: 60, destLng: 25 });
    window.toggleFavorite();
    currentSession = session({ id: 'second', destLat: 61, destLng: 26 });
    window.toggleFavorite();

    expect(storedFavs().map((f) => f.id)).toEqual(['second', 'first']);
  });
});

describe('toggleFavorite: hard-quota write failure (audit #5721)', () => {
  test('a failed put leaves the star inactive and stores nothing', () => {
    setWriteOk(false);
    currentSession = session({ id: 42, destLat: 60.1, destLng: 25.1 });
    window.toggleFavorite();

    expect(storedFavs()).toHaveLength(0);
    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(false);
    expect(putCalls).toHaveLength(0);
  });

  test('a failed delete leaves the row and keeps the star active', () => {
    currentSession = session({ id: 42, destLat: 60.1, destLng: 25.1 });
    window.toggleFavorite(); // add succeeds
    expect(storedFavs()).toHaveLength(1);
    setWriteOk(false);

    window.toggleFavorite(); // remove fails

    expect(storedFavs()).toHaveLength(1);
    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(true);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe('deleteFavorite: index-based delete', () => {
  test("deletes by index, leaves the others in order, mirrors the deleted row's id as a string, and stops propagation", () => {
    // Seed directly — this path is reached from a list-item click, not toggleFavorite.
    const seed = [
      { id: 'a', destLat: 1, destLng: 1 },
      { id: 7, destLat: 2, destLng: 2 },
      { id: 'c', destLat: 3, destLng: 3 },
    ];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(seed));

    let stopped = false;
    const fakeEvent = { stopPropagation: () => { stopped = true; } };

    window.deleteFavorite(1, fakeEvent); // the middle row

    expect(stopped).toBe(true);
    expect(storedFavs().map((f) => f.id)).toEqual(['a', 'c']);
    // Index-based delete also runs through String(removed.id) — this is the
    // path the audit flagged as uncovered, so pin its id-mirroring exactly.
    expect(deleteCalls).toEqual([{ section: 'favorites', id: '7' }]);
  });
});

describe('updateFavoriteBtn: reflects favorite state both ways', () => {
  test('turns .active on when the current session matches a stored favorite', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ id: 'a', destLat: 60.5, destLng: 25.5 }]));
    currentSession = session({ destLat: 60.5, destLng: 25.5 });

    window.updateFavoriteBtn();

    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(true);
  });

  test('turns .active off when the current session does not match any stored favorite', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ id: 'a', destLat: 60.5, destLng: 25.5 }]));
    document.getElementById('favoriteBtn').classList.add('active'); // stale state from a prior dest
    currentSession = session({ destLat: 1, destLng: 1 });

    window.updateFavoriteBtn();

    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(false);
  });

  test('turns .active off when there is no current session at all', () => {
    document.getElementById('favoriteBtn').classList.add('active'); // stale state
    currentSession = null;

    window.updateFavoriteBtn();

    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(false);
  });
});

describe('renderFavoritesSection: visibility + rebuild', () => {
  test('adds .visible and renders one item per favorite when non-empty', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'a', destLat: 1, destLng: 1, destName: 'A' },
      { id: 'b', destLat: 2, destLng: 2, destName: 'B' },
    ]));

    window.renderFavoritesSection();

    expect(document.getElementById('favoritesSection').classList.contains('visible')).toBe(true);
    expect(document.getElementById('favoritesList').children).toHaveLength(2);
  });

  test('removes .visible when there are no favorites', () => {
    document.getElementById('favoritesSection').classList.add('visible'); // stale from a prior render
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([]));

    window.renderFavoritesSection();

    expect(document.getElementById('favoritesSection').classList.contains('visible')).toBe(false);
  });

  test('rebuilds the list rather than appending to it across renders', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'a', destLat: 1, destLng: 1, destName: 'A' },
      { id: 'b', destLat: 2, destLng: 2, destName: 'B' },
    ]));
    window.renderFavoritesSection();
    expect(document.getElementById('favoritesList').children).toHaveLength(2);

    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'a', destLat: 1, destLng: 1, destName: 'A' },
    ]));
    window.renderFavoritesSection();

    // If the list were appended-to instead of replaced, this would be 3.
    expect(document.getElementById('favoritesList').children).toHaveLength(1);
  });

  test('a row without finite dest coords is skipped instead of aborting first paint', () => {
    // Finding #7307: destLat.toFixed on a missing/non-number dest threw out of
    // app.js's top-level init and skipped history, hash restore, and later work.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'good', destLat: 1, destLng: 1, destName: 'A' },
      { id: 'bad', destName: null },
      { id: 'wrapped', payload: [] },
    ]));

    expect(() => window.renderFavoritesSection()).not.toThrow();

    expect(document.getElementById('favoritesSection').classList.contains('visible')).toBe(true);
    expect(document.getElementById('favoritesList').children).toHaveLength(1);
    expect(document.getElementById('favoritesList').children[0].dataset.label).toBe('A');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 2/));
    warn.mockRestore();
  });

  test('when every row is unusable the section hides rather than staying empty-visible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.getElementById('favoritesSection').classList.add('visible');
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'bad', destLat: 'x', destLng: 1 },
    ]));

    expect(() => window.renderFavoritesSection()).not.toThrow();

    expect(document.getElementById('favoritesSection').classList.contains('visible')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 1/));
    warn.mockRestore();
  });
});

describe('sameFavoriteDest / updateFavoriteBtn: a bad stored row does not throw', () => {
  test('sameFavoriteDest returns false when either side lacks finite dest coords', () => {
    const dest = session({ destLat: 60.1, destLng: 25.1 });
    expect(window.sameFavoriteDest({ destLat: undefined, destLng: 25.1 }, dest)).toBe(false);
    expect(window.sameFavoriteDest({ payload: 'x' }, dest)).toBe(false);
    expect(window.sameFavoriteDest(dest, { destLat: 60.1 })).toBe(false);
  });

  test('updateFavoriteBtn ignores a malformed stored favorite instead of throwing', () => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([
      { id: 'bad' },
      { id: 'good', destLat: 60.5, destLng: 25.5 },
    ]));
    currentSession = session({ destLat: 60.5, destLng: 25.5 });

    expect(() => window.updateFavoriteBtn()).not.toThrow();
    expect(document.getElementById('favoriteBtn').classList.contains('active')).toBe(true);
  });
});
