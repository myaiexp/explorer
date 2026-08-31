# Self-hosted Overpass + server-side candidate selection — Implementation Plan

**Goal:** Run Overpass on shelly and move POI/road candidate selection into
`junctions-cache`, so the browser stops hitting the public Overpass API and stops
downloading megabytes per generate.

**Architecture:** A pinned `wiktorn/overpass-api` container on shelly serves
Overpass on loopback, kept current by Geofabrik Finland diffs. `junctions-cache`
becomes the only Overpass client: it queries the local instance first, falls back
to the public one behind a 5-minute down-latch, and gains `/pois` and `/roads`
endpoints that do the annulus filtering and pool capping the browser does today.
The frontend's two Overpass fetchers shrink to two same-origin POSTs.

**Tech Stack:** Docker (shelly), Node 24 + Hono + TypeScript (`junctions-cache`),
vanilla JS (frontend), vitest both sides, systemd + nginx.

**Spec:** `docs/plans/2026-08-31-self-hosted-overpass-design.md`

---

### Task 1: Provision `wander-overpass` on shelly [Mode: Direct]

Do this first. The initial import runs for hours; everything else proceeds while
it does.

**Files:**
- Create: `deploy/shelly-overpass/wander-overpass.service`
- Create: `deploy/shelly-overpass/install.sh`
- Create: `deploy/shelly-overpass/README.md`

**Contracts:**

Unit runs the container under systemd, pinned:

```
ExecStart=/usr/bin/docker run --rm --name wander-overpass \
    -p 127.0.0.1:5002:80 \
    -v /srv/overpass/db:/db \
    -e OVERPASS_MODE=init \
    -e OVERPASS_META=no \
    -e OVERPASS_USE_AREAS=false \
    -e OVERPASS_STOP_AFTER_INIT=false \
    -e OVERPASS_COMPRESSION=gz \
    -e OVERPASS_UPDATE_SLEEP=3600 \
    -e OVERPASS_PLANET_URL=https://download.geofabrik.de/europe/finland-latest.osm.pbf \
    -e OVERPASS_DIFF_URL=https://download.geofabrik.de/europe/finland-updates/ \
    -e OVERPASS_PLANET_PREPROCESS='mv /db/planet.osm.bz2 /db/planet.osm.pbf && osmium cat -o /db/planet.osm.bz2 /db/planet.osm.pbf && rm /db/planet.osm.pbf' \
    wiktorn/overpass-api:v0.7.62.11
ExecStop=/usr/bin/docker stop wander-overpass
Restart=always
```

`install.sh` follows `deploy/shelly-osrm/install.sh`: idempotent, creates
`/srv/overpass/db`, installs + enables the unit, then smoke-tests.

**Constraints:**
- Bind to `127.0.0.1` only. `junctions-cache` runs natively on the same host and
  is the sole consumer; nothing needs the tailnet.
- Port 5002 — 5000 is `osrm-foot`, 5001 is `wander-junctions`.
- Pin the tag. Never `latest`: the volume holds a multi-hour import.
- `install.sh` must NOT block on the import. Start the unit and return; the
  import runs inside the container.

**Verification:**
```bash
ssh shelly 'systemctl is-active wander-overpass'
ssh shelly 'docker logs --tail 20 wander-overpass'
# once the import finishes (hours):
ssh shelly 'curl -s "http://127.0.0.1:5002/api/interpreter?data=[out:json];node(1);out;" | head -c 300'
```
Expected: unit active immediately; the query returns JSON with an
`osm3s.timestamp_osm_base` once the import completes.

**Commit after the unit files are written and the unit is running** — do not
wait for the import to finish before continuing to Task 2.

---

### Task 2: Restructure `junctions-cache` modules — no behavior change [Mode: Direct]

`src/app.ts` (156) and `src/cache.ts` (283) both cross the 300-line limit once
the new endpoints land. Split first, with the existing test suite green
throughout, so later tasks add behavior to already-correct boundaries.

