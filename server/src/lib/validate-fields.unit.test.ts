// Unit tests for the shared scalar field validators (isIsoDate / tooLong / payloadLength).
import { describe, it, expect } from 'vitest';
import {
  isIsoDate,
  tooLong,
  payloadLength,
  idError,
  MAX_DATE_LEN,
  MAX_ID_LEN,
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

describe('idError', () => {
  // Mirrors visit-shape.js idOrNull: ids become URL path segments and PK
  // columns, so import/PUT must reject anything the client would drop.
  it('accepts uuids, legacy numeric strings, dots-in-names, and the 128-char cap', () => {
    expect(idError('0f9c1e7a-3b2d-4c8e-9a11-7d6f5b4c3a21')).toBeNull();
    expect(idError('1714500000000')).toBeNull();
    expect(idError('walk.2026.04.27')).toBeNull();
    expect(idError('a'.repeat(MAX_ID_LEN))).toBeNull();
    expect(idError('id_with-tilde~ok')).toBeNull();
  });

  it('rejects missing or empty ids', () => {
    expect(idError(undefined)).toBe('Missing required field: id');
    expect(idError('')).toBe('Missing required field: id');
    expect(idError(123)).toBe('Missing required field: id');
  });

  it('rejects strings over the 128-char cap', () => {
    expect(idError('a'.repeat(MAX_ID_LEN + 1))).toBe(
      `id exceeds maximum length of ${MAX_ID_LEN}`
    );
  });

  it.each([
    ['a path separator', 'a/b'],
    ['a traversal segment', '..'],
    ['a bare dot', '.'],
    ['only dots', '...'],
    ['a leading traversal', '../../accounts'],
    ['a percent escape', '%2e%2e'],
    ['a query fragment', 'id?x=1'],
    ['whitespace', 'id with space'],
  ])('rejects an id with %s', (_label, id) => {
    expect(idError(id)).toBe('id contains invalid characters');
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
