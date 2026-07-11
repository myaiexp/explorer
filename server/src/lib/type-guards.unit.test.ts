import { describe, it, expect } from 'vitest';
import { isObject, isArray } from './type-guards.js';

// Mutation-proof (audit #1267): inverting the `!Array.isArray(v)` guard in isObject
//   (drop the `!`) turns "false on an array" RED — verified RED then restored to green.

describe('isObject', () => {
  it('true on a plain object', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it('false on null', () => {
    expect(isObject(null)).toBe(false);
  });

  it('false on an array', () => {
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2, 3])).toBe(false);
  });

  it('false on primitives', () => {
    expect(isObject(undefined)).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject('str')).toBe(false);
    expect(isObject(true)).toBe(false);
  });

  it('true on Date and RegExp (non-plain objects still pass the typeof/array test)', () => {
    expect(isObject(new Date())).toBe(true);
    expect(isObject(/re/)).toBe(true);
  });
});

describe('isArray', () => {
  it('true on arrays', () => {
    expect(isArray([])).toBe(true);
    expect(isArray([1, 2, 3])).toBe(true);
  });

  it('false on non-arrays', () => {
    expect(isArray({})).toBe(false);
    expect(isArray(null)).toBe(false);
    expect(isArray('str')).toBe(false);
  });
});
