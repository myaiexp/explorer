// @vitest-environment jsdom
/**
 * Tests for the mark-visited button as DERIVED state — result-panel.js's
 * syncMarkVisitedBtn plus the displayRoute call that keeps it honest.
 *
 * result-panel.js, session-state.js and route-view.js are non-module browser
 * scripts; helpers/load.js evaluates them so their free identifiers resolve to
 * the stubs installed on globalThis.
 *
 * These pin the audit fix: the button used to be set imperatively at each call
 * site, so opening a history entry after marking a route visited left the
 * 'Visited! (undo)' label over a session with no visitId. markAsVisited's undo
 * branch keys off visitId, so that click fell through to the CREATE branch and
 * silently recorded the restored route as an extra walk.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

const PANEL_HTML = `
  <button id="markVisitedBtn">Mark as visited</button>
  <button id="favoriteBtn"></button>
  <div id="elevationContainer"></div>`;

// Everything displayRoute writes into, beyond the button row above.
const RESULT_HTML = `
  <div id="resultPanel"></div>
  <div id="destName"></div>
  <div id="destCoords"></div>
  <a id="streetViewLink"></a>
  <a id="directionsLink"></a>
  <span id="distanceBadge"></span>
  <span id="walkBadge"></span>
  <span id="bikeBadge"></span>
  <span id="carBadge"></span>
  <select id="locationTypeSelect"><option value="park">park</option></select>
  <input id="spreadSlider" type="range" value="50">
  <input type="checkbox" id="avoidBacktracking">`;

beforeEach(() => {
  document.body.innerHTML = PANEL_HTML + RESULT_HTML;
  globalThis.updateFavoriteBtn = () => {};
  // result-panel depends on session-state (SCRIPT_DEPS), same order as before.
  loadScripts('result-panel');
});

describe('syncMarkVisitedBtn', () => {
  const btn = () => document.getElementById('markVisitedBtn');

  test('a session with a visitId reads as visited', () => {
    setCurrentSession({ visitId: 'v1' });
    syncMarkVisitedBtn();
    expect(btn().textContent).toBe('Visited! (undo)');
    expect(btn().classList.contains('marked')).toBe(true);
  });

  test('a session without a visitId reads as unvisited — both directions', () => {
    setCurrentSession({ visitId: 'v1' });
    syncMarkVisitedBtn();
    setCurrentSession({ destLat: 62, destLng: 25 });
    syncMarkVisitedBtn();
    expect(btn().textContent).toBe('Mark as visited');
    expect(btn().classList.contains('marked')).toBe(false);
  });

  test('no session at all reads as unvisited', () => {
    setCurrentSession({ visitId: 'v1' });
    syncMarkVisitedBtn();
    setCurrentSession(null);
    syncMarkVisitedBtn();
    expect(btn().textContent).toBe('Mark as visited');
  });

  test('resetResultPanel clears the label and hides a stale elevation chart', () => {
    document.getElementById('elevationContainer').classList.add('active');
    setCurrentSession({ visitId: 'v1' });
    syncMarkVisitedBtn();

    setCurrentSession(null);
    resetResultPanel();
    expect(btn().textContent).toBe('Mark as visited');
    expect(document.getElementById('elevationContainer').classList.contains('active')).toBe(false);
  });
});

describe('displayRoute derives the button from the session it displays', () => {
  beforeEach(() => {
    // Collaborators displayRoute/renderRouteTail reach for, stubbed to the
    // minimum shape each call site needs.
    globalThis.getRouteColor = () => '#ff0000';
    globalThis.addStartMarker = () => {};
    globalThis.addDestMarker = () => {};
    globalThis.addRadiusCircles = () => {};
    globalThis.drawRoutePair = () => [];
    globalThis.drawRouteGlow = () => {};
    globalThis.map = { fitBounds: () => {} };
    globalThis.L = { latLngBounds: () => ({ pad: () => ({}) }) };
    globalThis.haversineKm = () => 3;
    globalThis.computeRouteTotals = () => ({ totalWalkKm: 6, totalDuration: 4200 });
    globalThis.computeSpreadParams = () => ({ offsetKm: 1, spreadFactor: 0.5 });
    globalThis.loopVias = () => ({ rightVias: [], leftVias: [] });
    globalThis.routeSessionFields = () => ({});
    globalThis.fetchElevations = () => Promise.resolve([]);
    globalThis.renderElevationChart = () => {};
    loadScripts('route-view');
  });

  const displayed = (over = {}) => displayRoute({
    startLat: 62.1, startLng: 25.7, destLat: 62.2, destLng: 25.8,
    outbound: null, ret: null, locationInput: 'Jyväskylä',
    destName: 'Park', tripMode: 'round', ...over,
  });

  test('restoring an entry after marking a route visited clears the stale label', () => {
    // Route generated, then marked visited: the live session carries visitId.
    displayed();
    getCurrentSession().visitId = 'v1';
    syncMarkVisitedBtn();
    expect(document.getElementById('markVisitedBtn').textContent).toBe('Visited! (undo)');

    // Clicking a history entry re-displays a stored route — a fresh session with
    // no visitId. The button must follow it, or the next click records a
    // duplicate visit for the restored route.
    displayed({ destName: 'Museum', destLat: 62.4 });
    expect(getCurrentSession().visitId).toBeUndefined();
    expect(document.getElementById('markVisitedBtn').textContent).toBe('Mark as visited');
    expect(document.getElementById('markVisitedBtn').classList.contains('marked')).toBe(false);
  });
});
