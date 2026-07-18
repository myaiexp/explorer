// @vitest-environment node
// Tests for junctions-cache/src/cache.ts — in-memory cache, persistence, dedup.
// Node env (not the repo-root jsdom default): these tests use node:fs + os.tmpdir,
// which jsdom stubs out under vite7 (TypeError: tmpdir is not a function).
// Audit finding #1564: the inflight-dedup correctness property and the helpers
// (wideBboxFromStart pole/cos handling, loadCache ENOENT/corrupt, saveCache
// atomic write-rename, scheduleSave debounce + re-save loop, filterToBbox) had
// zero coverage.
//
// Unlike #1562 (fit-encoder hid internals behind a browser IIFE, forcing
// load-time string injection), every behaviour the finding names is reachable
// through cache.ts's exported surface — so the SUT is imported normally and is
// never modified on disk (git diff stays empty):
//   - inflight dedup → two concurrent getJunctions / getJunctionsAnchored calls.
//   - filterToBbox   → getJunctionsAnchored returns filterToBbox(all, requested).
//   - keyFor / startKeyFor quantization → cache-hit behaviour of near-identical
//     bboxes / starts.
//   - saveCache + scheduleSave → driven through a getJunctions miss.
//
// cache.ts holds module-level singleton state (store/inflight/dirty/saving) and
// reads CACHE_PATH once at import, so each test gets a fresh module via
// loadFresh() (vi.resetModules + a per-test temp CACHE_PATH).

import { describe, test, expect, vi, afterEach, type Mock } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wideBboxFromStart } from '../src/cache.js';
import type { Bbox } from '../src/overpass.js';

// Mock the Overpass boundary so dedup/persistence tests are deterministic and
// never hit the network. Mock log to keep test output clean and to assert the
// load/save log events. (Both are user modules, so the mock applies transitively
// to cache.ts — vitest does NOT extend that to a source module's node:fs/promises
// import, so the persistence tests use a real temp file and observe real fs.)
vi.mock('../src/overpass.js', () => ({ fetchJunctionsFromOverpass: vi.fn() }));
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const BBOX: Bbox = { minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 };

const tmpDirs: string[] = [];
function mkTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jcache-'));
    tmpDirs.push(dir);
    return dir;
}
function tmpCacheFile(): string {
    return join(mkTmpDir(), 'cache.json');
}

// Fresh module instance + isolated state, with CACHE_PATH pointed at `cachePath`.
// cache.ts holds singleton state and reads CACHE_PATH once at import, so each
// caller gets a clean store/inflight/dirty/saving via vi.resetModules().
async function loadFresh(cachePath: string) {
    vi.resetModules();
    process.env.CACHE_PATH = cachePath;
    const overpass = await import('../src/overpass.js');
    const logMod = await import('../src/log.js');
    const cache = await import('../src/cache.js');
    return {
        cache,
        fetchMock: overpass.fetchJunctionsFromOverpass as unknown as Mock,
        log: logMod.log as unknown as Mock,
    };
}

// Real-timer poll (the save tests run on real timers so the 200ms debounce and
// the real fs write actually happen).
function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let ok = false;
            try { ok = pred(); } catch { ok = false; }
            if (ok) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();   // un-patch any vi.spyOn (e.g. the JSON.stringify save counter)
    vi.clearAllMocks();
    // The TTL / cap tests set these before loadFresh; clear them so they don't
    // leak into other tests (the module reads them once at import).
    delete process.env.CACHE_TTL_MS;
    delete process.env.CACHE_MAX_ENTRIES;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── wideBboxFromStart — km→degree conversion, cos(lat), pole/lng clamping ─────

