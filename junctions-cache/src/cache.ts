// In-memory junction cache + persistent JSON snapshot. Inflight dedup via
// a parallel Map<key, Promise> so concurrent identical requests share work.
//
// Two key shapes coexist:
//   bbox-keyed (legacy):  "minLat,minLng,maxLat,maxLng|exclude"
//   start-anchored:       "s|lat,lng|maxKm|exclude"
// The bbox path is kept for GET / bbox-only POST; new clients POST
// startLat/startLng/maxKm in the JSON body and hit the anchored path.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Bbox, ExcludePreset, LatLng } from './overpass.js';
import { fetchJunctionsFromOverpass } from './overpass.js';
import { runWithOverpassSlot } from './overpass-limit.js';
import { log } from './log.js';

const CACHE_PATH = process.env.CACHE_PATH ?? './data/cache.json';
const QUANTIZE_DECIMALS = 4;        // ~11m at the equator (legacy bbox path)
const START_QUANTIZE_DECIMALS = 3;  // ~111m — coarse enough to merge nearby starts

function envPositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Freshness + size bounds so neither the in-memory store nor the JSON snapshot
// grows without limit (env-overridable for tuning on shelly, parity with
// CACHE_PATH). Without these every distinct quantized bbox/start key minted a
// permanent entry, cachedAt was never read (stale OSM roads served forever), and
// saveCache re-serialized an ever-growing store on every write.
//   TTL: OSM road-junction data changes slowly; 30 days keeps entries useful
//        while forcing an eventual refetch of stale roads.
//   CAPS: a 50 km anchored fetch can hold tens of thousands of points, so bound
//         both the entry COUNT and the total POINT count and evict oldest
//         (by cachedAt) first. Entry count alone left 500 × ~30k-point sets
//         free to grow toward a gigabyte.
const CACHE_TTL_MS = envPositiveInt('CACHE_TTL_MS', 30 * 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = envPositiveInt('CACHE_MAX_ENTRIES', 500);
const CACHE_MAX_POINTS = envPositiveInt('CACHE_MAX_POINTS', 1_000_000);
const CACHE_SAVE_DEBOUNCE_MS = envPositiveInt('CACHE_SAVE_DEBOUNCE_MS', 2000);

type Entry = { junctions: LatLng[]; cachedAt: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<LatLng[]>>();
let totalPoints = 0;
let generation = 0;
let savedGeneration = 0;
let saving: Promise<void> | null = null;

function setEntry(key: string, entry: Entry): void {
    const prev = store.get(key);
    if (prev) totalPoints -= prev.junctions.length;
    store.set(key, entry);
    totalPoints += entry.junctions.length;
}

function deleteEntry(key: string): void {
    const prev = store.get(key);
    if (!prev) return;
    totalPoints -= prev.junctions.length;
    store.delete(key);
}

function quantizeCoord(n: number): string {
    return n.toFixed(QUANTIZE_DECIMALS);
}

function keyFor(bbox: Bbox, exclude: ExcludePreset): string {
    return `${quantizeCoord(bbox.minLat)},${quantizeCoord(bbox.minLng)},${quantizeCoord(bbox.maxLat)},${quantizeCoord(bbox.maxLng)}|${exclude}`;
}

export type StartParams = { startLat: number; startLng: number; maxKm: number };

function startKeyFor(start: StartParams, exclude: ExcludePreset): string {
    const lat = start.startLat.toFixed(START_QUANTIZE_DECIMALS);
    const lng = start.startLng.toFixed(START_QUANTIZE_DECIMALS);
    // Bucket maxKm to whole km — small variations shouldn't fragment the cache.
    const km = Math.ceil(start.maxKm);
    return `s|${lat},${lng}|${km}|${exclude}`;
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

function filterToBbox(junctions: LatLng[], bbox: Bbox): LatLng[] {
    const out: LatLng[] = [];
    for (const j of junctions) {
        if (j.lat >= bbox.minLat && j.lat <= bbox.maxLat
            && j.lng >= bbox.minLng && j.lng <= bbox.maxLng) {
            out.push(j);
        }
    }
    return out;
}

// A persisted row is only usable if it has the Entry shape: a junctions array
// and a numeric cachedAt. Anything else (hand-edited file, partial write, schema
// drift) would crash a later getJunctions/filterToBbox, so it's dropped on load
// rather than stored as a landmine.
function isValidEntry(v: unknown): v is Entry {
    return typeof v === 'object' && v !== null
        && Array.isArray((v as Entry).junctions)
        && typeof (v as Entry).cachedAt === 'number';
}

export async function loadCache(): Promise<void> {
    try {
        const raw = await readFile(CACHE_PATH, 'utf8');
        const obj = JSON.parse(raw) as Record<string, unknown>;
        let dropped = 0;
        for (const [k, v] of Object.entries(obj)) {
            if (isValidEntry(v)) setEntry(k, v);
            else dropped++;
        }
        if (dropped > 0) {
            // Graceful degradation: skip the bad rows and rebuild them from
            // Overpass on demand — but surface the loss so it isn't silent.
            log('WARN', { event: 'cache_entries_dropped', dropped, kept: store.size, path: CACHE_PATH });
        }
        // Apply the TTL + cap to the loaded snapshot so a large or stale on-disk
        // file can't repopulate the store past its bounds; persist the shrunk set.
        const pruned = prune(Date.now());
        if (pruned > 0) {
            log('INFO', { event: 'cache_pruned_on_load', pruned, kept: store.size, path: CACHE_PATH });
            bumpAndSave();
        }
        log('INFO', { event: 'cache_loaded', entries: store.size, path: CACHE_PATH });
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            log('INFO', { event: 'cache_empty', path: CACHE_PATH });
        } else {
            // Includes JSON.parse SyntaxError when the whole snapshot is
            // unparseable: tolerate it (rebuild from Overpass) but log so the
            // dropped cache isn't silent.
            log('WARN', { event: 'cache_load_failed', err: err.message });
        }
    }
}

async function saveCache(): Promise<void> {
    if (generation === savedGeneration) return;
    const gen = generation;
    const obj: Record<string, Entry> = {};
    for (const [k, v] of store) obj[k] = v;
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, CACHE_PATH);
    savedGeneration = gen;
}

function bumpAndSave(): void {
    generation++;
    if (saving) return;
    saving = (async () => {
        // Debounce well above a single miss so a burst of distinct keys
        // (re-rolls, nearby starts) stringifies the store once, not per insert.
        await new Promise(r => setTimeout(r, CACHE_SAVE_DEBOUNCE_MS));
        while (generation !== savedGeneration) await saveCache();
        saving = null;
    })().catch(e => {
        log('ERROR', { event: 'cache_save_failed', err: (e as Error).message });
        saving = null;
    });
}

// Read a live entry, evicting it (and scheduling a snapshot rewrite) once its TTL
// has passed so the caller falls through to a refetch. A hot key with no further
// inserts would otherwise be served stale forever — prune() only runs on
// insert/load, so this per-read check is what actually enforces freshness.
function readFresh(key: string): Entry | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
        deleteEntry(key);
        bumpAndSave();
        return undefined;
    }
    return entry;
}

