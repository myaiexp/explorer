/**
 * Tests for history.js — saveToHistory cap + cloud-mirror behavior.
 *
 * history.js is a non-module script that assigns globalThis.saveToHistory. Its
 * free identifiers (getHistory, syncedPut, syncedDelete, snapshotSession, …)
 * resolve to the stubs installed on globalThis below — the same collaborators
 * index.html wires up at runtime — once helpers/load.js has evaluated it.
 *
 * These pin the audit fix: the HISTORY_MAX cap must mirror to the cloud (delete
 * the aged-off ids) instead of being local-only, or the server table grows without
 * bound per account and the next init merge resurrects the capped entries.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { installSyncedMirrorStubs } from './helpers/synced-mirror.js';

const HISTORY_KEY = 'walk_history';
let putCalls;
let deleteCalls;
let setWriteOk;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<div id="historySection"><ul id="historyList"></ul><button id="historyMoreBtn"></button></div>';

  globalThis.HISTORY_KEY = HISTORY_KEY;
  globalThis.getHistory = () => JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  // snapshotSession normally derives the stored entry; the session we pass in
  // already carries id + date (+ render fields), so a shallow copy is faithful.
  globalThis.snapshotSession = (s) => ({ ...s });
  globalThis.buildListItem = () => document.createElement('li');
  globalThis.maybeRequestConsent = () => {};
  ({ putCalls, deleteCalls, setWriteOk } = installSyncedMirrorStubs());

  loadScripts('visit-shape', 'history');
});

// A session whose entry sorts by date: larger i ⇒ newer. destName/destLat keep
// renderHistorySection (which runs on every save) from dereferencing undefined.
function sessionN(i) {
  return {
    id: 'h' + i,
    date: new Date(2026, 0, 1, 0, i).toISOString(),
    destName: 'Dest ' + i,
    destLat: 60,
    destLng: 25,
    distance: 1,
  };
}

function storedHistory() {
  return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
}

describe('saveToHistory cap mirrors to the cloud', () => {
  test('at the cap boundary: the 21st save drops exactly one id and deletes it from the cloud', () => {
    for (let i = 0; i < 20; i++) window.saveToHistory(sessionN(i)); // fills to the cap, no drops
    expect(storedHistory()).toHaveLength(20);
    expect(deleteCalls).toHaveLength(0);

    window.saveToHistory(sessionN(20)); // 21st → one entry ages off the tail

    const stored = storedHistory();
    expect(stored).toHaveLength(20); // still capped
    // h0 is the oldest → dropped locally AND deleted from the cloud.
    expect(stored.some((e) => e.id === 'h0')).toBe(false);
    expect(deleteCalls).toEqual([{ section: 'history', id: 'h0' }]);
  });

  test('keeps the most-recent HISTORY_MAX by date and deletes every aged-off id', () => {
    for (let i = 0; i < 25; i++) window.saveToHistory(sessionN(i));

    const stored = storedHistory();
    expect(stored).toHaveLength(20);
    const ids = stored.map((e) => e.id);
    // The 20 newest (h5..h24) survive; the 5 oldest (h0..h4) were dropped.
    expect(ids).toContain('h24');
    expect(ids).toContain('h5');
    expect(ids).not.toContain('h4');
    expect(ids).not.toContain('h0');
    // Each overflow save drops exactly the next-oldest, in ascending order.
    expect(deleteCalls.map((c) => c.id)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4']);
  });

  test('newest-first order: the sort keeps the freshest entry at the head', () => {
    for (let i = 0; i < 5; i++) window.saveToHistory(sessionN(i));
    expect(storedHistory().map((e) => e.id)).toEqual(['h4', 'h3', 'h2', 'h1', 'h0']);
  });

  test('a merge-ballooned history heals to the cap on the next save, deleting the overflow', () => {
    // Simulate a post-merge state: 30 rows already in localStorage.
    const ballooned = [];
    for (let i = 0; i < 30; i++) {
      ballooned.push({
        id: 'm' + i,
        date: new Date(2026, 0, 1, 0, i).toISOString(),
        destName: 'M' + i,
        destLat: 60,
        destLng: 25,
        distance: 1,
      });
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(ballooned));

    window.saveToHistory(sessionN(100)); // one new walk (newest by date)

    const stored = storedHistory();
    expect(stored).toHaveLength(20); // healed to the cap
    expect(stored[0].id).toBe('h100'); // new entry is newest
    // 31 rows sorted desc, cap 20 → the 11 oldest (m0..m10) are dropped + deleted.
    expect(deleteCalls).toHaveLength(11);
    expect(new Set(deleteCalls.map((c) => c.id))).toEqual(
      new Set(['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'])
    );
  });

  test('deletes carry the history section so the cloud mirror targets the right table', () => {
    for (let i = 0; i < 22; i++) window.saveToHistory(sessionN(i));
    expect(deleteCalls.every((c) => c.section === 'history')).toBe(true);
  });

  test('a hard-quota put failure does not mirror age-off deletes or rewrite storage', () => {
    for (let i = 0; i < 20; i++) window.saveToHistory(sessionN(i));
    putCalls.length = 0;
    deleteCalls.length = 0;
    setWriteOk(false);

    window.saveToHistory(sessionN(20));

    expect(storedHistory()).toHaveLength(20);
    expect(storedHistory().some((e) => e.id === 'h0')).toBe(true); // oldest still present
    expect(putCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });
});

describe('renderHistorySection: a malformed row does not abort first paint', () => {
  test('skips a row without finite dest coords and still renders the good ones', () => {
    // Finding #7307: destLat.toFixed on a corrupt local row threw out of
    // app.js's top-level init — the same class visitRenderParts already closed
    // for visits.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem(HISTORY_KEY, JSON.stringify([
      { id: 'good', destLat: 60, destLng: 25, destName: 'Park', date: '2026-01-01T00:00:00Z', distance: 1 },
      { id: 'bad', destName: null, date: '2026-01-02T00:00:00Z' },
    ]));

    expect(() => window.renderHistorySection()).not.toThrow();

    expect(document.getElementById('historySection').classList.contains('visible')).toBe(true);
    expect(document.getElementById('historyList').children).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 1/));
    warn.mockRestore();
  });

  test('when every row is unusable the section hides rather than staying empty-visible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    document.getElementById('historySection').classList.add('visible');
    localStorage.setItem(HISTORY_KEY, JSON.stringify([
      { id: 'bad', destLat: NaN, destLng: 25 },
    ]));

    expect(() => window.renderHistorySection()).not.toThrow();

    expect(document.getElementById('historySection').classList.contains('visible')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/skipped 1/));
    warn.mockRestore();
  });
});
