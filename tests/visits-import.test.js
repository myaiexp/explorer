/**
 * Tests for visits-io.js's import path — applyImportedVisits' merge contract plus
 * importVisits' FileReader/error plumbing.
 *
 * visit-shape.js and visits-io.js are non-module browser scripts; helpers/load.js
 * evaluates them in index.html's order so their free identifiers resolve to the
 * stubs installed on globalThis.
 *
 * These pin two audit fixes:
 *  - Unvalidated rows used to be written to localStorage and queued for upload
 *    before anything looked at them; a row missing distance/startLat then threw in
 *    renderVisitedLayer, which also runs at app.js's top level — so every later
 *    page load aborted part-way through init with no in-app recovery.
 *  - One try block wrapped parse, persist, sync, consent, toast and both
 *    re-renders, so ANY failure was reported as "invalid JSON file" and swallowed
 *    with no console trace, hiding that a partial import had already happened.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

const VISITS_KEY = 'walk_visits';
let mutations;
let toasts;
let renders;

beforeEach(() => {
  localStorage.clear();
  mutations = [];
  toasts = [];
  renders = 0;

  globalThis.VISITS_KEY = VISITS_KEY;
  globalThis.getVisits = () => JSON.parse(localStorage.getItem(VISITS_KEY) || '[]');
  // Real persist — the whole point is observing what actually lands in storage.
  globalThis.writeStoredArray = (key, arr) => {
    localStorage.setItem(key, JSON.stringify(arr));
    return true;
  };
  globalThis.ExplorerSync = {
    mutate: (section, op, id, data) => mutations.push({ section, op, id, data }),
  };
  globalThis.maybeRequestConsent = vi.fn();
  globalThis.showError = (m) => toasts.push({ variant: 'error', message: m });
  globalThis.showSuccess = (m) => toasts.push({ variant: 'success', message: m });
  globalThis.showWarning = (m) => toasts.push({ variant: 'warning', message: m });
  globalThis.updateVisitedCounter = vi.fn();
  globalThis.renderVisitedLayer = () => { renders++; };

  // visits-io depends on visit-shape (SCRIPT_DEPS), same order as before.
  loadScripts('visits-io');
});

function validRow(over = {}) {
  return {
    id: 'v1',
    date: '2026-07-01T08:30:00.000Z',
    startLat: 62.24,
    startLng: 25.75,
    startLabel: 'Jyväskylä',
    destLat: 62.28,
    destLng: 25.8,
    destName: 'Harju',
    tripMode: 'round',
    distance: 4.2,
    ...over,
  };
}

function stored() {
  return JSON.parse(localStorage.getItem(VISITS_KEY) || '[]');
}

const puts = () => mutations.filter((m) => m.op === 'put');

describe('applyImportedVisits — merge contract', () => {
  test('appends new rows and mirrors exactly one put per row', () => {
    const result = applyImportedVisits([validRow(), validRow({ id: 'v2' })]);

    expect(result).toEqual({ added: 2, skipped: 0 });
    expect(stored().map((v) => v.id)).toEqual(['v1', 'v2']);
    expect(mutations).toHaveLength(2);
    expect(mutations.every((m) => m.section === 'visits' && m.op === 'put')).toBe(true);
    expect(puts().map((m) => m.id)).toEqual(['v1', 'v2']);
    // The mirrored payload is the normalized row, not the raw file row.
    expect(puts()[0].data).toEqual(stored()[0]);
    expect(globalThis.maybeRequestConsent).toHaveBeenCalled();
  });

  test('dedupes against ids already in storage', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify([validRow()]));

    const result = applyImportedVisits([validRow(), validRow({ id: 'v2' })]);

    expect(result.added).toBe(1);
    expect(stored().map((v) => v.id)).toEqual(['v1', 'v2']);
    // No re-upload of the row the cloud already has.
    expect(puts().map((m) => m.id)).toEqual(['v2']);
  });

  test('back-fills a missing id and mirrors under that same id', () => {
    // Legacy/foreign files predate ids; without a back-fill the row would upload
    // under `undefined` and the server would reject it.
    applyImportedVisits([validRow({ id: undefined })]);

    const row = stored()[0];
    expect(typeof row.id).toBe('string');
    expect(row.id).not.toBe('');
    expect(puts()).toHaveLength(1);
    expect(puts()[0].id).toBe(row.id);
  });

  test('a traversal-shaped id is replaced, so it never reaches the outbox path', () => {
    // An imported id flows verbatim into the path of an authenticated PUT
    // (sync-flush.js). visit-shape rejects the shape and visits-io mints a fresh
    // uuid, so the row imports but the crafted segment is gone by the time it is
    // queued. sync.js's apiPath encoding is the second layer behind this.
    applyImportedVisits([validRow({ id: '../../accounts' })]);

    const row = stored()[0];
    expect(row.id).not.toBe('../../accounts');
    expect(row.id).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(puts()).toHaveLength(1);
    expect(puts()[0].id).toBe(row.id);
  });

  test('id-less rows in one file are each kept — dedupe runs before back-fill', () => {
    // Minting the id first would make every fresh uuid "new", but comparing the
    // minted id against stored ids would also never match; the ordering that
    // matters is that a file with no ids does not collapse to one row, and does
    // not duplicate the whole file on a second import of the SAME file.
    applyImportedVisits([validRow({ id: undefined }), validRow({ id: undefined })]);
    expect(stored()).toHaveLength(2);
    expect(new Set(stored().map((v) => v.id)).size).toBe(2);
  });

  test('re-importing the same exported file adds nothing', () => {
    const file = [validRow(), validRow({ id: 'v2' })];
    applyImportedVisits(file);
    mutations = [];

    const result = applyImportedVisits(file);

    expect(result).toEqual({ added: 0, skipped: 0 });
    expect(stored()).toHaveLength(2);
    expect(mutations).toHaveLength(0);
  });

  test('re-renders the views so the import is visible without a reload', () => {
    applyImportedVisits([validRow()]);
    expect(renders).toBe(1);
    expect(globalThis.updateVisitedCounter).toHaveBeenCalled();
  });
});

describe('applyImportedVisits — malformed rows never reach storage', () => {
  test('a row missing distance is dropped, not persisted, not uploaded', () => {
    // This is the row that used to be written and queued, then throw in
    // renderVisitedLayer on visit.distance.toFixed(1) — and keep throwing on
    // every page load afterwards.
    const result = applyImportedVisits([validRow({ id: 'bad', distance: undefined })]);

    expect(result).toEqual({ added: 0, skipped: 1 });
    expect(stored()).toEqual([]);
    expect(mutations).toHaveLength(0);
  });

  test('a row missing coords is dropped while its valid siblings import', () => {
    const result = applyImportedVisits([
      validRow({ id: 'good1' }),
      validRow({ id: 'bad', startLat: undefined }),
      validRow({ id: 'good2' }),
    ]);

    expect(result).toEqual({ added: 2, skipped: 1 });
    expect(stored().map((v) => v.id)).toEqual(['good1', 'good2']);
    expect(puts().map((m) => m.id)).toEqual(['good1', 'good2']);
  });

  test('non-object entries are dropped', () => {
    const result = applyImportedVisits([null, 'walk', 42, [], validRow()]);
    expect(result).toEqual({ added: 1, skipped: 4 });
    expect(stored()).toHaveLength(1);
  });

  test('a repairable row still imports, with the repair applied', () => {
    // Garbage geometry and a missing date are cosmetic; the walk is real.
    applyImportedVisits([validRow({ date: undefined, routeCoords: 'junk' })]);

    const row = stored()[0];
    expect(row.routeCoords).toBeNull();
    expect(Number.isNaN(Date.parse(row.date))).toBe(false);
  });

  test('the whole file being malformed persists an empty merge, not junk', () => {
    const result = applyImportedVisits([{ nope: true }, { alsoNope: 1 }]);
    expect(result).toEqual({ added: 0, skipped: 2 });
    expect(stored()).toEqual([]);
  });
});

describe('applyImportedVisits — one honest toast', () => {
  test('a clean import reports the added count as a success', () => {
    applyImportedVisits([validRow(), validRow({ id: 'v2' })]);
    expect(toasts).toEqual([{ variant: 'success', message: 'Added 2 new visits.' }]);
  });

  test('singular wording for a single visit', () => {
    applyImportedVisits([validRow()]);
    expect(toasts[0].message).toBe('Added 1 new visit.');
  });

  test('skipped rows are reported in the SAME toast as the added count', () => {
    // #notification holds one message (toast.js), so a second toast would
    // overwrite the count the user actually wanted to see.
    applyImportedVisits([validRow(), validRow({ id: 'bad', destLat: 'x' })]);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toEqual({
      variant: 'warning',
      message: 'Added 1 new visit. Skipped 1 malformed entry.',
    });
  });

  test('plural wording for multiple skipped entries', () => {
    applyImportedVisits([validRow({ startLat: null }), validRow({ id: 'b', distance: 'far' })]);
    expect(toasts[0].message).toBe('Added 0 new visits. Skipped 2 malformed entries.');
  });
});

describe('applyImportedVisits — failures are not relabeled', () => {
  test('a render throw propagates instead of masquerading as a bad file', () => {
    // The old single try block caught this and showed "invalid JSON file.",
    // swallowing the stack and hiding that the rows were already persisted.
    globalThis.renderVisitedLayer = () => { throw new Error('leaflet exploded'); };

    expect(() => applyImportedVisits([validRow()])).toThrow('leaflet exploded');
    expect(toasts.some((t) => t.variant === 'error')).toBe(false);
  });

  test('a cloud-mirror throw propagates too', () => {
    globalThis.ExplorerSync = { mutate: () => { throw new Error('outbox full'); } };
    expect(() => applyImportedVisits([validRow()])).toThrow('outbox full');
  });
});

describe('applyImportedVisits — writeStoredArray failure (audit #5713)', () => {
  // storage.js already toasts QUOTA_FULL when the write cannot be reclaimed.
  // Import must not then mutate the outbox or claim success for rows that
  // never landed — the desync path no prior consumer test forced red.
  test('does not mutate or toast success when the local write returns false', () => {
    globalThis.writeStoredArray = () => false;

    const result = applyImportedVisits([validRow(), validRow({ id: 'v2' })]);

    expect(result).toEqual({ added: 0, skipped: 0 });
    expect(mutations).toHaveLength(0);
    expect(toasts).toEqual([]);
    expect(globalThis.maybeRequestConsent).not.toHaveBeenCalled();
    expect(globalThis.updateVisitedCounter).not.toHaveBeenCalled();
    expect(renders).toBe(0);
    expect(stored()).toEqual([]);
  });
});

describe('importVisits — file plumbing', () => {
  // importVisits only reads event.target.files[0] and writes event.target.value,
  // so a plain object is a faithful stand-in for the <input type=file> event.
  function fakeEvent(text) {
    return {
      target: {
        files: [new File([text], 'walks.json', { type: 'application/json' })],
        value: 'C:\\fakepath\\walks.json',
      },
    };
  }

  async function importText(text) {
    const event = fakeEvent(text);
    importVisits(event);
    // FileReader resolves off the event loop.
    await vi.waitFor(() => expect(toasts.length + renders).toBeGreaterThan(0));
    return event;
  }

  test('a well-formed file imports through to storage', async () => {
    const event = await importText(JSON.stringify([validRow()]));

    expect(stored().map((v) => v.id)).toEqual(['v1']);
    expect(toasts[0].variant).toBe('success');
    // The picker is reset so re-selecting the same file fires another change.
    expect(event.target.value).toBe('');
  });

  test('unparseable JSON reports a bad file and persists nothing', async () => {
    const event = await importText('{not json');

    expect(toasts).toEqual([
      { variant: 'error', message: 'Failed to import: invalid JSON file.' },
    ]);
    expect(stored()).toEqual([]);
    expect(mutations).toHaveLength(0);
    expect(event.target.value).toBe('');
  });

  test('valid JSON that is not an array gets its own message', async () => {
    // Distinct from the parse failure: the file parsed fine, it is just the wrong
    // shape — reporting "invalid JSON" here is the mislabeling the audit flagged.
    await importText(JSON.stringify({ visits: [validRow()] }));

    expect(toasts).toEqual([
      { variant: 'error', message: 'Failed to import: expected a JSON array of walks.' },
    ]);
    expect(stored()).toEqual([]);
  });

  test('no file selected is a silent no-op', () => {
    const event = { target: { files: [], value: 'x' } };
    importVisits(event);
    expect(toasts).toEqual([]);
    expect(stored()).toEqual([]);
  });
});
