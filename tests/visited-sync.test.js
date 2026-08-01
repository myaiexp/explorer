/**
 * Tests for visited.js — markAsVisited's create/undo state machine and
 * updateVisitedCounter. visited.js is a non-module script that assigns
 * globalThis.markAsVisited/toggleVisitedLayer/updateVisitedCounter; its free
 * identifiers (getVisits, syncedPut, syncedDelete, getCurrentSession,
 * syncMarkVisitedBtn, renderVisitedLayer, maybeRequestConsent, …) resolve to
 * the stubs installed on globalThis below — the same collaborators index.html
 * wires up at runtime — once helpers/load.js has evaluated it. snapshotSession
 * is the real pure helper from session.js (loaded with visited), not a
 * hand-copied field list (audit #6233).
 *
 * tests/mark-visited.test.js already pins the DERIVED half of this contract —
 * that the button label is read from session.visitId, never written directly.
 * This file pins the other half: the mutation path that sets/clears visitId
 * and keeps localStorage and the cloud outbox in lockstep (audit finding #5400).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { installSyncedMirrorStubs } from './helpers/synced-mirror.js';

const VISITS_KEY = 'walk_visits';
let putCalls;
let deleteCalls;
let setWriteOk;
let syncBtnCalls;
let renderLayerCalls;
let consentCalls;

function storedVisits() {
  return JSON.parse(localStorage.getItem(VISITS_KEY) || '[]');
}

beforeEach(() => {
  localStorage.clear();
  syncBtnCalls = 0;
  renderLayerCalls = 0;
  consentCalls = 0;

  document.body.innerHTML =
    '<span id="visitedCount"></span><span id="exploredCount"></span><button id="toggleVisitedBtn"></button>';

  globalThis.VISITS_KEY = VISITS_KEY;
  globalThis.getVisits = () => JSON.parse(localStorage.getItem(VISITS_KEY) || '[]');

  let currentSession = null;
  globalThis.getCurrentSession = () => currentSession;
  globalThis.setCurrentSession = (s) => {
    currentSession = s;
    return currentSession;
  };

  ({ putCalls, deleteCalls, setWriteOk } = installSyncedMirrorStubs({ recordPutData: true }));

  globalThis.maybeRequestConsent = () => { consentCalls++; };
  globalThis.syncMarkVisitedBtn = () => { syncBtnCalls++; };
  globalThis.renderVisitedLayer = () => { renderLayerCalls++; };
  globalThis.map = { removeLayer: () => {}, addLayer: () => {} };
  globalThis.visitedLayerGroup = { addTo: () => {} };

  // Real snapshotSession (session.js) — visited needs minting, not a shallow
  // fixture copy. Other collaborators stay faked above.
  loadScripts('session', 'visited');
});

function baseSession(over = {}) {
  return {
    startLat: 62.1, startLng: 25.7, startLabel: 'Home',
    destLat: 62.2, destLng: 25.8, destName: 'Park',
    tripMode: 'round', distance: 3,
    ...over,
  };
}

describe('markAsVisited — create', () => {
  test('marking a session stores one visit and mirrors exactly one cloud put with the same id', () => {
    const session = setCurrentSession(baseSession());
    markAsVisited();

    const visits = storedVisits();
    expect(visits).toHaveLength(1);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].section).toBe('visits');
    // The stored row, the mirrored put, and the live session must all agree on
    // one id — markAsVisited's undo branch (and the button label) keys off
    // session.visitId, so any drift here breaks undo silently.
    expect(putCalls[0].id).toBe(visits[0].id);
    expect(session.visitId).toBe(visits[0].id);
    expect(consentCalls).toBe(1);
  });

  test('poiCategory is grafted onto the stored row when present', () => {
    setCurrentSession(baseSession({ poiCategory: 'nature' }));
    markAsVisited();
    expect(storedVisits()[0].poiCategory).toBe('nature');
  });

  test('poiCategory defaults to null (never undefined) so it survives JSON serialization', () => {
    // The backup server's visits table has a poiCategory column; an `undefined`
    // field would be dropped by JSON.stringify inside syncedPut's outbox mirror,
    // silently desyncing the cloud row from the local one.
    setCurrentSession(baseSession());
    markAsVisited();
    const stored = storedVisits()[0];
    expect('poiCategory' in stored).toBe(true);
    expect(stored.poiCategory).toBeNull();
    expect(putCalls[0].data.poiCategory).toBeNull();
  });

  test('never writes the button label directly — it delegates to syncMarkVisitedBtn', () => {
    // The label is DERIVED from session.visitId (pinned from the other side in
    // tests/mark-visited.test.js); markAsVisited must never set it imperatively.
    setCurrentSession(baseSession());
    markAsVisited();
    expect(syncBtnCalls).toBe(1);
  });
});

describe('markAsVisited — undo', () => {
  test('marking twice deletes the row, mirrors a delete with the same id (as a string), and clears visitId', () => {
    const session = setCurrentSession(baseSession());
    markAsVisited();
    const visitId = session.visitId;
    expect(storedVisits()).toHaveLength(1);

    markAsVisited();

    expect(storedVisits()).toHaveLength(0);
    expect(session.visitId).toBeNull();
    // Full create/undo transition in order — the exact sequence the audit
    // flagged: a put followed by a delete carrying the same id.
    expect(putCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ section: 'visits', id: String(visitId) });
    expect(typeof deleteCalls[0].id).toBe('string');
  });

  test('undo removes only its own row, leaving other stored visits untouched', () => {
    const other = { id: 'other-visit', destName: 'Museum', tripMode: 'round' };
    localStorage.setItem(VISITS_KEY, JSON.stringify([other]));

    const session = setCurrentSession(baseSession());
    markAsVisited(); // create
    expect(storedVisits()).toHaveLength(2);

    markAsVisited(); // undo

    const stored = storedVisits();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual(other);
    expect(session.visitId).toBeNull();
  });

  test('re-marking after undo creates a NEW id rather than resurrecting the old one', () => {
    const session = setCurrentSession(baseSession());
    markAsVisited(); // create #1
    const firstId = session.visitId;
    markAsVisited(); // undo #1

    markAsVisited(); // create #2
    const secondId = session.visitId;

    expect(secondId).not.toBe(firstId);
    expect(storedVisits()).toHaveLength(1);
    expect(storedVisits()[0].id).toBe(secondId);

    // create, undo, create → put, delete, put with distinct put ids.
    expect(putCalls.map((c) => c.id)).toEqual([firstId, secondId]);
    expect(deleteCalls.map((c) => c.id)).toEqual([String(firstId)]);
  });
});

describe('markAsVisited — no session', () => {
  test('no current session is a no-op: nothing stored, nothing mirrored', () => {
    setCurrentSession(null);
    markAsVisited();

    expect(storedVisits()).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
    expect(syncBtnCalls).toBe(0);
    expect(renderLayerCalls).toBe(0);
    expect(consentCalls).toBe(0);
  });
});

describe('markAsVisited — hard-quota write failure (audit #5721 #5711)', () => {
  // syncedPut/syncedDelete return false when writeStoredArray cannot reclaim
  // quota. Session/UI must not advance past a write that never landed — otherwise
  // the visited button lies, the counter/layer disagree, and cloud may receive a
  // row the device never kept.
  test('a failed put does not stamp visitId, re-render, or request consent', () => {
    setWriteOk(false);
    const session = setCurrentSession(baseSession());
    markAsVisited();

    expect(session.visitId).toBeUndefined();
    expect(storedVisits()).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
    expect(syncBtnCalls).toBe(0);
    expect(renderLayerCalls).toBe(0);
    expect(consentCalls).toBe(0);
  });

  test('a failed undo delete leaves visitId set and the row in storage', () => {
    const session = setCurrentSession(baseSession());
    markAsVisited(); // create succeeds
    const visitId = session.visitId;
    expect(storedVisits()).toHaveLength(1);
    putCalls.length = 0;
    setWriteOk(false);

    markAsVisited(); // undo fails

    expect(session.visitId).toBe(visitId);
    expect(storedVisits()).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    // No extra re-render beyond the successful create.
    expect(syncBtnCalls).toBe(1);
    expect(renderLayerCalls).toBe(1);
  });
});

describe('updateVisitedCounter', () => {
  const counterText = () => document.getElementById('visitedCount').textContent;
  const exploredEl = () => document.getElementById('exploredCount');

  test('singular: exactly one visit reads "1 place explored"', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify([{ id: 'a' }]));
    updateVisitedCounter();
    expect(counterText()).toBe('1 visited');
    expect(exploredEl().textContent).toBe('1 place explored');
    expect(exploredEl().style.display).toBe('block');
  });

  test('plural: two or more visits read "N places explored"', () => {
    localStorage.setItem(VISITS_KEY, JSON.stringify([{ id: 'a' }, { id: 'b' }]));
    updateVisitedCounter();
    expect(counterText()).toBe('2 visited');
    expect(exploredEl().textContent).toBe('2 places explored');
    expect(exploredEl().style.display).toBe('block');
  });

  test('zero visits: counter still reads "0 visited" but the explored line is hidden', () => {
    updateVisitedCounter();
    expect(counterText()).toBe('0 visited');
    expect(exploredEl().style.display).toBe('none');
  });
});
