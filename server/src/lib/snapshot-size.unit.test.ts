// Unit tests for the per-account stored-jsonb budget helpers (finding #7756).
import { describe, it, expect } from 'vitest';
import { schema } from '../db.js';
import {
  GET_SNAPSHOT_MAX_BYTES,
  MAX_IMPORT_BODY_BYTES,
  MAX_STORED_BYTES,
} from './validate-fields.js';
import {
  incomingJsonbBytes,
  storedJsonbBytes,
  wouldExceedStoredBudget,
} from './snapshot-size.js';

describe('MAX_STORED_BYTES', () => {
  it('is 32 MiB — larger than the GET dump cap and the import body cap', () => {
    expect(MAX_STORED_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_STORED_BYTES).toBeGreaterThan(GET_SNAPSHOT_MAX_BYTES);
    // A single import cannot exceed the stored budget unless these drift; the
    // runtime import check exists so a later body-cap raise cannot silently
    // land a too-fat replace.
    expect(MAX_IMPORT_BODY_BYTES).toBeLessThanOrEqual(MAX_STORED_BYTES);
  });
});

describe('storedJsonbBytes', () => {
  it('counts UTF-8 bytes of JSON.stringify', () => {
    expect(storedJsonbBytes({ a: 1 })).toBe(Buffer.byteLength(JSON.stringify({ a: 1 }), 'utf8'));
    expect(storedJsonbBytes('hi')).toBe(4); // '"hi"'
  });

  it('returns 0 for null, undefined, and unserializable values', () => {
    expect(storedJsonbBytes(null)).toBe(0);
    expect(storedJsonbBytes(undefined)).toBe(0);
    expect(storedJsonbBytes(() => {})).toBe(0);
  });

  it('counts UTF-8, not UTF-16 code units', () => {
    // One emoji is 2 UTF-16 units and 4 UTF-8 bytes; JSON.stringify adds quotes.
    const payload = { n: '😀' };
    const json = JSON.stringify(payload);
    expect(json.length).toBeLessThan(Buffer.byteLength(json, 'utf8'));
    expect(storedJsonbBytes(payload)).toBe(Buffer.byteLength(json, 'utf8'));
  });
});

describe('incomingJsonbBytes', () => {
  it('counts favorite payload only', () => {
    const payload = { destName: 'park', blob: 'x'.repeat(100) };
    expect(incomingJsonbBytes(schema.favorites, { payload })).toBe(storedJsonbBytes(payload));
  });

  it('sums visit/history polylines and ignores other columns', () => {
    const routeCoords = [[60.1, 24.9], [60.2, 25.0]];
    const returnRouteCoords = [[60.2, 25.0], [60.1, 24.9]];
    const row = { routeCoords, returnRouteCoords, destName: 'x'.repeat(500) };
    expect(incomingJsonbBytes(schema.visits, row)).toBe(
      storedJsonbBytes(routeCoords) + storedJsonbBytes(returnRouteCoords),
    );
    expect(incomingJsonbBytes(schema.history, row)).toBe(
      storedJsonbBytes(routeCoords) + storedJsonbBytes(returnRouteCoords),
    );
  });

  it('is 0 for saved-locations and for trips without coords', () => {
    expect(incomingJsonbBytes(schema.savedLocations, { label: 'Home', value: '60,25' })).toBe(0);
    expect(incomingJsonbBytes(schema.visits, { destName: 'no coords' })).toBe(0);
  });
});

describe('wouldExceedStoredBudget', () => {
  it('rejects a growth that would land above the budget', () => {
    expect(wouldExceedStoredBudget(1, MAX_STORED_BYTES, 0)).toBe(true);
    expect(wouldExceedStoredBudget(100, MAX_STORED_BYTES - 50, 0)).toBe(true);
  });

  it('allows a write that lands exactly on the budget', () => {
    expect(wouldExceedStoredBudget(50, MAX_STORED_BYTES - 50, 0)).toBe(false);
  });

  it('allows shrinks and no-ops even when already over budget', () => {
    expect(wouldExceedStoredBudget(500, MAX_STORED_BYTES + 500, 400)).toBe(true); // growth
    expect(wouldExceedStoredBudget(100, MAX_STORED_BYTES + 500, 100)).toBe(false); // no-op
    expect(wouldExceedStoredBudget(50, MAX_STORED_BYTES + 500, 100)).toBe(false); // shrink
  });

  it('allows a 0-byte insert (saved-locations) at or over the budget', () => {
    expect(wouldExceedStoredBudget(0, MAX_STORED_BYTES, 0)).toBe(false);
    expect(wouldExceedStoredBudget(0, MAX_STORED_BYTES + 1, 0)).toBe(false);
  });
});