describe('wideBboxFromStart', () => {
    test('mid-latitude (60°): lng padding is 1/cos(60°)=2× the lat padding', () => {
        const b = wideBboxFromStart({ startLat: 60, startLng: 24, maxKm: 10 });
        // latPad = 10/111 ; lngPad = 10/(111·cos60°) = 10/(111·0.5)
        expect(b.minLat).toBeCloseTo(60 - 10 / 111, 6);
        expect(b.maxLat).toBeCloseTo(60 + 10 / 111, 6);
        expect(b.minLng).toBeCloseTo(24 - 10 / 55.5, 6);
        expect(b.maxLng).toBeCloseTo(24 + 10 / 55.5, 6);
        const latPad = b.maxLat - 60;
        const lngPad = b.maxLng - 24;
        expect(lngPad / latPad).toBeCloseTo(2, 6); // 1/cos(60°)
    });

    test('high latitude (70°N): lng padding inflated by 1/cos(70°)', () => {
        const b = wideBboxFromStart({ startLat: 70, startLng: 25, maxKm: 5 });
        // Independently computed: cos(70°)=0.34202014, lngPad=5/(111·0.34202014).
        expect(b.minLat).toBeCloseTo(69.95495495, 6);
        expect(b.maxLat).toBeCloseTo(70.04504505, 6);
        expect(b.minLng).toBeCloseTo(24.8682970991, 6);
        expect(b.maxLng).toBeCloseTo(25.1317029009, 6);
        const latPad = b.maxLat - 70;
        const lngPad = b.maxLng - 25;
        expect(lngPad / latPad).toBeCloseTo(1 / Math.cos(70 * Math.PI / 180), 6);
    });

    test('near the north pole: lat clamps to 90, lng clamps to 180, cos floored at 0.05', () => {
        const b = wideBboxFromStart({ startLat: 89.99, startLng: 179.5, maxKm: 200 });
        expect(b.maxLat).toBe(90);          // 89.99 + 200/111 = 91.79 → clamped
        expect(b.maxLng).toBe(180);         // 179.5 + 200/5.55 = 215.5 → clamped
        expect(b.minLat).toBeCloseTo(89.99 - 200 / 111, 6);
        // cos(89.99°)≈0.000175; without the 0.05 floor lngPad would blow up and
        // minLng would clamp to -180. The 0.05 floor keeps it at 179.5-200/5.55.
        expect(b.minLng).toBeCloseTo(179.5 - 200 / 5.55, 5);
    });

    test('near the south pole: lat clamps to -90, lng clamps to -180', () => {
        const b = wideBboxFromStart({ startLat: -89.99, startLng: -179.5, maxKm: 200 });
        expect(b.minLat).toBe(-90);
        expect(b.minLng).toBe(-180);
        expect(b.maxLat).toBeCloseTo(-89.99 + 200 / 111, 6);
        expect(b.maxLng).toBeCloseTo(-179.5 + 200 / 5.55, 5);
    });

    test('maxKm is rounded up (ceil) before conversion', () => {
        const b = wideBboxFromStart({ startLat: 0, startLng: 0, maxKm: 4.2 });
        // ceil(4.2)=5 → pad 5/111, not 4.2/111. cos(0)=1 so lat/lng pads match.
        expect(b.maxLat).toBeCloseTo(5 / 111, 6);
        expect(b.maxLng).toBeCloseTo(5 / 111, 6);
    });

    // Regression guard for the `Math.max(0.05, cos(lat))` floor (audit #3160).
    // The 89.99° tests above pin exact clamp values; these pin the *property* the
    // floor exists for. Mutation-killing: at 89.95° with startLng 0 (away from the
    // ±180 clamp) the floor caps lngPad at 10/(111·0.05) ≈ 1.8°, whereas dropping
    // the floor would let cos(89.95°)≈0.000873 inflate it to ≈103° — a near-global
    // strip. Asserting the bound therefore fails if the floor is removed (the
    // ±180 clamp can't mask it here, unlike at startLng 179.9).
    test('cos floor BOUNDS lng padding at high latitude instead of letting it explode (audit #3160)', () => {
        const flooredLngPad = 10 / (111 * 0.05);   // ≈ 1.8018° — the cap the floor enforces
        for (const startLat of [89.95, -89.95]) {
            const b = wideBboxFromStart({ startLat, startLng: 0, maxKm: 10 });
            for (const v of [b.minLat, b.minLng, b.maxLat, b.maxLng]) {
                expect(Number.isFinite(v)).toBe(true);
            }
            // Without the floor these would be ≈ ±103°, not ≈ ±1.8°.
            expect(Math.abs(b.maxLng)).toBeLessThanOrEqual(flooredLngPad + 1e-9);
            expect(Math.abs(b.minLng)).toBeLessThanOrEqual(flooredLngPad + 1e-9);
            expect(b.minLat).toBeGreaterThanOrEqual(-90);
            expect(b.maxLat).toBeLessThanOrEqual(90);
        }
    });

    test('exact pole (±90°) yields a finite, in-range bbox — no Infinity from cos→0 (audit #3160)', () => {
        // cos(±90°·π/180) ≈ 6e-17 in IEEE754 (never exactly 0), so even unfloored
        // this stays finite — but pin the invariant: every corner is finite and
        // sits inside the valid lat/lng envelope after clamping.
        for (const startLat of [90, -90]) {
            const b = wideBboxFromStart({ startLat, startLng: 179.9, maxKm: 300 });
            for (const v of [b.minLat, b.minLng, b.maxLat, b.maxLng]) {
                expect(Number.isFinite(v)).toBe(true);
            }
            expect(b.minLat).toBeGreaterThanOrEqual(-90);
            expect(b.maxLat).toBeLessThanOrEqual(90);
            expect(b.minLng).toBeGreaterThanOrEqual(-180);
            expect(b.maxLng).toBeLessThanOrEqual(180);
        }
    });
});

