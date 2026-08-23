// Pins the *_test hard-throw that keeps truncateAll() off prod (finding #7777).
import { describe, it, expect } from 'vitest';
import { dbNameOf, toTestUrl, guardedTestUrl } from './test-db.js';

const PROD = 'postgresql://explorer:secret@localhost:5432/explorer';
const TEST = 'postgresql://explorer:secret@localhost:5432/explorer_test';
const WITH_QUERY = 'postgresql://explorer:secret@localhost:5432/explorer?sslmode=disable';
const SOCKET = 'postgresql://explorer@/explorer?host=/var/run/postgresql';

describe('dbNameOf (finding #7777)', () => {
  it('takes the path segment after scheme://authority', () => {
    expect(dbNameOf(PROD)).toBe('explorer');
    expect(dbNameOf(TEST)).toBe('explorer_test');
  });

  it('strips query strings and fragments', () => {
    expect(dbNameOf(WITH_QUERY)).toBe('explorer');
    expect(dbNameOf(`${PROD}#frag`)).toBe('explorer');
    expect(dbNameOf(`${WITH_QUERY}#frag`)).toBe('explorer');
  });

  it('parses a socket-style URL that `new URL` rejects', () => {
    expect(dbNameOf(SOCKET)).toBe('explorer');
  });
});

describe('toTestUrl (finding #7777)', () => {
  it('suffixes explorer → explorer_test', () => {
    expect(toTestUrl(PROD)).toBe(TEST);
  });

  it('leaves a name already ending in _test alone', () => {
    expect(toTestUrl(TEST)).toBe(TEST);
  });

  it('preserves query strings (and fragments) when suffixing', () => {
    expect(toTestUrl(WITH_QUERY)).toBe(
      'postgresql://explorer:secret@localhost:5432/explorer_test?sslmode=disable',
    );
    expect(toTestUrl(`${PROD}#frag`)).toBe(`${TEST}#frag`);
    expect(toTestUrl(SOCKET)).toBe(
      'postgresql://explorer@/explorer_test?host=/var/run/postgresql',
    );
  });
});

describe('guardedTestUrl (finding #7777)', () => {
  it('derives explorer_test from a prod .env fallback', () => {
    expect(guardedTestUrl(undefined, PROD)).toBe(TEST);
  });

  it('leaves a fallback that already ends in _test alone', () => {
    expect(guardedTestUrl(undefined, TEST)).toBe(TEST);
  });

  it('uses an explicit TEST_DATABASE_URL ending in _test verbatim', () => {
    const ci = 'postgresql://ci@db/ci_test?sslmode=require';
    expect(guardedTestUrl(ci, PROD)).toBe(ci);
  });

  it('throws when an explicit TEST_DATABASE_URL does not end in _test', () => {
    expect(() => guardedTestUrl(PROD, TEST)).toThrow(/non-test database "explorer"/);
  });

  it('throws when neither explicit nor fallback is set', () => {
    expect(() => guardedTestUrl(undefined, undefined)).toThrow(
      /Neither TEST_DATABASE_URL nor \.env DATABASE_URL is set/,
    );
  });

  it('throws when the derived name is empty', () => {
    expect(() => guardedTestUrl('postgresql://localhost', undefined)).toThrow(
      /non-test database/,
    );
  });
});
