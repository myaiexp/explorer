import { describe, it, expect } from 'vitest';
import {
  assertRouteCoords,
  RouteCoordsError,
  MAX_ROUTE_COORDS,
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
} from './route-coords.js';

// Mutation-proof (audit #1344): each isolated source mutation turns ≥1 test RED.
//   cap 5000 → 4999      : "accepts exactly MAX_ROUTE_COORDS (5000) pairs at the cap" fails
//   lat bound 90 → 89    : "accepts latitude boundaries -90 and 90" fails
// Both verified RED then restored to green.

// Builds n valid [lat, lng] pairs well within range.
function validPairs(n: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => [i % 90, i % 180] as [number, number]);
}

describe('assertRouteCoords — happy paths', () => {
  it('accepts null', () => {
    expect(() => assertRouteCoords(null, 'routeCoords')).not.toThrow();
  });

  it('accepts undefined', () => {
    expect(() => assertRouteCoords(undefined, 'routeCoords')).not.toThrow();
  });

  it('accepts an empty array', () => {
    expect(() => assertRouteCoords([], 'routeCoords')).not.toThrow();
  });

  it('accepts a single valid pair', () => {
    expect(() => assertRouteCoords([[60.17, 24.94]], 'routeCoords')).not.toThrow();
  });

  it('accepts exactly MAX_ROUTE_COORDS (5000) pairs at the cap', () => {
    expect(MAX_ROUTE_COORDS).toBe(5000);
    expect(() => assertRouteCoords(validPairs(5000), 'routeCoords')).not.toThrow();
  });

  it('exports the inclusive WGS-84 bounds (shared with validateTripRow scalars)', () => {
    expect(LAT_MIN).toBe(-90);
    expect(LAT_MAX).toBe(90);
    expect(LNG_MIN).toBe(-180);
    expect(LNG_MAX).toBe(180);
  });

  it('accepts latitude boundaries -90 and 90', () => {
    expect(() => assertRouteCoords([[-90, 0]], 'routeCoords')).not.toThrow();
    expect(() => assertRouteCoords([[90, 0]], 'routeCoords')).not.toThrow();
  });

  it('accepts longitude boundaries -180 and 180', () => {
    expect(() => assertRouteCoords([[0, -180]], 'routeCoords')).not.toThrow();
    expect(() => assertRouteCoords([[0, 180]], 'routeCoords')).not.toThrow();
  });
});

describe('assertRouteCoords — rejection branches', () => {
  it('rejects a non-array (object)', () => {
    expect(() => assertRouteCoords({ foo: 'bar' }, 'routeCoords')).toThrow(RouteCoordsError);
  });

  it('rejects a non-array (string)', () => {
    expect(() => assertRouteCoords('not-an-array', 'routeCoords')).toThrow(RouteCoordsError);
  });

  it('rejects more than MAX_ROUTE_COORDS pairs (5001)', () => {
    expect(() => assertRouteCoords(validPairs(5001), 'routeCoords')).toThrow(/exceeds maximum/);
  });

  it('rejects an element that is not an array (non-2-tuple: scalar)', () => {
    expect(() => assertRouteCoords([60.17], 'routeCoords')).toThrow(RouteCoordsError);
  });

  it('rejects an element with the wrong arity (1-tuple)', () => {
    expect(() => assertRouteCoords([[60.17]], 'routeCoords')).toThrow(/\[lat, lng\] pairs/);
  });

  it('rejects an element with the wrong arity (3-tuple)', () => {
    expect(() => assertRouteCoords([[60.17, 24.94, 0]], 'routeCoords')).toThrow(/\[lat, lng\] pairs/);
  });

  it('rejects non-number elements (string lat)', () => {
    expect(() => assertRouteCoords([['60', '24']], 'routeCoords')).toThrow(/finite numbers/);
  });

  it('rejects NaN', () => {
    expect(() => assertRouteCoords([[NaN, 24]], 'routeCoords')).toThrow(/finite numbers/);
  });

  it('rejects Infinity', () => {
    expect(() => assertRouteCoords([[0, Infinity]], 'routeCoords')).toThrow(/finite numbers/);
  });

  it('rejects latitude below -90', () => {
    expect(() => assertRouteCoords([[-90.0001, 0]], 'routeCoords')).toThrow(/latitude out of range/);
  });

  it('rejects latitude above 90', () => {
    expect(() => assertRouteCoords([[90.0001, 0]], 'routeCoords')).toThrow(/latitude out of range/);
  });

  it('rejects longitude below -180', () => {
    expect(() => assertRouteCoords([[0, -180.0001]], 'routeCoords')).toThrow(/longitude out of range/);
  });

  it('rejects longitude above 180', () => {
    expect(() => assertRouteCoords([[0, 180.0001]], 'routeCoords')).toThrow(/longitude out of range/);
  });

  it('includes the field name in the error message', () => {
    expect(() => assertRouteCoords('x', 'returnRouteCoords')).toThrow(/returnRouteCoords/);
  });
});
