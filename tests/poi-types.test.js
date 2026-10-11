// @vitest-environment jsdom
/**
 * Tests for poi-types.js — the Overpass filters that describe the
 * destination-type dropdown, plus the one-time populateLocationTypeSelect
 * IIFE (finding #7584).
 *
 * Those filter strings are the dropdown's description of each catalog key.
 * poi-catalog-parity.test.js locksteps them with junctions-cache's
 * poi-catalog.ts, which is what queries Overpass. any_poi does not union
 * them: destination-resolve sends the selector 'all' and the service expands
 * the catalog (destination-resolve.test.js).
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { loadScripts } from './helpers/load.js';

beforeEach(() => {
    document.body.innerHTML = '<select id="locationTypeSelect"></select>';
    loadScripts('poi-types');
});

// Production snapshot: key → Overpass tag filter, in catalog order. The
// dropdown's description of each key, not the any_poi query.
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

    test('flat catalog order is every category key, and every filter is a non-empty string', () => {
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
    // any_poi is FIRST, so a browser with nothing saved defaults to it. The
    // other half of that change is the one-time any → any_poi migration in
    // settings.js, which is what reaches browsers that already have a value.
    test('a fresh install defaults the select to any_poi', () => {
        expect(document.getElementById('locationTypeSelect').value).toBe('any_poi');
    });

    test('emits any_poi/any/roads then one optgroup per category', () => {
        const sel = document.getElementById('locationTypeSelect');
        const direct = [...sel.children]
            .filter((n) => n.tagName === 'OPTION')
            .map((o) => o.value);
        expect(direct).toEqual(['any_poi', 'any', 'roads']);

        const groups = [...sel.querySelectorAll('optgroup')];
        expect(groups.map((g) => g.label)).toEqual(GROUPS);
        expect(groups.map((g) => g.label)).toEqual(POI_CATEGORIES.map((c) => c.group));

        for (const cat of POI_CATEGORIES) {
            const group = groups.find((g) => g.label === cat.group);
            expect([...group.children].map((o) => o.value)).toEqual(cat.pois.map((p) => p.key));
            expect([...group.children].map((o) => o.text)).toEqual(cat.pois.map((p) => p.label));
        }

        expect([...sel.options].map((o) => o.value))
            .toEqual(['any_poi', 'any', 'roads', ...POI_TYPES.map((p) => p.key)]);
    });

    test('every strategy and catalog key is a selectable option', () => {
        const sel = document.getElementById('locationTypeSelect');
        for (const value of ['any_poi', 'any', 'roads', ...POI_TYPES.map((p) => p.key)]) {
            sel.value = value;
            expect(sel.value).toBe(value);
        }
        // A key that isn't an <option> does not stick — the discriminator
        // against a dropped catalog entry that settings restore would miss.
        sel.value = 'not_a_poi';
        expect(sel.value).not.toBe('not_a_poi');
    });
});
