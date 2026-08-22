/**
 * Tests for visit-shape.js — the untrusted-visit-row rules shared by the import
 * gate (visits-io.js) and the render guard (map-view.js).
 *
 * visit-shape.js is a non-module browser script that assigns onto globalThis;
 * helpers/load.js evaluates it in the current realm.
 *
 * These pin the audit fix: importVisits used to accept any JSON array, persist it,
 * queue it for upload, and only then hand it to renderVisitedLayer — which
 * dereferenced visit.distance.toFixed(1) and fed visit.startLat straight to
 * Leaflet. One bad row therefore threw AFTER being durably stored, and because
 * renderVisitedLayer also runs at app.js's top level it kept throwing on every
 * later page load, aborting the rest of init with no in-app way out.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeAll(() => {
  loadScripts('visit-shape');
});

const NOW = '2026-07-25T10:00:00.000Z';

// A row as exportVisits writes it (snapshotSession's shape).
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
    routeCoords: [[62.24, 25.75], [62.28, 25.8]],
    routeDistance: 4200,
    routeDuration: 3000,
    returnRouteCoords: null,
    returnRouteDistance: null,
    returnRouteDuration: null,
    poiCategory: 'nature',
    ...over,
  };
}

describe('normalizeVisit — rows it accepts', () => {
  test('a round-tripped export row survives unchanged', () => {
    expect(normalizeVisit(validRow(), NOW)).toEqual(validRow());
  });

  test('emits exactly snapshotSession\'s key set plus poiCategory, dropping junk', () => {
    // A fixed key set keeps a hand-edited file from bloating localStorage (quota
    // is finite — see storage.js) or the cloud row with unknown fields.
    const out = normalizeVisit(validRow({ evil: 'x', __proto__hack: 1 }), NOW);
    expect(Object.keys(out).sort()).toEqual([
      'date', 'destLat', 'destLng', 'destName', 'distance', 'id', 'poiCategory',
      'returnRouteCoords', 'returnRouteDistance', 'returnRouteDuration',
      'routeCoords', 'routeDistance', 'routeDuration',
      'startLabel', 'startLat', 'startLng', 'tripMode',
    ]);
    expect(out.evil).toBeUndefined();
  });

  test('numeric-string coords and distance are coerced, not rejected', () => {
    // Hand-portable backups (and older exports) sometimes carry these as strings;
    // dropping a whole walk over "62.24" would be data loss the user can't undo.
    const out = normalizeVisit(
      validRow({ startLat: '62.24', startLng: '25.75', distance: '4.2' }), NOW);
    expect(out.startLat).toBe(62.24);
    expect(out.startLng).toBe(25.75);
    expect(out.distance).toBe(4.2);
  });

  test('a missing or unparseable date is repaired to now', () => {
    // The backup server requires an ISO-8601 date (validate-fields.ts isIsoDate);
    // a row without one would be accepted locally and then 400 on upload.
    expect(normalizeVisit(validRow({ date: undefined }), NOW).date).toBe(NOW);
    expect(normalizeVisit(validRow({ date: 'last tuesday' }), NOW).date).toBe(NOW);
    expect(normalizeVisit(validRow({ date: 1751356200000 }), NOW).date).toBe(NOW);
  });

  test('malformed geometry becomes null instead of sinking the row', () => {
    // A route that can't be drawn is cosmetic; the walk itself is still real.
    expect(normalizeVisit(validRow({ routeCoords: 'nope' }), NOW).routeCoords).toBeNull();
    expect(normalizeVisit(validRow({ routeCoords: [[62.2]] }), NOW).routeCoords).toBeNull();
    expect(normalizeVisit(validRow({ routeCoords: [[62.2, 'x']] }), NOW).routeCoords).toBeNull();
    expect(normalizeVisit(validRow({ routeCoords: [] }), NOW).routeCoords).toBeNull();
    expect(normalizeVisit(validRow({ routeCoords: [[62.2, 25.7], [999, 25.8]] }), NOW).routeCoords)
      .toBeNull();
    // …but the row itself still imports.
    expect(normalizeVisit(validRow({ routeCoords: 'nope' }), NOW)).not.toBeNull();
  });

  test('one bad pair voids the whole polyline rather than being filtered out', () => {
    // A partially-dropped route draws a straight line through terrain the walk
    // never crossed, which reads as real data — worse than drawing nothing.
    const out = normalizeVisit(
      validRow({ routeCoords: [[62.2, 25.7], null, [62.3, 25.8]] }), NOW);
    expect(out.routeCoords).toBeNull();
  });

  test('a > 5000-point route is rejected (mirrors the server cap)', () => {
    const huge = Array.from({ length: 5001 }, () => [62.2, 25.7]);
    expect(normalizeVisit(validRow({ routeCoords: huge }), NOW).routeCoords).toBeNull();
  });

  test('over-long labels truncate to the server column caps', () => {
    const out = normalizeVisit(
      validRow({ startLabel: 'a'.repeat(600), destName: 'b'.repeat(2500) }), NOW);
    expect(out.startLabel).toHaveLength(500);
    expect(out.destName).toHaveLength(2000);
  });

  test('absent optional strings normalize to null, never undefined', () => {
    // undefined drops out of JSON.stringify, so the cloud row would silently lose
    // the column rather than storing an explicit null.
    const out = normalizeVisit({
      startLat: 62.2, startLng: 25.7, destLat: 62.3, destLng: 25.8, distance: 1,
    }, NOW);
    for (const key of ['startLabel', 'destName', 'tripMode', 'poiCategory',
                       'routeCoords', 'routeDistance', 'routeDuration',
                       'returnRouteCoords', 'returnRouteDistance', 'returnRouteDuration']) {
      expect(out[key]).toBeNull();
    }
  });

  test('a numeric legacy id is stringified; a missing one is left for the caller', () => {
    // The server requires a string id; back-filling happens in visits-io.js so
    // this module stays free of crypto/uuid concerns.
    expect(normalizeVisit(validRow({ id: 17 }), NOW).id).toBe('17');
    expect(normalizeVisit(validRow({ id: undefined }), NOW).id).toBeNull();
    expect(normalizeVisit(validRow({ id: '' }), NOW).id).toBeNull();
    expect(normalizeVisit(validRow({ id: { nested: true } }), NOW).id).toBeNull();
  });

  // An id is not just a local key: it becomes a path segment in an authenticated
  // cloud-backup write (sync-flush.js) and a PK column server-side. An imported
  // file's id is user-supplied, so anything that isn't uuid/legacy-numeric shaped
  // is dropped and back-filled with a fresh UUID rather than passed through.
  test.each([
    ['a path separator', 'a/b'],
    ['a traversal segment', '..'],
    ['a bare dot', '.'],
    ['a leading traversal', '../../accounts'],
    ['a percent escape', '%2e%2e'],
    ['a query fragment', 'id?x=1'],
    ['whitespace', 'id with space'],
    ['over the 128-char cap', 'a'.repeat(129)],
  ])('rejects an id with %s, leaving it for the caller to back-fill', (_label, id) => {
    expect(normalizeVisit(validRow({ id }), NOW).id).toBeNull();
  });

  test.each([
    ['a uuid', '0f9c1e7a-3b2d-4c8e-9a11-7d6f5b4c3a21'],
    ['a legacy numeric string', '1714500000000'],
    ['dots inside a name', 'walk.2026.04.27'],
    ['exactly 128 chars', 'a'.repeat(128)],
  ])('keeps an id that is %s', (_label, id) => {
    expect(normalizeVisit(validRow({ id }), NOW).id).toBe(id);
  });

  test('zero distance is a legitimate walk', () => {
    expect(normalizeVisit(validRow({ distance: 0 }), NOW).distance).toBe(0);
  });
});

describe('normalizeVisit — rows beyond repair', () => {
  // Each of these is a row renderVisitedLayer would have thrown on, after it was
  // already written to localStorage and queued for upload.
  const unusable = [
    ['no startLat', { startLat: undefined }],
    ['null startLat', { startLat: null }],
    ['non-numeric startLng', { startLng: 'north' }],
    ['NaN destLat', { destLat: NaN }],
    ['Infinity destLng', { destLng: Infinity }],
    ['no distance', { distance: undefined }],
    ['non-numeric distance', { distance: 'far' }],
    ['negative distance', { distance: -1 }],
    ['latitude out of range', { startLat: 91 }],
    ['longitude out of range', { destLng: -181 }],
  ];

  test.each(unusable)('drops a row with %s', (_label, over) => {
    expect(normalizeVisit(validRow(over), NOW)).toBeNull();
  });

  test.each([
    ['null', null],
    ['a string', 'walk'],
    ['a number', 42],
    ['an array', [62.2, 25.7]],
    ['undefined', undefined],
  ])('drops %s outright', (_label, row) => {
    expect(normalizeVisit(row, NOW)).toBeNull();
  });

  test('defaults the date to the real clock when no nowIso is passed', () => {
    const out = normalizeVisit(validRow({ date: undefined }));
    expect(Number.isNaN(Date.parse(out.date))).toBe(false);
  });
});

describe('destCoordsOrNull — dest-only gate for list renderers', () => {
  test('returns finite dest coords for a good row', () => {
    expect(destCoordsOrNull(validRow())).toEqual({ destLat: 62.28, destLng: 25.8 });
  });

  test('accepts numeric strings the way latOrNull does', () => {
    expect(destCoordsOrNull(validRow({ destLat: '62.28', destLng: '25.8' })))
      .toEqual({ destLat: 62.28, destLng: 25.8 });
  });

  test('returns null when dest coords are missing, non-finite, or out of range', () => {
    expect(destCoordsOrNull(validRow({ destLat: undefined }))).toBeNull();
    expect(destCoordsOrNull(validRow({ destLng: 'x' }))).toBeNull();
    expect(destCoordsOrNull(validRow({ destLat: 91 }))).toBeNull();
    expect(destCoordsOrNull(null)).toBeNull();
    expect(destCoordsOrNull('fav')).toBeNull();
    expect(destCoordsOrNull({ payload: [] })).toBeNull();
  });

  test('does not require start coords — lists only need a destination', () => {
    expect(destCoordsOrNull({ destLat: 60.1, destLng: 24.9, startLat: undefined }))
      .toEqual({ destLat: 60.1, destLng: 24.9 });
  });
});

describe('visitRenderParts — the guard for rows already in storage', () => {
  test('returns the drawable pieces for a good row', () => {
    const parts = visitRenderParts(validRow());
    expect(parts.start).toEqual([62.24, 25.75]);
    expect(parts.dest).toEqual([62.28, 25.8]);
    expect(parts.routeCoords).toEqual([[62.24, 25.75], [62.28, 25.8]]);
    expect(parts.returnRouteCoords).toBeNull();
    expect(parts.startLabel).toBe('Jyväskylä');
    expect(parts.distanceText).toBe('4.2 km');
    expect(parts.dateText).not.toBe('');
  });

  test('skips a row with no usable start or dest — there is nothing to place', () => {
    expect(visitRenderParts(validRow({ startLat: undefined }))).toBeNull();
    expect(visitRenderParts(validRow({ destLng: 'x' }))).toBeNull();
    expect(visitRenderParts(null)).toBeNull();
    expect(visitRenderParts('walk')).toBeNull();
  });

  test('a missing distance degrades to an empty badge, not a thrown row', () => {
    // This exact dereference (visit.distance.toFixed(1)) is what aborted init.
    const parts = visitRenderParts(validRow({ distance: undefined }));
    expect(parts).not.toBeNull();
    expect(parts.distanceText).toBe('');
  });

  test('a missing date and label degrade to empty popup text, never undefined', () => {
    const parts = visitRenderParts(validRow({ date: undefined, startLabel: undefined }));
    expect(parts.dateText).toBe('');
    expect(parts.startLabel).toBe('');
  });

  test('malformed geometry degrades that polyline only', () => {
    const parts = visitRenderParts(
      validRow({ routeCoords: [[62.2, 'x']], returnRouteCoords: [[62.3, 25.8]] }));
    expect(parts.routeCoords).toBeNull();
    expect(parts.returnRouteCoords).toEqual([[62.3, 25.8]]);
  });

  test('every row normalizeVisit accepts is renderable', () => {
    // The invariant behind sharing one rule set: import can never admit a row the
    // overlay then chokes on.
    for (const over of [{}, { routeCoords: 'junk' }, { date: 'nope' },
                        { startLabel: undefined }, { id: 3 }, { distance: '0' }]) {
      const normalized = normalizeVisit(validRow(over), NOW);
      expect(normalized).not.toBeNull();
      expect(visitRenderParts(normalized)).not.toBeNull();
    }
  });
});
