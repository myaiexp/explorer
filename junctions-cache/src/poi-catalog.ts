// POI catalog — the Overpass filters behind the frontend's destination-type
// dropdown, keyed by the same catalog keys the dropdown uses.
//
// TWIN: explorer/poi-types.js carries the same key → filter pairs in its
// POI_CATEGORIES list. Deliberately independent — separate deployables (this
// ships to shelly, that serves as a raw static asset), so there is no build
// step to share a constant through. The filter strings MUST stay byte-identical
// or a POI search returns a different set than the frontend's catalog claims to
// offer. explorer/tests/poi-catalog-parity.test.js fails RED if the two copies
// drift, in both directions.
//
// The server owns this copy because /pois takes catalog KEYS, never filter
// strings: accepting a raw Overpass filter from a client would turn this
// service into an arbitrary-query injection point against our own instance.

export const POI_FILTERS: Record<string, string> = {
    park:           '["leisure"="park"]',
    nature_reserve: '["leisure"="nature_reserve"]',
    forest:         '["landuse"="forest"]',
    beach:          '["natural"="beach"]',
    viewpoint:      '["tourism"="viewpoint"]',
    playground:     '["leisure"="playground"]',
    pitch:          '["leisure"="pitch"]',
    cafe:           '["amenity"="cafe"]',
    restaurant:     '["amenity"="restaurant"]',
    pub:            '["amenity"~"pub|bar"]',
    library:        '["amenity"="library"]',
    museum:         '["tourism"="museum"]',
    historic:       '["historic"]',
};

// 'all' is the whole catalog — the frontend's "any POI" option, and the default
// destination type. An explicit key list is anything narrower.
export type TypesSelector = string[] | 'all';

export type FiltersResult =
    | { ok: true; filters: string[]; typesKey: string }
    | { ok: false; error: string };

// Resolve a selector to the Overpass filters it names, plus the cache-key
// fragment for it. `typesKey` is 'all' for the whole catalog, otherwise the
// sorted deduplicated keys joined by '+', so ["park","cafe"] and ["cafe","park"]
// share one cache entry instead of fetching the same set twice.
//
// An unknown key and an empty list are BOTH errors, never a silent drop or an
// empty union: an empty union is a valid Overpass query that matches nothing, so
// swallowing either would look to the client like "no places nearby" and send
// the walk to a random point with no indication anything went wrong.
export function filtersForTypes(types: TypesSelector): FiltersResult {
    if (types === 'all') {
        return { ok: true, filters: Object.values(POI_FILTERS), typesKey: 'all' };
    }
    if (!Array.isArray(types)) {
        return { ok: false, error: 'types must be an array of catalog keys or the string "all"' };
    }
    if (types.length === 0) {
        return { ok: false, error: 'types must name at least one POI key' };
    }
    const unknown = types.filter(k => typeof k !== 'string' || !(k in POI_FILTERS));
    if (unknown.length > 0) {
        return { ok: false, error: `unknown POI type(s): ${unknown.join(', ')}` };
    }
    const keys = [...new Set(types)].sort();
    return {
        ok: true,
        filters: keys.map(k => POI_FILTERS[k]!),
        typesKey: keys.join('+'),
    };
}