// ── getJunctions — inflight dedup + key quantization ─────────────────────────

describe('getJunctions', () => {
    test('two concurrent identical requests share one Overpass call (inflight dedup)', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        let resolveFetch: (v: { lat: number; lng: number }[]) => void = () => {};
        fetchMock.mockReturnValue(new Promise(r => { resolveFetch = r; }));

        const p1 = cache.getJunctions(BBOX, 'default');
        const p2 = cache.getJunctions(BBOX, 'default');
        // The second call sees the first's inflight promise — fetch fired once.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        resolveFetch([{ lat: 60.5, lng: 24.5 }]);
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r1).toEqual({ cache: 'miss', junctions: [{ lat: 60.5, lng: 24.5 }], overpassMs: expect.any(Number) });
        expect(r2).toEqual({ cache: 'hit', junctions: [{ lat: 60.5, lng: 24.5 }] });
    });

    test('a rejecting Overpass fetch rejects every concurrent waiter with the same error, then clears inflight (audit #3157)', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        const boom = new Error('overpass 504');
        let rejectFetch: (e: Error) => void = () => {};
        fetchMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFetch = reject; }));

        const p1 = cache.getJunctions(BBOX, 'default');
        const p2 = cache.getJunctions(BBOX, 'default');
        // p2 shares p1's inflight promise — only one fetch is in flight.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Attach handlers before rejecting so both rejections are observed
        // (no unhandled-rejection noise) and we can assert the propagated value.
        const e1 = p1.catch(e => e);
        const e2 = p2.catch(e => e);
        rejectFetch(boom);

        // Both waiters reject with the identical error instance — the second
        // caller is not insulated from the shared promise's failure.
        expect(await e1).toBe(boom);
        expect(await e2).toBe(boom);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The `finally` cleared the inflight entry (and nothing was stored), so a
        // fresh call re-fetches rather than re-awaiting the dead rejected promise.
        fetchMock.mockResolvedValueOnce([{ lat: 60.5, lng: 24.5 }]);
        const retry = await cache.getJunctions(BBOX, 'default');
        expect(retry).toEqual({ cache: 'miss', junctions: [{ lat: 60.5, lng: 24.5 }], overpassMs: expect.any(Number) });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('a stored result is served from cache without re-fetching', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue([{ lat: 60.5, lng: 24.5 }]);

        const first = await cache.getJunctions(BBOX, 'default');
        const second = await cache.getJunctions(BBOX, 'default');

        expect(first.cache).toBe('miss');
        expect(second).toEqual({ cache: 'hit', junctions: [{ lat: 60.5, lng: 24.5 }] });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('bboxes differing below the 4-decimal quantum map to the same cache key', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue([{ lat: 60.5, lng: 24.5 }]);

        await cache.getJunctions(BBOX, 'default');                              // miss
        const near = await cache.getJunctions({ ...BBOX, minLat: 60.00001 }, 'default'); // q→60.0000

        expect(near.cache).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('the exclude preset is part of the key — winter does not reuse default', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue([{ lat: 60.5, lng: 24.5 }]);

        await cache.getJunctions(BBOX, 'default');
        const winter = await cache.getJunctions(BBOX, 'winter');

        expect(winter.cache).toBe('miss');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// ── getJunctionsAnchored — wide fetch, filterToBbox, start-key dedup/quantize ─

describe('getJunctionsAnchored', () => {
    const WIDE_SET = [
        { lat: 60.0, lng: 24.0 }, // inside `requested`
        { lat: 60.5, lng: 24.5 }, // inside `requested`
        { lat: 62.0, lng: 24.0 }, // lat above requested.maxLat → filtered out
        { lat: 60.0, lng: 28.0 }, // lng above requested.maxLng → filtered out
    ];
    const start = { startLat: 60.2, startLng: 24.5, maxKm: 50 };
    const requested: Bbox = { minLat: 59.5, minLng: 23.5, maxLat: 61.0, maxLng: 25.5 };

    test('miss fetches the wide bbox, stores all, returns only the requested window', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue(WIDE_SET);

        const r = await cache.getJunctionsAnchored(start, 'default', requested);

        expect(r.cache).toBe('miss');
        expect(r.total).toBe(4);                                   // full stored set
        expect(r.junctions).toEqual([{ lat: 60.0, lng: 24.0 }, { lat: 60.5, lng: 24.5 }]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The fetch is issued against wideBboxFromStart(start), not `requested`.
        expect(fetchMock).toHaveBeenCalledWith(wideBboxFromStart(start), 'default');
    });

    test('a near-identical start hits the cache and re-filters to a narrower window', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue(WIDE_SET);

        await cache.getJunctionsAnchored(start, 'default', requested);
        // 60.2004→"60.200", 24.4996→"24.500", ceil(49.7)=50 → same start key.
        const start2 = { startLat: 60.2004, startLng: 24.4996, maxKm: 49.7 };
        const narrow: Bbox = { minLat: 60.4, minLng: 24.4, maxLat: 60.6, maxLng: 24.6 };
        const r = await cache.getJunctionsAnchored(start2, 'default', narrow);

        expect(r.cache).toBe('hit');
        expect(fetchMock).toHaveBeenCalledTimes(1);                // no second fetch
        expect(r.total).toBe(4);
        expect(r.junctions).toEqual([{ lat: 60.5, lng: 24.5 }]);   // only this one in `narrow`
    });

    test('two concurrent anchored requests for the same start share one fetch', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        let resolveFetch: (v: { lat: number; lng: number }[]) => void = () => {};
        fetchMock.mockReturnValue(new Promise(r => { resolveFetch = r; }));

        const p1 = cache.getJunctionsAnchored(start, 'default', requested);
        const p2 = cache.getJunctionsAnchored(start, 'default', requested);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        resolveFetch(WIDE_SET);
        const [r1, r2] = await Promise.all([p1, p2]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(r1.cache).toBe('miss');
        expect(r2.cache).toBe('hit');
        expect(r2.junctions).toEqual([{ lat: 60.0, lng: 24.0 }, { lat: 60.5, lng: 24.5 }]);
        expect(r2.total).toBe(4);
    });
});

// ── filterToBbox — boundary inclusivity (audit #3175) ────────────────────────
//
// filterToBbox keeps a point when:
//   j.lat >= minLat && j.lat <= maxLat && j.lng >= minLng && j.lng <= maxLng
// i.e. all FOUR edges are inclusive (>= on the mins, <= on the maxes), applied
// uniformly — no edge uses a strict comparison. The existing getJunctionsAnchored
// tests above only cover strictly-interior / strictly-exterior points, leaving the
// edge behaviour unpinned. These tests close that gap via getJunctionsAnchored
// (which returns filterToBbox(all, requested)): a point lying exactly on each edge,
// and on a corner, is KEPT; a point one small step outside any edge is DROPPED, so
// the boundary sits precisely on the edge rather than inside a tolerance band.
// (Confirmed against the source: inclusivity is consistent across all four edges —
// there is no off-by-one to encode here.)

describe('filterToBbox boundary inclusivity', () => {
    // `start` is irrelevant to the filtering: the fetch is mocked to return our
    // exact set regardless of the wide bbox, so only `requested` drives filterToBbox.
    const start = { startLat: 60.5, startLng: 24.5, maxKm: 50 };
    const requested: Bbox = { minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 };

    test('points exactly on each edge (min/max lat, min/max lng) and on the corners are KEPT — every edge is inclusive', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        const onBoundary = [
            { lat: 60, lng: 24.5 },   // exactly on the min-lat edge
            { lat: 61, lng: 24.5 },   // exactly on the max-lat edge
            { lat: 60.5, lng: 24 },   // exactly on the min-lng edge
            { lat: 60.5, lng: 25 },   // exactly on the max-lng edge
            { lat: 60, lng: 24 },     // min-lat / min-lng corner
            { lat: 61, lng: 25 },     // max-lat / max-lng corner
        ];
        fetchMock.mockResolvedValue(onBoundary);

        const r = await cache.getJunctionsAnchored(start, 'default', requested);

        // >= / <= on every edge → no on-edge point is filtered out.
        expect(r.junctions).toEqual(onBoundary);
        expect(r.total).toBe(6);
    });

    test('points one small step OUTSIDE each edge are DROPPED — the boundary is exactly on the edge, not a tolerance band', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        const justOutside = [
            { lat: 59.9999, lng: 24.5 },  // just below min-lat → fails j.lat >= minLat
            { lat: 61.0001, lng: 24.5 },  // just above max-lat → fails j.lat <= maxLat
            { lat: 60.5, lng: 23.9999 },  // just left of min-lng → fails j.lng >= minLng
            { lat: 60.5, lng: 25.0001 },  // just right of max-lng → fails j.lng <= maxLng
        ];
        fetchMock.mockResolvedValue(justOutside);

        const r = await cache.getJunctionsAnchored(start, 'default', requested);

        // Each point fails exactly one comparison → all four are excluded.
        expect(r.junctions).toEqual([]);
        expect(r.total).toBe(4);   // the full set is still stored; only the window is empty
    });

    test('on-edge points survive alongside out-of-window points, preserving input order', async () => {
        vi.useFakeTimers();
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        const mixed = [
            { lat: 60, lng: 24 },       // min corner → kept
            { lat: 62, lng: 24 },       // lat above max → dropped
            { lat: 61, lng: 25 },       // max corner → kept
            { lat: 60.5, lng: 26 },     // lng above max → dropped
        ];
        fetchMock.mockResolvedValue(mixed);

        const r = await cache.getJunctionsAnchored(start, 'default', requested);

        expect(r.junctions).toEqual([{ lat: 60, lng: 24 }, { lat: 61, lng: 25 }]);
        expect(r.total).toBe(4);
    });
});

