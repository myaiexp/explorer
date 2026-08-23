// @vitest-environment jsdom
/**
 * Tests for poi-types.js — the Overpass catalog behind the destination-type
 * dropdown, plus the one-time populateLocationTypeSelect IIFE (finding #7584).
 *
 * destination-resolve.test.js installs a two-entry fake POI_TYPES, so a typo
 * in a production filter (e.g. amenity~pub|bar) or a dropped catalog key never
 * failed CI — Overpass returns empty and generate silently falls back to
 * random points. This file loads the real catalog.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeEach(() => {
    document.body.innerHTML = '<select id="locationTypeSelect"></select>';
    loadScripts('poi-types');
});

// Production snapshot: key → Overpass tag filter, in catalog order. any_poi
// unions these in this order (destination-resolve maps POI_TYPES.map(p => p.filter)).
const FILTERS = {
    park: '["leisure"="park"]',
    nature_reserve: '["leisure"="nature_reserve"]',
    forest: '["landuse"="forest"]',
    beach: '["natural"="beach"]',
    viewpoint: '["tourism"="viewpoint"]',
    playground: '["leisure"="playground"]',
    pitch: '["leisure"="pitch"]',
    cafe: '["amenity"="cafe"]',
    restaurant: '["amenity"="restaurant"]',
    pub: '["amenity"~"pub|bar"]',
    library: '["amenity"="library"]',
    museum: '["tourism"="museum"]',
    historic: '["historic"]',
};

const GROUPS = ['Nature & outdoors', 'Activity', 'Food & drink', 'Culture'];

describe('POI_TYPES catalog', () => {
    test('keys and Overpass filters match the production snapshot', () => {
        expect(Object.fromEntries(POI_TYPES.map((p) => [p.key, p.filter]))).toEqual(FILTERS);
        expect(POI_TYPES.map((p) => p.key)).toEqual(Object.keys(FILTERS));
    });

    test('any_poi union is every catalog filter, in catalog order', () => {
        expect(POI_TYPES.map((p) => p.filter)).toEqual(Object.values(FILTERS));
        expect(POI_TYPES.map((p) => p.key))
            .toEqual(POI_CATEGORIES.flatMap((c) => c.pois.map((p) => p.key)));
        expect(POI_TYPES.every((p) => typeof p.filter === 'string' && p.filter.length > 0))
            .toBe(true);
    });

    test('keys are unique and every entry has a label', () => {
        const keys = POI_TYPES.map((p) => p.key);
        expect(new Set(keys).size).toBe(keys.length);
        expect(POI_TYPES.every((p) => typeof p.label === 'string' && p.label.length > 0)).toBe(true);
    });
});

describe('populateLocationTypeSelect', () => {
    test('emits any/roads/any_poi then one optgroup per category', () => {
        const sel = document.getElementById('locationTypeSelect');
        const direct = [...sel.children]
            .filter((n) => n.tagName === 'OPTION')
            .map((o) => o.value);
        expect(direct).toEqual(['any', 'roads', 'any_poi']);

        const groups = [...sel.querySelectorAll('optgroup')];
        expect(groups.map((g) => g.label)).toEqual(GROUPS);
        expect(groups.map((g) => g.label)).toEqual(POI_CATEGORIES.map((c) => c.group));

        for (const cat of POI_CATEGORIES) {
            const group = groups.find((g) => g.label === cat.group);
            expect([...group.children].map((o) => o.value)).toEqual(cat.pois.map((p) => p.key));
            expect([...group.children].map((o) => o.text)).toEqual(cat.pois.map((p) => p.label));
        }

        expect([...sel.options].map((o) => o.value))
            .toEqual(['any', 'roads', 'any_poi', ...POI_TYPES.map((p) => p.key)]);
    });

    test('every strategy and catalog key is a selectable option', () => {
        const sel = document.getElementById('locationTypeSelect');
        for (const value of ['any', 'roads', 'any_poi', ...POI_TYPES.map((p) => p.key)]) {
            sel.value = value;
            expect(sel.value).toBe(value);
        }
        // A key that isn't an <option> does not stick — the discriminator
        // against a dropped catalog entry that settings restore would miss.
        sel.value = 'not_a_poi';
        expect(sel.value).not.toBe('not_a_poi');
    });
});
