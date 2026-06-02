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

  it('treats routeCoords/returnRouteCoords as present unless undefined (shape unchecked here)', () => {
    // The shared validator only distinguishes undefined → null; deep shape validation
    // happens later via assertRouteCoords at the call site, so a non-array passes through.
    const out = validateRouteRow({ ...validRow(), routeCoords: 'not-an-array' }, USER)!;
    expect(out.routeCoords).toBe('not-an-array');
    const out2 = validateRouteRow({ ...validRow(), routeCoords: undefined }, USER)!;
    expect(out2.routeCoords).toBeNull();
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
  ['date missing', { ...validRow(), date: undefined }],
  ['date empty string', { ...validRow(), date: '' }],
  ['date non-string', { ...validRow(), date: 0 }],
  ['startLat non-number', { ...validRow(), startLat: '60.1' }],
  ['startLng non-number', { ...validRow(), startLng: null }],
  ['destLat non-number', { ...validRow(), destLat: undefined }],
  ['destLng non-number', { ...validRow(), destLng: '25' }],
  ['distance non-number', { ...validRow(), distance: '4.2' }],
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
