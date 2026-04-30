// In-memory junction cache + persistent JSON snapshot. Inflight dedup via
// a parallel Map<key, Promise> so concurrent identical requests share work.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Bbox, ExcludePreset, LatLng } from './overpass.js';
import { fetchJunctionsFromOverpass } from './overpass.js';
import { log } from './log.js';

const CACHE_PATH = process.env.CACHE_PATH ?? './data/cache.json';
const QUANTIZE_DECIMALS = 4;  // ~11m at the equator

type Entry = { junctions: LatLng[]; cachedAt: number };

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<LatLng[]>>();
let dirty = false;
let saving: Promise<void> | null = null;

function q(n: number): string {
    return n.toFixed(QUANTIZE_DECIMALS);
}

function keyFor(bbox: Bbox, exclude: ExcludePreset): string {
    return `${q(bbox.minLat)},${q(bbox.minLng)},${q(bbox.maxLat)},${q(bbox.maxLng)}|${exclude}`;
}

export async function loadCache(): Promise<void> {
    try {
        const raw = await readFile(CACHE_PATH, 'utf8');
        const obj = JSON.parse(raw) as Record<string, Entry>;
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
        log('INFO', { event: 'cache_loaded', entries: store.size, path: CACHE_PATH });
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
            log('INFO', { event: 'cache_empty', path: CACHE_PATH });
        } else {
            log('WARN', { event: 'cache_load_failed', err: err.message });
        }
    }
}

async function saveCache(): Promise<void> {
    dirty = false;
    const obj: Record<string, Entry> = {};
    for (const [k, v] of store) obj[k] = v;
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    await writeFile(tmp, JSON.stringify(obj));
    await rename(tmp, CACHE_PATH);
}

function scheduleSave(): void {
    dirty = true;
    if (saving) return;
    saving = (async () => {
        // small debounce so bursts coalesce into one write
        await new Promise(r => setTimeout(r, 200));
        while (dirty) await saveCache();
        saving = null;
    })().catch(e => {
        log('ERROR', { event: 'cache_save_failed', err: (e as Error).message });
        saving = null;
    });
}

export type LookupResult =
    | { cache: 'hit'; junctions: LatLng[] }
    | { cache: 'miss'; junctions: LatLng[]; overpassMs: number };

export async function getJunctions(bbox: Bbox, exclude: ExcludePreset): Promise<LookupResult> {
    const key = keyFor(bbox, exclude);
    const cached = store.get(key);
    if (cached) return { cache: 'hit', junctions: cached.junctions };

    const existing = inflight.get(key);
    if (existing) {
        const junctions = await existing;
        return { cache: 'hit', junctions };
    }

    const t0 = Date.now();
    const promise = fetchJunctionsFromOverpass(bbox, exclude);
    inflight.set(key, promise);
    try {
        const junctions = await promise;
        const overpassMs = Date.now() - t0;
        store.set(key, { junctions, cachedAt: Date.now() });
        scheduleSave();
        return { cache: 'miss', junctions, overpassMs };
    } finally {
        inflight.delete(key);
    }
}

export function cacheSize(): number {
    return store.size;
}
