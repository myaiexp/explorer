// Unit tests for the shared scalar field validators (isIsoDate / tooLong / payloadLength).
import { describe, it, expect } from 'vitest';
import {
  isIsoDate,
  tooLong,
  payloadLength,
  MAX_DATE_LEN,
} from './validate-fields.js';

describe('isIsoDate', () => {
  it('accepts bare dates and full timestamps', () => {
    expect(isIsoDate('2026-06-02')).toBe(true);
    expect(isIsoDate('2026-06-02T10:00:00Z')).toBe(true);
    expect(isIsoDate('2026-06-02T10:00:00.123+02:00')).toBe(true);
  });

  it('rejects non-strings, empties, and malformed values', () => {
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate(0)).toBe(false);
    expect(isIsoDate('')).toBe(false);
    expect(isIsoDate('last tuesday')).toBe(false);
    expect(isIsoDate('DROP TABLE visits')).toBe(false);
    expect(isIsoDate('06/02/2026')).toBe(false); // wrong order, no YYYY- prefix
  });

  it('rejects a value with a valid prefix but unparseable remainder', () => {
    expect(isIsoDate('2026-13-99nonsense')).toBe(false); // matches prefix, Date.parse → NaN
  });

  it('rejects strings longer than the date cap before Date.parse runs', () => {
    expect(isIsoDate('2026-06-02' + 'x'.repeat(MAX_DATE_LEN))).toBe(false);
  });
});

describe('tooLong', () => {
  it('is true only for strings over the limit', () => {
    expect(tooLong('x'.repeat(11), 10)).toBe(true);
    expect(tooLong('x'.repeat(10), 10)).toBe(false);
    expect(tooLong('', 10)).toBe(false);
  });

  it('treats non-strings as not-too-long (caller decides separately)', () => {
    expect(tooLong(undefined, 10)).toBe(false);
    expect(tooLong(12345, 1)).toBe(false);
    expect(tooLong({}, 1)).toBe(false);
  });
});

describe('payloadLength', () => {
  it('returns the serialized character length', () => {
    expect(payloadLength({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
    expect(payloadLength('hi')).toBe(4); // '"hi"'
    expect(payloadLength(0)).toBe(1);
  });

  it('returns 0 for unserializable values', () => {
    expect(payloadLength(undefined)).toBe(0);
    expect(payloadLength(() => {})).toBe(0);
  });
});
