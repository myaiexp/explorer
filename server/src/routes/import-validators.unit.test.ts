// Unit + parity + mutation tests for the shared row validator extracted from
// validateVisit / validateHistoryRow (audit #1264). Pure functions — no DB.
import { describe, it, expect } from 'vitest';
import { validateRouteRow, validateVisit, validateHistoryRow } from './import.js';

const USER = 'alice';

// Minimal row that passes every required-field guard.
const validRow = () => ({
  id: 'row-1',
  date: '2026-04-27T10:00:00Z',
  startLat: 60.1,
  startLng: 24.9,
  destLat: 60.2,
  destLng: 25.0,
  distance: 4.2,
});

// The normalized common shape produced from validRow() (optionals default to null).
const expectedBase = () => ({
  id: 'row-1',
  username: USER,
  date: '2026-04-27T10:00:00Z',
  startLat: 60.1,
  startLng: 24.9,
  startLabel: null,
  destLat: 60.2,
  destLng: 25.0,
  destName: null,
  tripMode: null,
  distance: 4.2,
  routeCoords: null,
  routeDuration: null,
  returnRouteCoords: null,
  returnRouteDuration: null,
});

describe('validateRouteRow (shared core)', () => {
  it('normalizes a minimal valid row, defaulting every optional to null', () => {
    expect(validateRouteRow(validRow(), USER)).toEqual(expectedBase());
  });

  it('passes through and normalizes all optional fields', () => {
    const coords = [
      [60.1, 24.9],
      [60.2, 25.0],
    ];
    const row = {
      ...validRow(),
      startLabel: 'Home',
      destName: 'Park',
      tripMode: 'loop',
      routeCoords: coords,
      routeDuration: 1200,
      returnRouteCoords: coords,
      returnRouteDuration: 1300,
    };
    expect(validateRouteRow(row, USER)).toEqual({
      ...expectedBase(),
      startLabel: 'Home',
      destName: 'Park',
      tripMode: 'loop',
      routeCoords: coords,
      routeDuration: 1200,
      returnRouteCoords: coords,
      returnRouteDuration: 1300,
    });
  });

  it('coerces wrong-typed optional fields to null (preserving pre-refactor semantics)', () => {
    const row = {
      ...validRow(),
      startLabel: 42, // non-string
      destName: null,
      tripMode: {},
      routeDuration: '1200', // non-number
      returnRouteDuration: false,
    };
    const out = validateRouteRow(row, USER)!;
    expect(out.startLabel).toBeNull();
    expect(out.destName).toBeNull();
    expect(out.tripMode).toBeNull();
    expect(out.routeDuration).toBeNull();
    expect(out.returnRouteDuration).toBeNull();
  });

  it('validates routeCoords shape (assertRouteCoords folded into the validator)', () => {
    // assertRouteCoords now runs inside the shared validator, so a malformed
    // routeCoords is rejected here (→ null via the adapter) rather than passing
    // through to a separate call-site check.
    expect(validateRouteRow({ ...validRow(), routeCoords: 'not-an-array' }, USER)).toBeNull();
    expect(validateRouteRow({ ...validRow(), returnRouteCoords: [[999, 0]] }, USER)).toBeNull();
    // undefined still normalizes to null (absent → null).
    const out = validateRouteRow({ ...validRow(), routeCoords: undefined }, USER)!;
    expect(out.routeCoords).toBeNull();
    // a valid [lat, lng] array passes through unchanged.
    const coords = [
      [60.1, 24.9],
      [60.2, 25.0],
    ];
    expect(validateRouteRow({ ...validRow(), routeCoords: coords }, USER)!.routeCoords).toEqual(coords);
  });

  it('does not carry a poiCategory field (visits-only)', () => {
    const out = validateRouteRow({ ...validRow(), poiCategory: 'nature' }, USER)!;
    expect(out).not.toHaveProperty('poiCategory');
  });
});

// One mutation per reject guard: take a valid row, break exactly one field. Pre-refactor both
// validateVisit and validateHistoryRow rejected each of these — assert all three still do.
const rejectCases: Array<[string, unknown]> = [
  ['non-object: null', null],
  ['non-object: undefined', undefined],
  ['non-object: array', [validRow()]],
  ['non-object: string', 'nope'],
  ['non-object: number', 5],
  ['id missing', { ...validRow(), id: undefined }],
  ['id empty string', { ...validRow(), id: '' }],
  ['id non-string', { ...validRow(), id: 123 }],
  ['id over 128 chars', { ...validRow(), id: 'a'.repeat(129) }],
  ['id with slash', { ...validRow(), id: 'a/b' }],
  ['id traversal segment', { ...validRow(), id: '..' }],
  ['id bare dot', { ...validRow(), id: '.' }],
  ['id with space', { ...validRow(), id: 'id with space' }],
  ['date missing', { ...validRow(), date: undefined }],
  ['date empty string', { ...validRow(), date: '' }],
  ['date non-string', { ...validRow(), date: 0 }],
  ['startLat non-number', { ...validRow(), startLat: '60.1' }],
  ['startLng non-number', { ...validRow(), startLng: null }],
  ['destLat non-number', { ...validRow(), destLat: undefined }],
  ['destLng non-number', { ...validRow(), destLng: '25' }],
  ['distance non-number', { ...validRow(), distance: '4.2' }],
  ['date malformed (not ISO)', { ...validRow(), date: 'last tuesday' }],
  ['date SQL-ish string', { ...validRow(), date: 'DROP TABLE visits' }],
  ['startLabel over 500 chars', { ...validRow(), startLabel: 'x'.repeat(501) }],
  ['destName over 2000 chars', { ...validRow(), destName: 'x'.repeat(2001) }],
  ['tripMode over 500 chars', { ...validRow(), tripMode: 'x'.repeat(501) }],
];

