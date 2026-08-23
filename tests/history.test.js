/**
 * Tests for history.js — saveToHistory cap + cloud-mirror behavior, plus
 * delete/expand and name-vs-× clicks through real list-item.js (finding #7579).
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
let restored;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML =
    '<div id="historySection"><ul id="historyList"></ul><button id="historyMoreBtn"></button></div>';

  globalThis.HISTORY_KEY = HISTORY_KEY;
  globalThis.getHistory = () => JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  // snapshotSession normally derives the stored entry; the session we pass in
  // already carries id + date (+ render fields), so a shallow copy is faithful.
  globalThis.snapshotSession = (s) => ({ ...s });
  restored = [];
  globalThis.restoreResult = (entry) => { restored.push(entry); };
  globalThis.maybeRequestConsent = () => {};
  ({ putCalls, deleteCalls, setWriteOk } = installSyncedMirrorStubs());

  // Real list-item.js so name-vs-× clicks exercise the production handlers
  // (finding #7579). Other collaborators stay stubbed.
  loadScripts('list-item', 'visit-shape', 'history');
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

function seedHistory(rows) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(rows));
}

function itemAt(i) {
  return document.getElementById('historyList').children[i];
}

describe('deleteHistoryEntry', () => {
  test('removes the row at that index, mirrors its id as a string, and leaves the others', () => {
    seedHistory([
      { id: 'a', destLat: 60, destLng: 25, destName: 'A', date: '2026-01-01T00:00:00Z', distance: 1 },
      { id: 7, destLat: 61, destLng: 26, destName: 'B', date: '2026-01-02T00:00:00Z', distance: 2 },
      { id: 'c', destLat: 62, destLng: 27, destName: 'C', date: '2026-01-03T00:00:00Z', distance: 3 },
    ]);

    window.deleteHistoryEntry(1);

    expect(storedHistory().map((e) => e.id)).toEqual(['a', 'c']);
    expect(deleteCalls).toEqual([{ section: 'history', id: '7' }]);
    expect(document.getElementById('historyList').children).toHaveLength(2);
  });
});

describe('toggleHistoryExpanded', () => {
  test('shows the first 3 rows, then all of them, then collapses again', () => {
    const rows = [];
    for (let i = 0; i < 5; i++) {
      rows.push({
        id: 'h' + i,
        destLat: 60,
        destLng: 25,
        destName: 'Dest ' + i,
        date: '2026-01-0' + (i + 1) + 'T00:00:00Z',
        distance: 1,
      });
    }
    seedHistory(rows);
    window.renderHistorySection();

    const moreBtn = document.getElementById('historyMoreBtn');
    expect(document.getElementById('historyList').children).toHaveLength(3);
    expect(moreBtn.style.display).toBe('block');
    expect(moreBtn.textContent).toBe('Show 2 more');

    window.toggleHistoryExpanded();
    expect(document.getElementById('historyList').children).toHaveLength(5);
    expect(moreBtn.textContent).toBe('Show less');

    window.toggleHistoryExpanded();
    expect(document.getElementById('historyList').children).toHaveLength(3);
    expect(moreBtn.textContent).toBe('Show 2 more');
  });
});

describe('renderHistorySection: name vs × clicks (real list-item.js)', () => {
  test('clicking the name restores that row; clicking × deletes it without restoring', () => {
    seedHistory([
      { id: 'a', destLat: 60, destLng: 25, destName: 'Park', date: '2026-01-01T00:00:00Z', distance: 1.5 },
      { id: 'b', destLat: 61, destLng: 26, destName: 'Lake', date: '2026-01-02T00:00:00Z', distance: 2 },
    ]);
    window.renderHistorySection();

    itemAt(0).querySelector('.history-item-name').click();
    expect(restored.map((e) => e.id)).toEqual(['a']);

    itemAt(1).querySelector('.history-delete').click();
    expect(storedHistory().map((e) => e.id)).toEqual(['a']);
    expect(restored.map((e) => e.id)).toEqual(['a']); // × must stopPropagation
    expect(deleteCalls).toEqual([{ section: 'history', id: 'b' }]);
  });

  test('a skipped malformed row does not shift restore/delete onto the wrong walk', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedHistory([
      { id: 'a', destLat: 60, destLng: 25, destName: 'A', date: '2026-01-01T00:00:00Z', distance: 1 },
      { id: 'bad', destName: null, date: '2026-01-02T00:00:00Z' },
      { id: 'c', destLat: 62, destLng: 27, destName: 'C', date: '2026-01-03T00:00:00Z', distance: 3 },
    ]);
    window.renderHistorySection();
    expect(document.getElementById('historyList').children).toHaveLength(2);

    itemAt(1).querySelector('.history-item-name').click();
    expect(restored.map((e) => e.id)).toEqual(['c']);

    itemAt(1).querySelector('.history-delete').click();
    expect(storedHistory().map((e) => e.id)).toEqual(['a', 'bad']);
    expect(deleteCalls).toEqual([{ section: 'history', id: 'c' }]);
    warn.mockRestore();
  });
});
