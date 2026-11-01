// Cache-key derivation and the lookup protocol (hit / inflight-join / fetch)
// over cache-store.ts. Inflight dedup via a parallel Map<key, Promise> so
// concurrent identical requests share work.
//
// Keys are namespaced by query kind, because different queries over the same
// bbox return different things — roads and junctions share an `exclude` preset
// but run `out center` versus `out body; >; out skel qt;`, so a shared key would
// serve junction points as road candidates:
//   bbox-keyed (legacy):  "minLat,minLng,maxLat,maxLng|exclude"
//   start-anchored:       "s|lat,lng|maxKm|exclude"
// The bbox path serves GET and bbox-only POST; anchored clients POST
// startLat/startLng/maxKm in the JSON body.

import type { Anchor } from './lib/parse-request.js';
import type { Bbox, ExcludePreset } from './overpass.js';
import { fetchJunctionsFromOverpass } from './overpass.js';
import { runWithOverpassSlot } from './overpass-limit.js';
import { readFresh, setEntry, prune, bumpAndSave, type CachedPoint } from './cache-store.js';

// Re-exported so cache.js stays the module's public face for consumers that
// only need to boot the store or report its size (index.ts, /health).
export { loadCache, cacheSize } from './cache-store.js';
export type { CachedPoint, Entry } from './cache-store.js';

const QUANTIZE_DECIMALS = 4;        // ~11m at the equator (legacy bbox path)
const START_QUANTIZE_DECIMALS = 3;  // ~111m — coarse enough to merge nearby starts

const inflight = new Map<string, Promise<CachedPoint[]>>();

function quantizeCoord(n: number): string {
    return n.toFixed(QUANTIZE_DECIMALS);
}

function keyFor(bbox: Bbox, exclude: ExcludePreset): string {
    return `${quantizeCoord(bbox.minLat)},${quantizeCoord(bbox.minLng)},${quantizeCoord(bbox.maxLat)},${quantizeCoord(bbox.maxLng)}|${exclude}`;
}

// Anchored key fragment shared by every start-anchored query kind. The caller
// supplies the kind prefix and the query-specific discriminator (exclude preset,
// POI types key) so two kinds can never collide on one entry.
export function anchoredKey(kind: string, anchor: Anchor, discriminator: string): string {
    const lat = anchor.startLat.toFixed(START_QUANTIZE_DECIMALS);
    const lng = anchor.startLng.toFixed(START_QUANTIZE_DECIMALS);
    // Bucket maxKm to whole km — small variations shouldn't fragment the cache.
    const km = Math.ceil(anchor.maxKm);
    return `${kind}|${lat},${lng}|${km}|${discriminator}`;
}

function startKeyFor(anchor: Anchor, exclude: ExcludePreset): string {
    return anchoredKey('s', anchor, exclude);
}

// Wide bbox that covers every possible destination within maxKm of start.
// Slightly conservative on lng padding (uses cos at the start lat).
export function wideBboxFromStart(anchor: Anchor): Bbox {
    const km = Math.ceil(anchor.maxKm);
    const latPad = km / 111;
    const lngPad = km / (111 * Math.max(0.05, Math.cos(anchor.startLat * Math.PI / 180)));
    return {
        minLat: Math.max(-90, anchor.startLat - latPad),
        minLng: Math.max(-180, anchor.startLng - lngPad),
        maxLat: Math.min(90, anchor.startLat + latPad),
        maxLng: Math.min(180, anchor.startLng + lngPad)
    };
}

function filterToBbox(points: CachedPoint[], bbox: Bbox): CachedPoint[] {
    const out: CachedPoint[] = [];
    for (const p of points) {
        if (p.lat >= bbox.minLat && p.lat <= bbox.maxLat
            && p.lng >= bbox.minLng && p.lng <= bbox.maxLng) {
            out.push(p);
        }
    }
    return out;
}

// `points` holds whatever the key's query kind caches: junctions, POIs or road
// centroids. lookupOrFetch is the one place it meets the persisted
// Entry.junctions name.
export type LookupResult =
    | { cache: 'hit'; points: CachedPoint[] }
    | { cache: 'miss' | 'coalesced'; points: CachedPoint[]; overpassMs: number };

export type AnchoredLookupResult = LookupResult & { total: number };

// overpassMs is on every live Overpass wait — originator (`miss`) and
// inflight-join (`coalesced`). Instant in-memory hits omit it.
export function overpassMsOf(result: LookupResult): number | undefined {
    return result.cache === 'hit' ? undefined : result.overpassMs;
}

// Shared hit / inflight-join / Overpass-miss protocol. Key derivation and the
// result projection (identity vs filterToBbox) stay in the wrappers so a TTL,
// inflight, or persist fix cannot fork between bbox and anchored modes.
export async function lookupOrFetch(
    key: string,
    fetchFn: () => Promise<CachedPoint[]>,
): Promise<LookupResult> {
    const cached = readFresh(key);
    if (cached) return { cache: 'hit', points: cached.junctions };

    const existing = inflight.get(key);
    if (existing) {
        const t0 = Date.now();
        const points = await existing;
        return { cache: 'coalesced', points, overpassMs: Date.now() - t0 };
    }

    // t0 spans any throttle-queue wait too, so overpassMs reflects total miss
    // latency under contention (it equals raw fetch time when slots are free).
    const t0 = Date.now();
    const promise = runWithOverpassSlot(fetchFn);
    inflight.set(key, promise);
    try {
        const points = await promise;
        const overpassMs = Date.now() - t0;
        setEntry(key, { junctions: points, cachedAt: Date.now() });
        prune(Date.now());
        bumpAndSave();
        return { cache: 'miss', points, overpassMs };
    } finally {
        inflight.delete(key);
    }
}

export async function getJunctions(bbox: Bbox, exclude: ExcludePreset): Promise<LookupResult> {
    return lookupOrFetch(keyFor(bbox, exclude), () => fetchJunctionsFromOverpass(bbox, exclude));
}

// Cache a wide-bbox fetch by (start, maxKm, exclude); filter to `requested`
// before returning so the wire payload stays small.
export async function getJunctionsAnchored(
    anchor: Anchor,
    exclude: ExcludePreset,
    requested: Bbox
): Promise<AnchoredLookupResult> {
    const wide = wideBboxFromStart(anchor);
    const result = await lookupOrFetch(
        startKeyFor(anchor, exclude),
        () => fetchJunctionsFromOverpass(wide, exclude)
    );
    const projected = {
        ...result,
        points: filterToBbox(result.points, requested),
        total: result.points.length
    };
    return projected;
}