// ── loadCache — ENOENT / corrupt JSON / valid roundtrip ──────────────────────

describe('loadCache', () => {
    test('a missing cache file leaves the store empty and logs cache_empty (no throw)', async () => {
        const { cache, log } = await loadFresh(join(mkTmpDir(), 'does-not-exist.json'));
        await cache.loadCache();
        expect(cache.cacheSize()).toBe(0);
        expect(log).toHaveBeenCalledWith('INFO', expect.objectContaining({ event: 'cache_empty' }));
    });

    test('a corrupt cache file is tolerated: store stays empty, WARN logged (no throw)', async () => {
        const file = tmpCacheFile();
        writeFileSync(file, '{ this is not valid json');
        const { cache, log } = await loadFresh(file);
        await cache.loadCache();
        expect(cache.cacheSize()).toBe(0);
        expect(log).toHaveBeenCalledWith('WARN', expect.objectContaining({ event: 'cache_load_failed' }));
    });

    test('a valid snapshot is loaded into the store and served as a hit', async () => {
        const file = tmpCacheFile();
        const key = '60.0000,24.0000,61.0000,25.0000|default'; // keyFor(BBOX,'default')
        // cachedAt must be recent: loadCache now applies the TTL, so a 1970-era
        // placeholder would be pruned as stale before the assertions run.
        writeFileSync(file, JSON.stringify({ [key]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: Date.now() } }));
        const { cache, fetchMock, log } = await loadFresh(file);

        await cache.loadCache();
        expect(cache.cacheSize()).toBe(1);
        expect(log).toHaveBeenCalledWith('INFO', expect.objectContaining({ event: 'cache_loaded', entries: 1 }));

        const r = await cache.getJunctions(BBOX, 'default');
        expect(r).toEqual({ cache: 'hit', junctions: [{ lat: 60.5, lng: 24.5 }] });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Audit #3173: corrupt individual rows were stored as-is (a later
    // getJunctions/filterToBbox would crash on them) with no signal. They must
    // be dropped on load AND surfaced via a WARN naming the count.
    test('corrupt individual entries are dropped, not stored, and a WARN names the count', async () => {
        const file = tmpCacheFile();
        const goodKey = '60.0000,24.0000,61.0000,25.0000|default';
        writeFileSync(file, JSON.stringify({
            [goodKey]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: Date.now() }, // recent → survives the load TTL
            'bad:junctions-not-array': { junctions: 'nope', cachedAt: 1 },
            'bad:missing-cachedAt': { junctions: [] },
            'bad:cachedAt-not-number': { junctions: [], cachedAt: 'soon' },
            'bad:null-entry': null,
        }));
        const { cache, log } = await loadFresh(file);

        await cache.loadCache();

        // Only the well-formed row survives — the four malformed ones are gone.
        expect(cache.cacheSize()).toBe(1);
        // The loss is surfaced, not silently swallowed.
        expect(log).toHaveBeenCalledWith('WARN', expect.objectContaining({
            event: 'cache_entries_dropped', dropped: 4, kept: 1,
        }));
        // The happy-path summary still fires with the survivor count.
        expect(log).toHaveBeenCalledWith('INFO', expect.objectContaining({ event: 'cache_loaded', entries: 1 }));
    });

    // Guards the byte-for-byte happy path: a clean snapshot must not emit a
    // spurious cache_entries_dropped WARN.
    test('a fully valid snapshot drops nothing and logs no cache_entries_dropped WARN', async () => {
        const file = tmpCacheFile();
        const key = '60.0000,24.0000,61.0000,25.0000|default';
        // cachedAt must be recent: loadCache now applies the TTL, so a 1970-era
        // placeholder would be pruned as stale before the assertions run.
        writeFileSync(file, JSON.stringify({ [key]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: Date.now() } }));
        const { cache, log } = await loadFresh(file);

        await cache.loadCache();

        expect(cache.cacheSize()).toBe(1);
        expect(log).not.toHaveBeenCalledWith('WARN', expect.objectContaining({ event: 'cache_entries_dropped' }));
    });
});