describe('reject-path parity across both call sites', () => {
  for (const [label, input] of rejectCases) {
    it(`rejects (${label}) identically in core, visit, and history`, () => {
      expect(validateRouteRow(input, USER)).toBeNull();
      expect(validateVisit(input, USER)).toBeNull();
      expect(validateHistoryRow(input, USER)).toBeNull();
    });
  }

  it('accepts a number-typed distance even if non-finite (no finiteness guard, as before)', () => {
    // Pre-refactor only checked typeof === 'number'; NaN/Infinity passed. Lock that in.
    expect(validateRouteRow({ ...validRow(), distance: NaN }, USER)).not.toBeNull();
    expect(validateVisit({ ...validRow(), startLat: Infinity }, USER)).not.toBeNull();
  });
});

describe('field bounds (date + length caps)', () => {
  it('accepts a bare ISO date (YYYY-MM-DD) and a full timestamp', () => {
    expect(validateRouteRow({ ...validRow(), date: '2026-04-27' }, USER)).not.toBeNull();
    expect(validateRouteRow({ ...validRow(), date: '2026-04-27T10:00:00.123Z' }, USER)).not.toBeNull();
  });

  it('accepts strings exactly at the length cap (500 label / 2000 name / 128 id)', () => {
    expect(validateRouteRow({ ...validRow(), startLabel: 'x'.repeat(500) }, USER)).not.toBeNull();
    expect(validateRouteRow({ ...validRow(), destName: 'x'.repeat(2000) }, USER)).not.toBeNull();
    expect(validateRouteRow({ ...validRow(), tripMode: 'x'.repeat(500) }, USER)).not.toBeNull();
    expect(validateRouteRow({ ...validRow(), id: 'a'.repeat(128) }, USER)).not.toBeNull();
  });

  it('rejects an over-length poiCategory on validateVisit only', () => {
    // poiCategory is visit-only; the shared core/history never reads it, so it
    // passes there but must be capped where it is actually stored.
    expect(validateVisit({ ...validRow(), poiCategory: 'x'.repeat(501) }, USER)).toBeNull();
    expect(validateVisit({ ...validRow(), poiCategory: 'x'.repeat(500) }, USER)).not.toBeNull();
    expect(validateHistoryRow({ ...validRow(), poiCategory: 'x'.repeat(501) }, USER)).not.toBeNull();
  });
});

describe('validateHistoryRow', () => {
  it('is byte-equivalent to the shared core for a valid row', () => {
    expect(validateHistoryRow(validRow(), USER)).toEqual(validateRouteRow(validRow(), USER));
    expect(validateHistoryRow(validRow(), USER)).toEqual(expectedBase());
  });

  it('never emits poiCategory even when present on input', () => {
    expect(validateHistoryRow({ ...validRow(), poiCategory: 'food' }, USER)).not.toHaveProperty('poiCategory');
  });
});

describe('validateVisit', () => {
  it('produces the shared base plus poiCategory (null when absent)', () => {
    expect(validateVisit(validRow(), USER)).toEqual({ ...expectedBase(), poiCategory: null });
  });

  it('captures a string poiCategory', () => {
    expect(validateVisit({ ...validRow(), poiCategory: 'culture' }, USER)).toEqual({
      ...expectedBase(),
      poiCategory: 'culture',
    });
  });

  it('coerces a non-string poiCategory to null', () => {
    expect(validateVisit({ ...validRow(), poiCategory: 7 }, USER)!.poiCategory).toBeNull();
  });

  it('shares every common field with validateHistoryRow for the same input (parity)', () => {
    const row = {
      ...validRow(),
      startLabel: 'Home',
      destName: 'Park',
      tripMode: 'oneway',
      poiCategory: 'nature',
      routeDuration: 900,
    };
    const visit = validateVisit(row, USER)!;
    const history = validateHistoryRow(row, USER)!;
    const { poiCategory, ...visitCommon } = visit;
    expect(visitCommon).toEqual(history);
    expect(poiCategory).toBe('nature');
  });
});
