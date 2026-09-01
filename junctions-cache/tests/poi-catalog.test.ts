// @vitest-environment node
// Tests for src/poi-catalog.ts — selector → filters resolution and the
// cache-key fragment. Cross-repo drift against wander/poi-types.js is a
// separate guard: wander/tests/poi-catalog-parity.test.js.

import { describe, test, expect } from 'vitest';
import { POI_FILTERS, filtersForTypes } from '../src/poi-catalog.js';

describe('filtersForTypes', () => {
    test("'all' returns every filter in the catalog", () => {
        const r = filtersForTypes('all');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.filters).toEqual(Object.values(POI_FILTERS));
        expect(r.filters).toHaveLength(Object.keys(POI_FILTERS).length);
        expect(r.typesKey).toBe('all');
    });

    test('a known key resolves to its filter', () => {
        const r = filtersForTypes(['cafe']);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.filters).toEqual(['["amenity"="cafe"]']);
        expect(r.typesKey).toBe('cafe');
    });

    // A silent drop would look to the client like "no places nearby" and send
    // the walk to a random point with nothing to say anything went wrong.
    test('an unknown key is an error, not a silent drop', () => {
        const r = filtersForTypes(['nope']);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toContain('nope');
    });

    test('one unknown key among known ones still fails the whole request', () => {
        const r = filtersForTypes(['cafe', 'nope', 'park']);
        expect(r.ok).toBe(false);
    });

    // An empty union is a VALID Overpass query that matches nothing, so an
    // empty list must be rejected rather than sent upstream.
    test('an empty array is an error, not an empty union', () => {
        expect(filtersForTypes([]).ok).toBe(false);
    });

    test('a non-array, non-"all" selector is an error', () => {
        expect(filtersForTypes('cafe' as unknown as string[]).ok).toBe(false);
        expect(filtersForTypes(null as unknown as string[]).ok).toBe(false);
        expect(filtersForTypes(42 as unknown as string[]).ok).toBe(false);
    });

    test('a non-string element is an error', () => {
        expect(filtersForTypes([42 as unknown as string]).ok).toBe(false);
    });

    // Order independence is what stops the same search from minting two cache
    // entries and fetching the identical set twice.
    test('typesKey is order-independent', () => {
        const a = filtersForTypes(['park', 'cafe']);
        const b = filtersForTypes(['cafe', 'park']);
        expect(a.ok && b.ok).toBe(true);
        if (!a.ok || !b.ok) return;
        expect(a.typesKey).toBe(b.typesKey);
        expect(a.typesKey).toBe('cafe+park');
    });

    test('duplicate keys collapse so they cannot fork the cache key', () => {
        const once = filtersForTypes(['cafe']);
        const twice = filtersForTypes(['cafe', 'cafe']);
        expect(once.ok && twice.ok).toBe(true);
        if (!once.ok || !twice.ok) return;
        expect(twice.typesKey).toBe(once.typesKey);
        expect(twice.filters).toEqual(once.filters);
    });

    test('every catalog key resolves individually', () => {
        for (const key of Object.keys(POI_FILTERS)) {
            const r = filtersForTypes([key]);
            expect(r.ok, `key ${key} failed to resolve`).toBe(true);
            if (!r.ok) continue;
            expect(r.filters).toEqual([POI_FILTERS[key]]);
        }
    });
});
