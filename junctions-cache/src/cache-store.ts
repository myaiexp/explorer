// The cached-point store and its JSON snapshot — the Map, point accounting,
// TTL, eviction, and load/save. Knows nothing about Overpass, keys or lookup
// protocol; cache.ts layers those on top.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from './log.js';

const CACHE_PATH = process.env.CACHE_PATH ?? './data/cache.json';

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
// An empty answer is cached like any other — a genuinely bare area shouldn't
// re-hit Overpass on every request — but it is also what a mid-diff-update or
// half-loaded instance returns, and at 30 days one transient empty pins
// "nothing near you" on that start for a month. 15 minutes is long enough to
// absorb a re-roll burst and short enough that the next diff cycle (hourly)
// clears it. Derived from the entry's own length rather than stored as a flag,
// so it applies retroactively to empties already in the on-disk snapshot.
const CACHE_EMPTY_TTL_MS = envPositiveInt('CACHE_EMPTY_TTL_MS', 15 * 60 * 1000);
const CACHE_MAX_ENTRIES = envPositiveInt('CACHE_MAX_ENTRIES', 500);
const CACHE_MAX_POINTS = envPositiveInt('CACHE_MAX_POINTS', 1_000_000);
const CACHE_SAVE_DEBOUNCE_MS = envPositiveInt('CACHE_SAVE_DEBOUNCE_MS', 2000);

// A cached point. `name` is present only for POI entries; junctions and road
// centroids carry coordinates alone.
export type CachedPoint = { lat: number; lng: number; name?: string };

// The persisted field stays named `junctions` even though it now holds POI and
// road points too. Renaming it would make isValidEntry drop every row in the
// on-disk snapshot on the next load.
export type Entry = { junctions: CachedPoint[]; cachedAt: number };

const store = new Map<string, Entry>();
let totalPoints = 0;
let generation = 0;
let savedGeneration = 0;
let saving: Promise<void> | null = null;

// How long this entry stays fresh. Empty sets get the short TTL; see
// CACHE_EMPTY_TTL_MS. The only freshness rule in the module — readFresh and
// prune both go through it, so the two enforcement points cannot diverge.
function ttlFor(entry: Entry): number {
    return entry.junctions.length === 0 ? CACHE_EMPTY_TTL_MS : CACHE_TTL_MS;
}

function isExpired(entry: Entry, now: number): boolean {
    return now - entry.cachedAt > ttlFor(entry);
}

export function setEntry(key: string, entry: Entry): void {
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

export function bumpAndSave(): void {
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
export function readFresh(key: string): Entry | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (isExpired(entry, Date.now())) {
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
export function prune(now: number): number {
    let removed = 0;
    for (const [k, v] of store) {
        if (isExpired(v, now)) { deleteEntry(k); removed++; }
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

export function cacheSize(): number {
    return store.size;
}