// Bound the store: drop everything past the TTL, then evict oldest-cachedAt-first
// until at or under BOTH the entry cap and the point budget. Runs after every
// insert (overflow ≤ 1) and once after a bulk load (may drop many). Returns the
// count removed, for load logging. Never evicts the newest entry — a single
// fetch larger than CACHE_MAX_POINTS would otherwise be stored then immediately
// dropped, and the next request would miss-loop.
function prune(now: number): number {
    let removed = 0;
    for (const [k, v] of store) {
        if (now - v.cachedAt > CACHE_TTL_MS) { deleteEntry(k); removed++; }
    }
    if (store.size <= CACHE_MAX_ENTRIES && totalPoints <= CACHE_MAX_POINTS) return removed;
    const byAge = [...store.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    for (let i = 0; i < byAge.length - 1; i++) {
        if (store.size <= CACHE_MAX_ENTRIES && totalPoints <= CACHE_MAX_POINTS) break;
        const oldest = byAge[i];
        if (!oldest) continue;
        deleteEntry(oldest[0]);
        removed++;
    }
    return removed;
}

export type LookupResult =
    | { cache: 'hit'; junctions: LatLng[] }
    | { cache: 'miss' | 'coalesced'; junctions: LatLng[]; overpassMs: number };

export type AnchoredLookupResult = LookupResult & { total: number };

// Shared hit / inflight-join / Overpass-miss protocol. Key derivation and the
// result projection (identity vs filterToBbox) stay in the wrappers so a TTL,
// inflight, or persist fix cannot fork between bbox and anchored modes.
async function lookupOrFetch(key: string, fetchFn: () => Promise<LatLng[]>): Promise<LookupResult> {
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

export function cacheSize(): number {
    return store.size;
}