**Files:**
- Modify: `junctions-cache/src/app.ts` → composition root only
- Create: `junctions-cache/src/routes/meta.ts` (`/health`, `/logs`, `logsTokenOk`)
- Create: `junctions-cache/src/routes/junctions.ts` (GET+POST `/junctions`, `lookupJunctions`)
- Create: `junctions-cache/src/lib/post-body.ts` (`MAX_POST_BYTES`, shared read+parse, `queryHasAnchor`)
- Create: `junctions-cache/src/cache-store.ts` (the Map, point accounting, TTL, prune, snapshot load/save)
- Modify: `junctions-cache/src/cache.ts` → key derivation, `lookupOrFetch`, `getJunctions`, `getJunctionsAnchored`
- Modify: `junctions-cache/tests/*` — import paths only

**Contracts:**

```ts
// src/lib/post-body.ts
export const MAX_POST_BYTES: number;               // 16 * 1024
export type BodyResult = { ok: true; body: unknown } | { ok: false; status: 400 | 413; error: string };
export async function readJsonBody(c: Context): Promise<BodyResult>;
/** True when startLat/startLng/maxKm appear on the query string (coords belong in the body). */
export function queryHasAnchor(c: Context): boolean;

// src/cache-store.ts
export type CachedPoint = { lat: number; lng: number; name?: string };
export type Entry = { junctions: CachedPoint[]; cachedAt: number };
export function readFresh(key: string): Entry | undefined;
export function setEntry(key: string, entry: Entry): void;
export function prune(now: number): number;
export function bumpAndSave(): void;
export function loadCache(): Promise<void>;
export function cacheSize(): number;

// src/cache.ts
export type LookupResult =
    | { cache: 'hit'; junctions: CachedPoint[] }
    | { cache: 'miss' | 'coalesced'; junctions: CachedPoint[]; overpassMs: number };
export type AnchoredLookupResult = LookupResult & { total: number };
export async function lookupOrFetch(key: string, fetchFn: () => Promise<CachedPoint[]>): Promise<LookupResult>;
export function wideBboxFromStart(start: StartParams): Bbox;
```

**Constraints:**
- Pure move. No signature the tests touch may change meaning; if a test needs
  more than an import-path edit, the move went too far.
- **The split seam is store-and-persistence versus lookup protocol — NOT
  per-query-kind.** `getJunctions`/`getJunctionsAnchored` stay in `cache.ts`.
  They are the only public trigger `cache.test.ts` (~800 lines) has, so nearly
  every describe block in it — persistence, TTL, eviction, pruning — drives its
  assertions through them. Moving them would rewrite that file's call sites, not
  its import line, which is exactly what the guardrail above forbids. Only the
  two *new* pool lookups get a new home, in Task 6.
- `queryHasAnchor` is private to `app.ts` today. It must become a shared export
  so Task 6's pool routes can reuse it rather than reimplementing the guard or
  importing from a sibling route file.
- `LookupResult` and `AnchoredLookupResult` widen to `CachedPoint[]` alongside
  `lookupOrFetch`. Widening only the fetch signature leaves Task 6 unable to
  return a POI `name` to its callers, surfacing as a typecheck failure two tasks
  later.
- `Entry`'s persisted field stays named `junctions` even as the value type widens
  to `CachedPoint[]` — renaming it makes `isValidEntry` drop every row in the
  existing on-disk snapshot on load.
- Every new file gets a first-line description comment.

**Verification:**
```bash
cd junctions-cache && build-lock pnpm test && build-lock pnpm typecheck
```
Expected: all pre-existing tests pass unchanged except import paths. No file over
300 lines (`wc -l src/*.ts src/**/*.ts`).

**Commit after passing.**

---

### Task 3: Local-first Overpass client with public fallback [Mode: Delegated]

**Files:**
- Create: `junctions-cache/src/overpass-target.ts`
- Modify: `junctions-cache/src/overpass.ts`
- Create: `junctions-cache/tests/overpass-target.test.ts`
- Modify: `junctions-cache/tests/overpass.test.ts`

**Contracts:**

