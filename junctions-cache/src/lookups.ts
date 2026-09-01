// Start-anchored cache lookups for the POI and road candidate pools.
//
// Both follow the same shape: fetch the WIDE bbox around the start (one Overpass
// query serves every radius bucket), narrow to the requested annulus, and cache
// THAT set. The narrowing sits inside the fetchFn deliberately:
//
//   - inside → the cached value is the full annulus set for the anchor, so a
//     later hit can be re-sampled to a fresh random POOL_CAP slice instead of
//     replaying the same 45 candidates forever, and the on-disk snapshot holds
//     the ~hundreds of points a walk can actually use rather than the ~14k
//     elements the wide bbox returns;
//   - which in turn means the annulus bounds MUST be part of the cache key,
//     since the stored set is only correct for the min/max it was filtered by.
//     anchoredKey buckets maxKm to whole km — fine when the cached value is a
//     wide superset (junctions), wrong for a pre-filtered set — so the exact
//     bounds go in the discriminator.

import {
    anchoredKey,
    lookupOrFetch,
    wideBboxFromStart,
    type AnchoredLookupResult,
} from './cache.js';
import type { ExcludePreset } from './overpass.js';
import { fetchPoisFromOverpass, fetchRoadsFromOverpass } from './overpass-pools.js';
import type { PoolAnchor } from './lib/parse-pool-request.js';
import { filterToAnnulus } from './lib/pool.js';

// Metre precision: identical requests still share an entry, and two requests
// whose radii differ by under a metre share a set whose edge is off by less than
// the error in treating a crow-flies radius as a walking budget.
function annulusKey(anchor: PoolAnchor): string {
    return `${anchor.minKm.toFixed(3)}-${anchor.maxKm.toFixed(3)}`;
}

// Kind prefixes are 'p' and 'r' against junctions' 's'. Roads and junctions take
// the same exclude preset over the same bbox but run different queries
// (`out center` versus `out body; >; out skel qt;`), so a shared key would serve
// junction points as road candidates.
export async function getPoisAnchored(
    anchor: PoolAnchor,
    typesKey: string,
    filters: string[],
): Promise<AnchoredLookupResult> {
    const wide = wideBboxFromStart(anchor);
    const key = anchoredKey('p', anchor, `${typesKey}|${annulusKey(anchor)}`);
    const result = await lookupOrFetch(key, async () => {
        const pois = await fetchPoisFromOverpass(wide, filters);
        return filterToAnnulus(pois, anchor.startLat, anchor.startLng, anchor.minKm, anchor.maxKm);
    });
    return { ...result, total: result.junctions.length };
}

export async function getRoadsAnchored(
    anchor: PoolAnchor,
    exclude: ExcludePreset,
): Promise<AnchoredLookupResult> {
    const wide = wideBboxFromStart(anchor);
    const key = anchoredKey('r', anchor, `${exclude}|${annulusKey(anchor)}`);
    const result = await lookupOrFetch(key, async () => {
        const roads = await fetchRoadsFromOverpass(wide, exclude);
        return filterToAnnulus(roads, anchor.startLat, anchor.startLng, anchor.minKm, anchor.maxKm);
    });
    return { ...result, total: result.junctions.length };
}