// ── saveCache — atomic tmp-write + rename, persisted across a reload ──────────
//
// vitest can't intercept cache.ts's node:fs/promises import (a source module's
// builtin import bypasses both vi.mock and vi.spyOn — the ESM namespace is
// non-configurable), so these tests run on real timers against a real temp file
// and assert the observable filesystem + log effects rather than spying on fs.

describe('saveCache (driven via a getJunctions miss)', () => {
    test('debounced atomic write persists and roundtrips through a fresh loadCache', async () => {
        vi.useRealTimers(); // exercise the real 200ms debounce + real fs write
        const file = tmpCacheFile();
        const { cache, fetchMock, log } = await loadFresh(file);
        fetchMock.mockResolvedValue([{ lat: 60.5, lng: 24.5 }]);

        await cache.getJunctions(BBOX, 'default');     // miss → schedules the debounced save
        expect(existsSync(file)).toBe(false);          // not written synchronously — debounce pending

        await waitFor(() => existsSync(file));         // the debounced rename lands the file

        // Atomic write: a "<path>.tmp" is written then renamed onto <path>, so no
        // tmp is left behind and the save never errors (a direct write to <path>
        // or a swapped rename would throw ENOENT → cache_save_failed).
        expect(existsSync(file + '.tmp')).toBe(false);
        expect(log).not.toHaveBeenCalledWith('ERROR', expect.objectContaining({ event: 'cache_save_failed' }));

        // The on-disk JSON is exactly the stored entry.
        const onDisk = JSON.parse(readFileSync(file, 'utf8'));
        expect(onDisk['60.0000,24.0000,61.0000,25.0000|default'].junctions).toEqual([{ lat: 60.5, lng: 24.5 }]);

        // Roundtrip: a brand-new module reading the same file serves a hit.
        const fresh = await loadFresh(file);
        await fresh.cache.loadCache();
        expect(fresh.cache.cacheSize()).toBe(1);
        const r = await fresh.cache.getJunctions(BBOX, 'default'); // 'hit' ⇒ served from the loaded file, not re-fetched
        expect(r).toEqual({ cache: 'hit', junctions: [{ lat: 60.5, lng: 24.5 }] });
    });
});