```ts
// src/overpass-target.ts
export const LOCAL_DOWN_LATCH_MS = 5 * 60_000;
export type Target = { url: string; local: boolean };

/** Local unless the down-latch is live; then the public fallback. */
export function currentTarget(): Target;
/** Start (or restart) the 5-minute latch. */
export function markLocalDown(): void;
export function isLocalDown(): boolean;
/** Test seam — resets the latch. */
export function _resetLatch(): void;
```

Env: `OVERPASS_URL` (default `http://127.0.0.1:5002/api/interpreter`),
`OVERPASS_FALLBACK_URL` (default `https://overpass-api.de/api/interpreter`),
`OVERPASS_STATUS_URL` (default `https://overpass-api.de/api/status`).

```ts
// src/overpass.ts
export async function runOverpassQuery(query: string): Promise<OverpassElement[]>;
export async function fetchJunctionsFromOverpass(bbox: Bbox, exclude: ExcludePreset): Promise<LatLng[]>;
```

**Test Cases:**

```ts
test('local target used when the latch is clear', () => {
    _resetLatch();
    expect(currentTarget()).toEqual({ url: LOCAL_URL, local: true });
});

test('markLocalDown flips the target to the public fallback', () => {
    _resetLatch(); markLocalDown();
    expect(currentTarget().local).toBe(false);
});

test('the latch expires after LOCAL_DOWN_LATCH_MS and returns to local', () => {
    vi.useFakeTimers(); _resetLatch(); markLocalDown();
    vi.advanceTimersByTime(LOCAL_DOWN_LATCH_MS + 1);
    expect(currentTarget().local).toBe(true);
});

test('a connection failure against local marks it down and retries against public', async () => {
    // local fetch rejects; public returns a valid body
    const elements = await runOverpassQuery('[out:json];node(1);out;');
    expect(isLocalDown()).toBe(true);
    expect(elements).toHaveLength(1);
});

test('a local 5xx also trips the latch', async () => { /* local → 502, public → ok */ });

test('a local 400 does NOT trip the latch — it is our query that is wrong', async () => {
    await expect(runOverpassQuery('bad')).rejects.toThrow(/overpass http 400/);
    expect(isLocalDown()).toBe(false);
});

test('local retries do not sleep on the public status probe', async () => {
    // local fails twice then succeeds; assert the status URL was never fetched
    // and total elapsed is far under one public back-off (< 1s with fake timers)
});

test('public-path retries keep the existing status-probe pacing', async () => {
    // latch tripped; public returns 429 then ok; assert status URL was fetched
    // and the parsed "in N seconds" wait was honoured
});

test('BodyTooLargeError still fails immediately without burning attempts', async () => { /* unchanged */ });
```

**Constraints:**
- The existing `/junctions` path goes through this too — `fetchJunctionsFromOverpass`
  must end up calling `runOverpassQuery`, not its own fetch loop. Leaving
  `/junctions` on the public instance is the specific failure this task exists
  to prevent.
- Only connection failures and 5xx trip the latch. A 4xx means our query is
  malformed and would fail identically against the fallback.
- `getStatusWaitSec` is public-only. A local retry must not sleep up to 60 s
  waiting on a slot concept the local instance does not have.
- Keep the `User-Agent` header on public requests.
- `MAX_CONCURRENT` in `overpass-limit.ts` stays 2 — see the spec for why.

**Verification:**
```bash
cd junctions-cache && build-lock pnpm test overpass && build-lock pnpm typecheck
```

**Commit after passing.**

---

### Task 4: POI catalog twin + parity enforcement [Mode: Direct]

**Files:**
- Create: `junctions-cache/src/poi-catalog.ts`
- Create: `junctions-cache/tests/poi-catalog.test.ts` (the `filtersForTypes` cases below)
- Create: `tests/poi-catalog-parity.test.js` (the two cross-repo parity cases below)

