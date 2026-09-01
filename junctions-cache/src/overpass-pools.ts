// Overpass queries + element extraction for the POI and road candidate pools.
//
// TWIN: explorer/overpass.js carried fetchPOIsInRadius / fetchRoadsInRadius with
// exactly these queries and exactly this extraction — this is that logic moved
// server-side so a generate ships kilobytes of candidates instead of megabytes
// of OSM elements. The queries MUST stay equivalent to the frontend's or a
// server-picked destination stops matching what the client used to find.
//
// Distance filtering is NOT here: these fetchers cover the wide bbox and the
// caller (lookups.ts) narrows to the annulus, because the annulus-filtered set
// is what gets cached.

import {
    runOverpassQuery,
    HIGHWAY_EXCLUDE,
    type Bbox,
    type ExcludePreset,
    type LatLng,
    type OverpassElement,
} from './overpass.js';

// `name` is present only when the OSM element carries one. The frontend stored
// `el.tags?.name || null`; on the wire the field is omitted instead, and the
// client normalizes an absent name back to null.
export type PoiPoint = { lat: number; lng: number; name?: string };

function bboxLiteral(bbox: Bbox): string {
    return `${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng}`;
}

// One node+way statement per filter, unioned. A `way` matches via its centroid
// (`out center`), which is why parsePois reads el.center for ways.
export function buildPoiQuery(bbox: Bbox, filters: string[]): string {
    const b = bboxLiteral(bbox);
    const union = filters
        .map(f => `  node${f}(${b});\n  way${f}(${b});`)
        .join('\n');
    return `[out:json][timeout:20];\n(\n${union}\n);\nout center tags;`;
}

export function buildRoadQuery(bbox: Bbox, exclude: ExcludePreset): string {
    return `[out:json][timeout:15];\n`
        + `way["highway"]["highway"!~"${HIGHWAY_EXCLUDE[exclude]}"](${bboxLiteral(bbox)});\n`
        + `out center;`;
}

// A `node` contributes its own coordinates, a `way` its centroid. Everything
// else — a relation, or a way whose centroid Overpass did not return — is
// dropped, exactly as the frontend did.
export function parsePois(elements: OverpassElement[]): PoiPoint[] {
    const out: PoiPoint[] = [];
    for (const el of elements) {
        let lat: number | undefined;
        let lng: number | undefined;
        if (el.type === 'node') {
            lat = el.lat;
            lng = el.lon;
        } else if (el.type === 'way' && el.center) {
            lat = el.center.lat;
            lng = el.center.lon;
        } else {
            continue;
        }
        if (lat == null || lng == null) continue;
        const name = el.tags?.name;
        out.push(name ? { lat, lng, name } : { lat, lng });
    }
    return out;
}

// Roads snap to way centroids only; the query asks for `out center`, so a node
// in the response is not a road candidate.
export function parseRoads(elements: OverpassElement[]): LatLng[] {
    const out: LatLng[] = [];
    for (const el of elements) {
        if (el.type === 'way' && el.center) {
            out.push({ lat: el.center.lat, lng: el.center.lon });
        }
    }
    return out;
}

// `filters` are resolved catalog values (poi-catalog.ts), never a client string:
// interpolating a caller-supplied filter here would make this service an
// arbitrary-query injection point against our own Overpass instance.
export async function fetchPoisFromOverpass(bbox: Bbox, filters: string[]): Promise<PoiPoint[]> {
    return parsePois(await runOverpassQuery(buildPoiQuery(bbox, filters)));
}

export async function fetchRoadsFromOverpass(bbox: Bbox, exclude: ExcludePreset): Promise<LatLng[]> {
    return parseRoads(await runOverpassQuery(buildRoadQuery(bbox, exclude)));
}
