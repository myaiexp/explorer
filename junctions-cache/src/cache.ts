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
// The bbox path is kept for GET / bbox-only POST; new clients POST
// startLat/startLng/maxKm in the JSON body and hit the anchored path.

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

export type StartParams = { startLat: number; startLng: number; maxKm: number };

// Anchored key fragment shared by every start-anchored query kind. The caller
// supplies the kind prefix and the query-specific discriminator (exclude preset,
// POI types key) so two kinds can never collide on one entry.
export function anchoredKey(kind: string, start: StartParams, discriminator: string): string {
    const lat = start.startLat.toFixed(START_QUANTIZE_DECIMALS);
    const lng = start.startLng.toFixed(START_QUANTIZE_DECIMALS);
    // Bucket maxKm to whole km — small variations shouldn't fragment the cache.
    const km = Math.ceil(start.maxKm);
    return `${kind}|${lat},${lng}|${km}|${discriminator}`;
}

function startKeyFor(start: StartParams, exclude: ExcludePreset): string {
    return anchoredKey('s', start, exclude);
}

// Wide bbox that covers every possible destination within maxKm of start.
// Slightly conservative on lng padding (uses cos at the start lat).
export function wideBboxFromStart(start: StartParams): Bbox {
    const km = Math.ceil(start.maxKm);
    const latPad = km / 111;
    const lngPad = km / (111 * Math.max(0.05, Math.cos(start.startLat * Math.PI / 180)));
    return {
        minLat: Math.max(-90, start.startLat - latPad),
        minLng: Math.max(-180, start.startLng - lngPad),
        maxLat: Math.min(90, start.startLat + latPad),
        maxLng: Math.min(180, start.startLng + lngPad)
    };
}

function filterToBbox(junctions: CachedPoint[], bbox: Bbox): CachedPoint[] {
    const out: CachedPoint[] = [];
    for (const j of junctions) {
        if (j.lat >= bbox.minLat && j.lat <= bbox.maxLat
            && j.lng >= bbox.minLng && j.lng <= bbox.maxLng) {
            out.push(j);
        }
    }
    return out;
}

export type LookupResult =
    | { cache: 'hit'; junctions: CachedPoint[] }
    | { cache: 'miss' | 'coalesced'; junctions: CachedPoint[]; overpassMs: number };

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
    if (cached) return { cache: 'hit', junctions: cached.junctions };

    const existing = inflight.get(key);
    if (existing) {
        const t0 = Date.now();
        const junctions = await existing;
        return { cache: 'coalesced', junctions, overpassMs: Date.now() - t0 };
    }

    // t0 spans any throttle-queue wait too, so overpassMs reflects total miss
    // latency under contention (it equals raw fetch time when slots are free).
    const t0 = Date.now();
    const promise = runWithOverpassSlot(fetchFn);
    inflight.set(key, promise);
    try {
        const junctions = await promise;
        const overpassMs = Date.now() - t0;
        setEntry(key, { junctions, cachedAt: Date.now() });
        prune(Date.now());
        bumpAndSave();
        return { cache: 'miss', junctions, overpassMs };
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
    start: StartParams,
    exclude: ExcludePreset,
    requested: Bbox
): Promise<AnchoredLookupResult> {
    const wide = wideBboxFromStart(start);
    const result = await lookupOrFetch(
        startKeyFor(start, exclude),
        () => fetchJunctionsFromOverpass(wide, exclude)
    );
    const projected = {
        ...result,
        junctions: filterToBbox(result.junctions, requested),
        total: result.junctions.length
    };
    return projected;
}