Note the twin bookkeeping: this task *adds* a POI-catalog twin
(`poi-types.js` ↔ `poi-catalog.ts`) in a new guard file. Task 7 *removes* the
existing `HIGHWAY_EXCLUDE` twin outright — deleting the frontend copy leaves
`junctions-cache` its sole owner — and deletes
`tests/overpass-exclude-parity.test.js` along with it. Do not extend that file
here; its subject is about to stop existing.

**Contracts:**

```ts
// src/poi-catalog.ts
export const POI_FILTERS: Record<string, string>;   // key → Overpass filter, e.g. cafe → ["amenity"="cafe"]
export type TypesSelector = string[] | 'all';
export function filtersForTypes(types: TypesSelector):
    { ok: true; filters: string[]; typesKey: string } | { ok: false; error: string };
```

`typesKey` is the cache-key fragment: `'all'` for the whole catalog, otherwise
the sorted keys joined by `+`, so `["park","cafe"]` and `["cafe","park"]` share
one entry.

**Test Cases:**

```ts
test('every frontend POI key exists in the server catalog with a byte-identical filter', () => {
    // parse poi-types.js POI_CATEGORIES, compare key→filter against POI_FILTERS
});
test('the server catalog has no key the frontend does not offer', () => { /* both directions */ });
test("filtersForTypes('all') returns every filter", () => { ... });
test('an unknown key is an error, not a silent drop', () => {
    expect(filtersForTypes(['nope']).ok).toBe(false);
});
test('an empty array is an error, not an empty union', () => {
    expect(filtersForTypes([]).ok).toBe(false);
});
test('typesKey is order-independent', () => {
    expect(filtersForTypes(['park','cafe']).typesKey).toBe(filtersForTypes(['cafe','park']).typesKey);
});
```

**Constraints:**
- The filter strings must match `poi-types.js` **byte for byte**, including
  `["amenity"~"pub|bar"]`'s regex and `["historic"]`'s bare-key form. The parity
  test is the only thing preventing drift; it must fail RED on a one-character
  change, like the `HIGHWAY_EXCLUDE` half already does.
- Never accept a raw filter string from a request. Keys only.

**Verification:**
```bash
build-lock pnpm test poi-catalog-parity && cd junctions-cache && build-lock pnpm test poi-catalog
```
Also confirm the guard is not vacuous: change one character in a `POI_FILTERS`
value and watch the parity test fail, then revert.

**Commit after passing.**

---

### Task 5: Pool primitives + request parsing [Mode: Direct]

**Files:**
- Create: `junctions-cache/src/lib/pool.ts`
- Create: `junctions-cache/src/lib/parse-pool-request.ts`
- Create: `junctions-cache/tests/pool.test.ts`
- Create: `junctions-cache/tests/parse-pool-request.test.ts`

**Contracts:**

```ts
// src/lib/pool.ts
export const POOL_CAP = 45;   // mirrors the frontend's SCREENING_POOL_CAP
export function filterToAnnulus<T extends { lat: number; lng: number }>(
    points: T[], centerLat: number, centerLng: number, minKm: number, maxKm: number): T[];
export function samplePool<T>(points: T[], cap: number): T[];

// src/lib/parse-pool-request.ts
export type PoolAnchor = { startLat: number; startLng: number; minKm: number; maxKm: number };
export type ParsedPoi  = { ok: true; anchor: PoolAnchor; types: TypesSelector };
export type ParsedRoad = { ok: true; anchor: PoolAnchor; exclude: ExcludePreset };
export function parsePoiRequest(body: unknown): ParsedPoi | ParseFailure;
export function parseRoadRequest(body: unknown): ParsedRoad | ParseFailure;
```

**Test Cases:**