// ── TTL + max-entry cap — bounded store, no stale serving (audit) ─────────────
//
// Before this fix nothing ever deleted an entry: cachedAt was recorded but never
// read (stale OSM roads served forever) and distinct keys minted permanent
// entries without limit. These pin the three enforcement points — TTL on read,
// oldest-first eviction at the cap on insert, and pruning the loaded snapshot.

describe('TTL on read', () => {
    test('an entry past the TTL is treated as a miss and refetched, not served stale', async () => {
        vi.useFakeTimers();
        process.env.CACHE_TTL_MS = String(60_000);   // 60s TTL for the test
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValueOnce([{ lat: 60.5, lng: 24.5 }]);
        fetchMock.mockResolvedValueOnce([{ lat: 61.5, lng: 25.5 }]);

        expect((await cache.getJunctions(BBOX, 'default')).cache).toBe('miss');   // stored at t0
        expect((await cache.getJunctions(BBOX, 'default')).cache).toBe('hit');    // still within TTL

        vi.setSystemTime(Date.now() + 61_000);        // advance the clock past the TTL
        const afterTtl = await cache.getJunctions(BBOX, 'default');
        expect(afterTtl.cache).toBe('miss');          // expired → refetched, not served stale
        expect(afterTtl.junctions).toEqual([{ lat: 61.5, lng: 25.5 }]);  // the fresh fetch, not the old data
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('an expired entry is served fresh after the refetch, replacing the stale data', async () => {
        vi.useFakeTimers();
        process.env.CACHE_TTL_MS = String(60_000);
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValueOnce([{ lat: 1, lng: 1 }]);
        fetchMock.mockResolvedValueOnce([{ lat: 2, lng: 2 }]);

        await cache.getJunctions(BBOX, 'default');    // miss → {1,1}
        vi.setSystemTime(Date.now() + 61_000);
        await cache.getJunctions(BBOX, 'default');    // expired → refetch → {2,2}
        const next = await cache.getJunctions(BBOX, 'default');
        expect(next).toEqual({ cache: 'hit', junctions: [{ lat: 2, lng: 2 }] }); // fresh value now cached
    });
});

describe('max-entry cap (oldest-first eviction)', () => {
    test('inserting past the cap evicts the oldest entry by cachedAt, keeping newer ones', async () => {
        vi.useFakeTimers();
        process.env.CACHE_MAX_ENTRIES = '2';
        const { cache, fetchMock } = await loadFresh(tmpCacheFile());
        fetchMock.mockResolvedValue([{ lat: 1, lng: 1 }]);

        const A = { minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 };
        const B = { minLat: 62, minLng: 26, maxLat: 63, maxLng: 27 };
        const C = { minLat: 64, minLng: 28, maxLat: 65, maxLng: 29 };

        await cache.getJunctions(A, 'default');       // oldest
        vi.setSystemTime(Date.now() + 1000);
        await cache.getJunctions(B, 'default');
        vi.setSystemTime(Date.now() + 1000);
        await cache.getJunctions(C, 'default');        // 3rd insert → cap 2 → evicts A

        expect(cache.cacheSize()).toBe(2);
        // A was evicted → re-requesting it re-fetches; B and C are still hits.
        expect((await cache.getJunctions(B, 'default')).cache).toBe('hit');
        expect((await cache.getJunctions(C, 'default')).cache).toBe('hit');
        const a = await cache.getJunctions(A, 'default');
        expect(a.cache).toBe('miss');
    });
});

describe('loadCache pruning (TTL + cap on the snapshot)', () => {
    test('drops entries past the TTL on load, keeps fresh ones, and shrinks the file', async () => {
        vi.useRealTimers();
        const file = tmpCacheFile();
        const freshKey = '60.0000,24.0000,61.0000,25.0000|default';
        const staleKey = '10.0000,10.0000,11.0000,11.0000|default';
        const now = Date.now();
        writeFileSync(file, JSON.stringify({
            [freshKey]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: now },
            [staleKey]: { junctions: [{ lat: 10.5, lng: 10.5 }], cachedAt: now - 40 * 24 * 60 * 60 * 1000 }, // 40d old
        }));
        const { cache, log } = await loadFresh(file);

        await cache.loadCache();

        expect(cache.cacheSize()).toBe(1);            // stale one pruned in memory
        expect(log).toHaveBeenCalledWith('INFO', expect.objectContaining({ event: 'cache_pruned_on_load', pruned: 1 }));
        // The debounced save shrinks the on-disk snapshot to just the fresh key.
        await waitFor(() => Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length === 1);
        expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual([freshKey]);
    });

    test('enforces the entry cap on load, keeping the newest by cachedAt', async () => {
        vi.useRealTimers();
        process.env.CACHE_MAX_ENTRIES = '1';
        const file = tmpCacheFile();
        const now = Date.now();
        const oldKey = '10.0000,10.0000,11.0000,11.0000|default';
        const newKey = '60.0000,24.0000,61.0000,25.0000|default';
        writeFileSync(file, JSON.stringify({
            [oldKey]: { junctions: [{ lat: 10.5, lng: 10.5 }], cachedAt: now - 1000 },
            [newKey]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: now },
        }));
        const { cache } = await loadFresh(file);

        await cache.loadCache();

        expect(cache.cacheSize()).toBe(1);
        // The newer entry survived the cap; the older one was evicted.
        const r = await cache.getJunctions(BBOX, 'default');
        expect(r).toEqual({ cache: 'hit', junctions: [{ lat: 60.5, lng: 24.5 }] });
        // Drain the prune-on-load save (real timer) so its debounced write can't
        // leak past this test into a later one's JSON.stringify save counter.
        await waitFor(() => Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length === 1);
    });

    test('a snapshot fully within the TTL and cap is not pruned (no cache_pruned_on_load)', async () => {
        vi.useRealTimers();
        const file = tmpCacheFile();
        const key = '60.0000,24.0000,61.0000,25.0000|default';
        writeFileSync(file, JSON.stringify({ [key]: { junctions: [{ lat: 60.5, lng: 24.5 }], cachedAt: Date.now() } }));
        const { cache, log } = await loadFresh(file);

        await cache.loadCache();

        expect(cache.cacheSize()).toBe(1);
        expect(log).not.toHaveBeenCalledWith('INFO', expect.objectContaining({ event: 'cache_pruned_on_load' }));
    });
});