```ts
test('filterToAnnulus keeps points between minKm and maxKm inclusive', () => { ... });
test('filterToAnnulus drops points inside minKm', () => { ... });
test('filterToAnnulus preserves the name field on POI points', () => { ... });
test('samplePool returns the input identity when at or below the cap', () => {
    const small = makePoints(10);
    expect(samplePool(small, 45)).toBe(small);
});
test('samplePool above the cap returns exactly cap items', () => { ... });
test('samplePool is randomized, not first-N', () => {
    // 20 runs over the same 200-point input produce more than one distinct head
});
test('samplePool does not mutate its input', () => { ... });

test('parsePoiRequest accepts numbers or numeric strings for the anchor', () => { ... });
test('parsePoiRequest rejects a missing start', () => { ... });
test('parsePoiRequest rejects minKm >= maxKm', () => { ... });
test('parsePoiRequest rejects maxKm above MAX_RADIUS_KM', () => { ... });
test('parsePoiRequest rejects an unknown POI key', () => { ... });
test("parsePoiRequest accepts the string 'all'", () => { ... });
test('parseRoadRequest rejects an exclude that is neither default nor winter', () => { ... });
test('parseRoadRequest defaults exclude to "default" when absent', () => { ... });
```

**Constraints:**
- `minKm` defaults to 0 when absent; `maxKm` is required. Unlike the junctions
  anchor, `bbox` is NOT part of these requests — the server derives it.
- Reuse `MAX_RADIUS_KM` from `lib/parse-request.ts` rather than redefining it.
- `filterToAnnulus` uses the same haversine the frontend used, so the candidate
  set is unchanged from today's client-side filtering.

**Verification:**
```bash
cd junctions-cache && build-lock pnpm test pool && build-lock pnpm typecheck
```

**Commit after passing.**

---

### Task 6: `/pois` and `/roads` endpoints [Mode: Delegated]

**Files:**
- Create: `junctions-cache/src/overpass-pools.ts` (query builders + parsers)
- Create: `junctions-cache/src/routes/pools.ts`
- Modify: `junctions-cache/src/lookups.ts` (add the two anchored lookups)
- Modify: `junctions-cache/src/app.ts` (mount)
- Create: `junctions-cache/tests/pools-routes.test.ts`
- Create: `junctions-cache/tests/overpass-pools.test.ts`

**Contracts:**

```ts
// src/overpass-pools.ts
export type PoiPoint = { lat: number; lng: number; name?: string };
export async function fetchPoisFromOverpass(bbox: Bbox, filters: string[]): Promise<PoiPoint[]>;
export async function fetchRoadsFromOverpass(bbox: Bbox, exclude: ExcludePreset): Promise<LatLng[]>;

// src/lookups.ts
export async function getPoisAnchored(anchor: PoolAnchor, typesKey: string, filters: string[]): Promise<AnchoredLookupResult>;
export async function getRoadsAnchored(anchor: PoolAnchor, exclude: ExcludePreset): Promise<AnchoredLookupResult>;
```

HTTP:

```
POST /pois   { startLat, startLng, minKm?, maxKm, types: string[] | "all" }
POST /roads  { startLat, startLng, minKm?, maxKm, exclude?: "default" | "winter" }

200 → { cache: "hit"|"miss"|"coalesced", count, total, overpassMs?, candidates: [...] }
400 → { error }   invalid body / unknown key / bad anchor
413 → { error }   body over MAX_POST_BYTES
502 → { error: "POI search is busy. Please try again." }
```

**Test Cases:**

```ts
test('POST /pois returns candidates filtered to the annulus and capped at POOL_CAP', async () => { ... });
test('POST /pois candidates carry name when the OSM element is named, and omit it otherwise', async () => { ... });
test('POST /pois with types "all" queries the full catalog union', async () => {
    // assert the built query contains one node+way statement per catalog entry
});
test('POST /pois twice from the same start hits the cache the second time', async () => {
    expect(second.cache).toBe('hit');
});
test('POST /pois with a different maxKm keys separately', async () => { ... });
test('POST /pois with the same keys in a different order hits the same entry', async () => { ... });
test('a cached POI set is re-sampled per request, not frozen', async () => {
    // >200 cached candidates, two hits, different heads at least once over N tries
});
test('POST /roads and POST /junctions from the same start+exclude do NOT share a cache entry', async () => {
    // the two run different Overpass queries; a shared key would serve junctions as roads
});
test('POST /roads winter exclude reaches the query', async () => { ... });
test('unknown POI key → 400 with a reason, no Overpass call', async () => { ... });
test('body over MAX_POST_BYTES → 413', async () => { ... });
test('startLat on the query string → 400 (coords belong in the body)', async () => { ... });
test('Overpass failure → 502 with the busy message', async () => { ... });
test('empty Overpass result → 200 with candidates: []', async () => {
    // distinct from failure: the client has separate branches for these
});
test('both endpoints are subject to the per-IP rate limiter', async () => { ... });
```

Additionally, port the 13 assertions from the frontend's
`tests/overpass-parse.test.js` into `tests/overpass-pools.test.ts` — element
extraction (`node` kept with `tags.name`; `way` with `center` kept, unnamed →
no name; `way` without `center` dropped; relations ignored), the annulus filter,
the node+way union assembly, and both `HIGHWAY_EXCLUDE` presets reaching the
road query. Task 7 deletes that file; this is where its coverage lands.

**Constraints:**
- Cache keys must be namespaced per query kind: junctions `s|…`, POIs `p|…`,
  roads `r|…`. Roads and junctions take the same `exclude` over the same bbox but
  run different queries — a shared key is a correctness bug, not a cache-hit win.
- Cache the **full annulus-filtered set**; sample to `POOL_CAP` per response so a
  cache hit still returns a fresh random pool.
- `total` reports the cached set size, `count` the sampled slice — matching what
  `/junctions` already means by those fields.
- Reuse `wideBboxFromStart` for the fetch bbox and `runWithOverpassSlot` via
  `lookupOrFetch`; do not open a second concurrency path.
- Start coordinates never on the query string (finding #7559): reuse the existing
  `queryHasAnchor` guard.
- The POI query mirrors the frontend's exactly: `[out:json][timeout:20];` with
  `node<filter>(bbox); way<filter>(bbox);` per filter, `out center tags;`. Roads:
  `[out:json][timeout:15];` `way["highway"]["highway"!~"<exclude>"](bbox); out center;`.

**Verification:**
```bash
cd junctions-cache && build-lock pnpm test && build-lock pnpm typecheck
```

**Commit after passing.**

---

### Task 7: Frontend rewire [Mode: Delegated]

**Files:**
- Modify: `overpass.js` (rewrite)
- Modify: `destination-resolve.js` (pass keys, not filters)
- Modify: `tests/helpers/load.js` (`SCRIPT_DEPS`)
- Modify: `deploy/nginx-explorer.conf` (CSP)
- Modify: `tests/nginx-security.test.js`
- Modify: `tests/overpass.test.js` (rewrite)
- Modify: `tests/destination-resolve.test.js` (as needed)
- Delete: `tests/overpass-parse.test.js` (148 lines, 13 tests)
- Delete: `tests/overpass-exclude-parity.test.js` (63 lines)
- Delete or reshape: `tests/helpers/overpass-fetch.js` (41 lines)

**Three test files die with the code they cover — this is the part that is easy
to miss.** `tests/overpass-parse.test.js` tests exactly what this task deletes:
`el.type === 'node'`/`way` extraction, `el.center` handling, the annulus
distance filter, the `node…(bbox); way…(bbox)` union assembly, and both
`HIGHWAY_EXCLUDE` presets. Its 13 assertions are not lost — they are the
behavioural spec for Task 6's `tests/overpass-pools.test.ts`, so port them there
before deleting, and check that each has a counterpart.
`tests/overpass-exclude-parity.test.js` guards a twin that ceases to exist the
moment the frontend constants go. `tests/helpers/overpass-fetch.js` is used only
by those two files and the rewritten `overpass.test.js`; keep it only if the new
POST-body assertions still want it.

**Contracts:**

```js
// overpass.js — signatures keep their positional shape so destination-resolve.js
// changes as little as possible. `filter` becomes `types`.
async function fetchPOIsInRadius(startLat, startLng, minKm, maxKm, types, onProgress)
    // types: string[] | 'all'  → POST /api/junctions/pois → [{lat, lng, name}]
async function fetchRoadsInRadius(startLat, startLng, minKm, maxKm, onProgress, winterMode = false)
    // → POST /api/junctions/roads → [{lat, lng}]
```

Deleted from `overpass.js`: `queryOverpass`, `sleep`, the status probe,
`OVERPASS_*_TIMEOUT_MS`, `HIGHWAY_EXCLUDE_DEFAULT`, `HIGHWAY_EXCLUDE_WINTER`,
and both element-shaping loops. They live server-side now.

In `destination-resolve.js`: `filters = poiType.filter` → `types = poiType.key`,
and the `any_poi` branch's `POI_TYPES.map(p => p.filter)` → `'all'`.

**Test Cases:**

```js
test('fetchPOIsInRadius POSTs to /api/junctions/pois with start in the body', async () => {
    // assert url.pathname, method POST, and that no coordinate appears in url.search
});
test('fetchPOIsInRadius sends types "all" verbatim, not an expanded filter list', async () => { ... });
test('fetchPOIsInRadius maps the response candidates array through unchanged', async () => { ... });
test('fetchRoadsInRadius sends exclude "winter" when winterMode is true', async () => { ... });
test('fetchRoadsInRadius sends exclude "default" when winterMode is false', async () => { ... });
test('a 502 rejects, so resolveCandidatePool falls back to the random pool', async () => { ... });
test('an empty candidates array resolves to [] — the no-results branch, not the error branch', async () => { ... });
test('a network timeout rejects rather than resolving empty', async () => { ... });
```

**Constraints:**
- `destination-resolve.js` keeps calling `capPool`. It is defensive now, not
  load-bearing — the client should bound its own OSRM `/table` fan-out whatever
  the server sends.
- `SCRIPT_DEPS['overpass']` becomes `['net']`. `geo-utils` is dead weight once
  `bboxAround`/`haversineKm` move server-side, and that file's
  reverse-completeness check turns a stale edge into a test failure.
- `tests/nginx-security.test.js` needs **two** edits, and the second is not a
  deletion: remove the hardcoded
  `expect(csp).toMatch(/https:\/\/overpass-api\.de/)`, and re-anchor the
  anti-vacuity check from `hostsIn('overpass.js')` to a module that still fetches
  a third party — `elevation.js` → `api.open-meteo.com`. Deleting it instead
  would let the host scan start passing vacuously.
- Distinguishing an empty result from a failure matters: `resolveCandidatePool`
  has separate branches with different progress messages ("No matching places
  found nearby" vs "Overpass unavailable"). A 200 with `candidates: []` must
  resolve, not throw.

**Verification:**
```bash
build-lock pnpm test overpass && build-lock pnpm test destination-resolve && build-lock pnpm test nginx-security
```

**Commit after passing.**

---

### Task 8: `any POI` as the default destination type [Mode: Direct]

**Files:**
- Modify: `poi-types.js` (option order)
- Modify: `settings.js` (one-time migration)
- Modify: `tests/settings.test.js`

**Contracts:**

`populateLocationTypeSelect` adds `any POI` first, then `location (anywhere)`,
then `road`, then the category optgroups — so a fresh install defaults to
`any_poi`.

A one-time migration rewrites a stored `poiType === 'any'` to `'any_poi'`,
guarded by a flag key so it fires exactly once per browser.

**Test Cases:**

```js
test('a fresh install defaults the select to any_poi', () => { ... });
test('a stored poiType of "any" migrates to "any_poi" on first restore', () => { ... });
test('the migration does not re-fire — re-picking "any" afterwards survives a reload', () => {
    // this is the whole point of the flag; without it the migration is a permanent override
});
test('a stored poiType of "cafe" is untouched by the migration', () => { ... });
test('a corrupt settings blob does not throw during migration', () => { ... });

test('the migrated value is PERSISTED, not just applied to the DOM', () => {
    // Migrate, then re-read localStorage directly and assert it now holds
    // 'any_poi'. An implementation that rewrites only the in-memory value while
    // still setting the one-time flag passes every other test here, then
    // silently reverts to 'any' on the next untouched reload — the flag
    // suppresses re-migration while the stored blob was never corrected.
});
```

**Constraints:**
- Reordering alone is not enough. `settings.js` restores `poiType` with
  `skipEmpty: true`, so every existing browser keeps `any` and sees no change —
  which is the opposite of the intent.
- The flag must be checked before the rewrite and set after, so a user who
  deliberately re-picks "anywhere" keeps it.

**Verification:**
```bash
build-lock pnpm test settings && build-lock pnpm test poi-types
```

**Commit after passing.**

---

### Task 9: Deploy and verify live [Mode: Direct]

**Files:**
- Modify: `deploy/wander-junctions.service` (add `OVERPASS_URL`, `OVERPASS_FALLBACK_URL`)

**Constraints:**
- Confirm the import from Task 1 has finished before pointing `junctions-cache`
  at it. If it hasn't, the fallback latch keeps things working, but verification
  results would be measuring the public instance.
- `junctions-cache` deploys via the `shelly` git remote, not `deploy` — its
  post-receive hook rebuilds and restarts. The frontend deploys via `deploy`.
- Check the nginx `limit_req` burst on `/api/junctions/`: a generate now makes
  **two** calls to that location (pois-or-roads plus junctions) where it made
  one. If the burst is tight, a re-roll could trip the edge limiter.

**Verification (functional, as a user — not by reading code):**
```bash
# payload: the number this whole change exists to move
#   before: roads at 3.85 km = 5.2 MB / 14,043 elements
#   after:  expect kilobytes, <= 45 candidates
ssh shelly 'curl -s -o /dev/null -w "%{size_download}\n" -X POST http://127.0.0.1:5001/roads \
    -H "Content-Type: application/json" \
    -d "{\"startLat\":62.24,\"startLng\":25.75,\"minKm\":0,\"maxKm\":3.85}"'

# cache: second identical call must report a hit
# fallback: stop the container, confirm generates still work, restart it
ssh shelly 'sudo systemctl stop wander-overpass'
#   → generate a route in the browser, expect success (slower)
ssh shelly 'sudo systemctl status wander-junctions --no-pager | tail -5'   # latch logged
ssh shelly 'sudo systemctl start wander-overpass'
```

In the browser at `https://mase.fi/explorer/`, with devtools network open:
generate for `any POI`, a specific POI type, `road` (both winter modes), and
`location (anywhere)`; confirm each returns a route, the request goes to
`/api/junctions/*`, no request reaches `overpass-api.de`, no CSP violation
appears in the console, and a re-roll from the same start is visibly faster.

**Commit, then `deploy`.**

---

### Task 10: Documentation [Mode: Direct]

**Files:**
- Modify: `CLAUDE.md` (architecture paragraph, step 3 of the core logic flow)
- Modify: `junctions-cache/README.md` (endpoints, cache modes, abuse controls, deploy)
- Modify: `deploy/README.md` (the new unit)
- Create: `deploy/shelly-overpass/README.md` (written in Task 1)

**Constraints:**
- `CLAUDE.md` currently says the frontend queries Overpass directly and describes
  `junctions-cache` as junction-only. Both become wrong with this change.
- Keep `CLAUDE.md` a map — depth goes in `junctions-cache/README.md` and
  `deploy/shelly-overpass/README.md`.
- Amend into the Task 9 commit rather than making a separate docs commit, per the
  repo's doc rules.

**Verification:** `rg -n "overpass-api\.de" CLAUDE.md junctions-cache/README.md`
returns only fallback references.

---

## Execution
**Skill:** Subagent Dev
- Mode A tasks: orchestrator implements directly
- Mode B tasks: dispatched to subagents

Task 1 runs first and its import proceeds in the background. Tasks 2→6 are
strictly sequential (each builds on the previous file layout). Task 7 depends on
Task 6's endpoints existing. Task 8 is independent of 2–7 and can run at any
point after Task 1. Task 9 depends on everything.