// ── scheduleSave — debounce + coalescing ─────────────────────────────────────

describe('scheduleSave', () => {
    test('a burst of misses is debounced and coalesced into a single snapshot write', async () => {
        vi.useRealTimers();
        const file = tmpCacheFile();
        const { cache, fetchMock } = await loadFresh(file);
        fetchMock.mockResolvedValue([{ lat: 60.5, lng: 24.5 }]);

        // Save counter: cache.ts calls JSON.stringify only inside saveCache, on an
        // object whose keys are cache keys (they contain '|'). fs itself can't be
        // spied from here, so the stringify count is the observable save count.
        const jsonSpy = vi.spyOn(JSON, 'stringify');
        const saves = () => jsonSpy.mock.calls.filter((c) => {
            const o = c[0] as unknown;
            return !!o && typeof o === 'object' && !Array.isArray(o)
                && Object.keys(o as object).some((k) => k.includes('|'));
        }).length;

        await cache.getJunctions({ minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 }, 'default'); // miss → schedule
        await cache.getJunctions({ minLat: 61, minLng: 25, maxLat: 62, maxLng: 26 }, 'default'); // miss → dirty, no 2nd chain

        await new Promise((r) => setTimeout(r, 60));   // still inside the 200ms debounce window
        expect(saves()).toBe(0);                       // nothing written yet — the burst is held

        await waitFor(() => existsSync(file));         // window elapses → the coalesced write lands
        expect(saves()).toBe(1);                       // both misses produced exactly one save

        const onDisk = JSON.parse(readFileSync(file, 'utf8'));
        expect(Object.keys(onDisk)).toHaveLength(2);   // the single snapshot holds both entries
    });
});
