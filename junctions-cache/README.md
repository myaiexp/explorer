# wander-junctions

Server-side Overpass cache for the Wander frontend. It is the app's **only** Overpass client: the browser never talks to an Overpass instance directly.

Three lookups, all cached and start-anchored:

- **road junctions** — the smart-routing path's via snapping
- **POI candidates** — the destination-type dropdown
- **road candidates** — the "road" destination type

Upstream is the self-hosted instance on this host (`wander-overpass.service`, `deploy/shelly-overpass/`), with public Overpass as a fallback behind a 5-minute down-latch.

## Run

```bash
pnpm install
pnpm dev                    # tsx watch src/index.ts
pnpm build && pnpm start    # production (`node dist/index.js`)
```

Layout mirrors the cloud-backup server. `src/app.ts` is the composition root and holds no routes — every route lives in `src/routes/*` (`meta.ts` for `/health` + `/logs`, `junctions.ts`, `pools.ts`), each registering its own per-IP limiter so a fresh `createApp()` gets fresh buckets. `src/index.ts` owns `await loadCache()` + `serve()`. `src/server.ts` is a one-line import of `index.ts` so a systemd unit still `ExecStart=`ing `dist/server.js` keeps working.

The cache is split along store-versus-protocol: `src/cache-store.ts` owns the Map, point accounting, TTL, eviction and the JSON snapshot; `src/cache.ts` owns key derivation, inflight dedup and `lookupOrFetch`. `src/lookups.ts` holds the two pool lookups, `src/overpass-pools.ts` their queries and element extraction, `src/poi-catalog.ts` the POI key → filter table.

Listens on `127.0.0.1:5001` (override with `PORT`/`HOST`). Persists cache to `./data/cache.json` (override with `CACHE_PATH`).

Overpass targets (`src/overpass-target.ts`):

| env | default | notes |
| --- | --- | --- |
| `OVERPASS_URL` | `http://127.0.0.1:5002/api/interpreter` | the self-hosted instance, tried first |
| `OVERPASS_FALLBACK_URL` | `https://overpass-api.de/api/interpreter` | used only while the local-down latch is live |
| `OVERPASS_STATUS_URL` | `https://overpass-api.de/api/status` | slot probe; **public-only**, never fetched on a local retry |

A local connection failure or 5xx latches local down for 5 minutes and sends traffic to the fallback; a local **4xx does not** latch, since a malformed query fails identically against the fallback. The slot probe and its back-off sleep run only when the public instance itself just pushed back — not on a local retry, and not on the local→public handover, so the first request of a latch window is not the slow one.

Overpass reports its own timeout and out-of-memory failures **inside a 200**, as a `remark` beside a truncated or empty `elements`. Read at face value that is a silently partial pool — and a non-empty one would then sit in the cache for the full 30-day TTL. So a `remark` raises `OverpassIncompleteError`: retried like any other failed attempt, surfaced in the thrown message once the budget is spent, and logged as `overpass_remark`. It gets its own class because a connection failure and a remark otherwise look identical to the retry loop (both are a thrown `Error` with no HTTP code in the message), and that branch latches local down — which a too-big query must not, since it would fail the same way on the fallback (idea #3160).

The store is bounded so neither memory nor the JSON snapshot grows without limit: entries expire after `CACHE_TTL_MS` (default 30 days — a stale entry is refetched on the next read, not served forever), an **empty** result expires after the much shorter `CACHE_EMPTY_TTL_MS` (default 15 minutes — a bare area is a legitimate answer worth caching, but an empty is also what a mid-diff-update instance returns, and at 30 days one transient empty would pin "nothing near you" on that start for a month), the entry count is capped at `CACHE_MAX_ENTRIES` (default 500), and the total junction count is capped at `CACHE_MAX_POINTS` (default 1,000,000). Eviction is oldest-`cachedAt`-first until both caps are satisfied; a single fetch larger than the point budget is kept (otherwise it would miss-loop). All three bounds are also applied when the snapshot is loaded at startup. Snapshot writes are debounced by `CACHE_SAVE_DEBOUNCE_MS` (default 2000 ms) so a burst of misses stringifies the store once, not per insert.

## Tests

```bash
pnpm test        # vitest (environment: 'node' in vitest.config.ts)
pnpm typecheck   # tsc over src + tests via tsconfig.test.json
```

`pnpm build` only compiles `src/**` (the base `tsconfig.json` include), so it never type-checks the test files — `pnpm typecheck` uses `tsconfig.test.json` to close that gap and catch unsafe casts/mocks in tests.

## Abuse controls

- **Per-IP rate limits** (token bucket, keyed on the TCP socket IP; forwarding headers are used only when the peer is a trusted proxy — nginx on loopback by default, or `TRUSTED_PROXIES`): `/junctions` 60/min, `/pois` 60/min, `/roads` 60/min, `/logs` 30/min, `/health` 120/min. Each endpoint has its own bucket, so an exhausted `/pois` budget does not spend `/roads`'. Behind a trusted proxy the key is `X-Real-IP`, then the last `X-Forwarded-For` hop — never the client-supplied first hop (finding #7895). The production unit sets `TRUSTED_PROXIES=100.117.202.73` (the VPS Tailscale IPv4) so public traffic through nginx is keyed on the client, not shared as one VPS-IP bucket (finding #7754). Direct tailnet callers remain keyed on the real socket address, so a spoofed XFF cannot mint a new bucket.
- **Overpass response cap** (`OVERPASS_MAX_BYTES`, 32 MiB): the body is streamed and counted before `JSON.parse`, so a runaway dump cannot OOM the process (finding #7755). POST `/junctions` is capped at 16 kB to match nginx `client_max_body_size`.
- **Global Overpass concurrency cap** (`overpass-limit.ts`): at most 2 outbound Overpass fetches run at once (with a bounded wait queue; overflow → 502). In-flight dedup only collapses identical cache keys, so this is what stops a burst of *distinct* misses from fanning out into many parallel queries. It stays at 2 even though the primary target is now local: the fallback path still uses the shared public instance, and with the cache in front a local instance never sees enough concurrent misses for 2 to bind.
- **POI types are catalog KEYS, never filter strings.** `/pois` takes `"cafe"` or `"all"` and resolves it through `src/poi-catalog.ts`; an unknown key is a 400. Accepting a raw Overpass filter from a client would make this service an arbitrary-query injection point against our own instance. `poi-catalog.ts` is a twin of the frontend's `poi-types.js`, guarded by `explorer/tests/poi-catalog-parity.test.js` in both directions.
- **`LOGS_TOKEN`** (env var): `/logs` is **closed by default** — it echoes anchored-lookup events that include the walker's `start` at ~110 m precision (≈ home) and roaming radius, and is publicly reachable via the VPS proxy at `/api/junctions/logs`. Set `LOGS_TOKEN` to reopen it behind an `Authorization: Bearer <LOGS_TOKEN>` (constant-time check); unset ⇒ `401`. journald (see [Logs](#logs)) is the primary, already-authenticated log path, so leaving it closed loses nothing operationally.

## Endpoints

```
POST /pois               JSON body — POI candidate pool
POST /roads              JSON body — road candidate pool
POST /junctions          JSON body (see below)
GET  /junctions?bbox=<minLat,minLng,maxLat,maxLng>&exclude=default|winter
GET  /health
GET  /logs?n=<count>
```

Start/radius used to travel on the GET query string and land in nginx access logs at full JS precision (often home). They now go in the POST body so the request line has no coordinates (finding #7559). GET is bbox-only: any of `startLat`/`startLng`/`maxKm` on the query string 400s with "must be sent in the POST body".

`/health` reports the two ways this service degrades without failing — both keep answering 200s otherwise:

```json
{
    "ok": true,
    "cacheEntries": 20,
    "overpass": {
        "local": true,                              // false ⇒ serving the public fallback (latch live)
        "dataTimestamp": "2026-09-01T11:00:00Z",    // osm3s.timestamp_osm_base from the local instance
        "dataAgeSec": 3600,                         // climbing past a day ⇒ the Geofabrik updater has wedged
        "observedAt": "2026-09-01T12:00:00.000Z",   // when that reading was taken…
        "observedAgeSec": 0                         // …so old news reads differently from stale data
    }
}
```

The reading is recorded off the queries the service already makes, never probed: `/health` is publicly reachable through the VPS proxy, so querying Overpass from it would let any caller drive outbound load and — since every query latches the target on failure — let a health check reroute production traffic to the fallback. The four freshness fields are `null` until the first local answer after a restart.

POST body:

```json
{
    "bbox": "<minLat,minLng,maxLat,maxLng>",
    "exclude": "default | winter",
    "startLat": 62.24,
    "startLng": 25.75,
    "maxKm": 7
}
```

`startLat`/`startLng`/`maxKm` are optional as a set (all-or-nothing). Numbers or strings are accepted.

Two cache modes:

- **Start-anchored** (POST, when `startLat`/`startLng`/`maxKm` are all sent): one Overpass call per `(start≈100m, ⌈maxKm⌉, exclude)`. Server fetches `start ± maxKm` once, filters to `bbox` per response. Designed so re-rolls from the same start hit the cache regardless of destination.
- **Bbox-keyed** (GET, or POST without start params): one Overpass call per quantized requested bbox. Kept so a bbox-only curl still works.

Response:

```json
{
    "cache": "hit" | "miss" | "coalesced",
    "count": 1834,
    "total": 30412,
    "overpassMs": 2345,
    "junctions": [{ "lat": 62.123, "lng": 21.456 }, ...]
}
```

| `cache` | meaning | `overpassMs` |
| --- | --- | --- |
| `hit` | served from the in-memory store | omitted |
| `miss` | this request originated the Overpass fetch | wait including throttle-queue |
| `coalesced` | joined another request's in-flight Overpass fetch | this waiter's wait |

`total` is the size of the underlying cached set (anchored mode only); `count` is the filtered slice returned in `junctions`.

### `/pois` and `/roads` — candidate pools

These do the annulus filtering and pool capping the browser used to do. A roads query at a 3.85 km radius was 5.2 MB / 14,043 elements on the wire; the response is now at most `POOL_CAP` (45) candidates.

```
POST /pois   { "startLat": 62.24, "startLng": 25.75, "minKm": 0, "maxKm": 3.85, "types": ["cafe","park"] | "all" }
POST /roads  { "startLat": 62.24, "startLng": 25.75, "minKm": 0, "maxKm": 3.85, "exclude": "default" | "winter" }
```

`minKm` defaults to 0; `maxKm` is required and capped at `MAX_RADIUS_KM` (50). `minKm >= maxKm` is a 400 rather than an empty annulus. There is no `bbox` — the server derives it. Start coordinates on the query string 400 exactly as on `/junctions`.

```json
{
    "cache": "hit" | "miss" | "coalesced",
    "count": 45,
    "total": 312,
    "overpassMs": 304,
    "candidates": [{ "lat": 62.25, "lng": 25.76, "name": "Kahvila" }, ...]
}
```

`/pois` candidates carry `name` only when the OSM element has one; `/roads` candidates are coordinates only. `total` is the cached set size, `count` the sampled slice — the same meaning as on `/junctions`.

A successful query matching nothing is a **200 with `candidates: []`**, not an error. The client distinguishes "found nothing" from "lookup failed" and shows different messages for them.

**Third cache mode: annulus-anchored.** Unlike `/junctions`, the cached value is the *annulus-filtered* set rather than a wide superset, so the entry holds the hundreds of points a walk can use instead of the ~14k the wide bbox returns — and each response re-samples it, so a cache hit still returns a fresh random pool rather than the same 45 forever. Because the stored set is pre-filtered it is only correct for the bounds it was filtered by, so the exact `minKm`/`maxKm` are part of the key: re-rolls hit, a distance change misses. That trade is cheap now that a miss is a local query rather than a public-instance 429.

Keys are namespaced per query kind — `p|` POIs, `r|` roads, `s|` junctions. Roads and junctions take the same `exclude` preset over the same bbox but run different queries (`out center` versus `out body; >; out skel qt;`), so a shared key would serve junction points as road candidates.

## Logs

One stdout line per request, captured by journald on shelly:

```
ssh shelly journalctl -u wander-junctions -f -o cat
```

Format: ISO timestamp + level + key=value pairs.

## Deploy

Lives at `/home/shelly/Projects/explorer/junctions-cache` on shelly (`WorkingDirectory` of `wander-junctions.service`; bare repo `ssh://shelly/home/shelly/explorer.git`). Canonical unit file: `deploy/wander-junctions.service` (`User=wander-junctions`, `ExecStart=/usr/bin/node dist/index.js`). Pushed via the `shelly` git remote — the post-receive hook checks out, runs `pnpm install --frozen-lockfile && pnpm build` when `junctions-cache/` changed, and restarts the unit. Persistent cache: `CACHE_PATH=/var/lib/wander-junctions/cache.json` (`StateDirectory`, not under `/home/shelly`). First-time unit install (dedicated nologin user, cache migrate, hardening): `deploy/install-wander-junctions.sh` on shelly. VPS nginx proxies `https://mase.fi/api/junctions/` → `100.69.160.113:5001`. Same-origin from `/explorer` — no CORS (the client POSTs JSON bodies to `/api/junctions/{pois,roads,junctions}`); the edge `limit_req` is the DoS control. Canonical nginx snippet: `deploy/nginx-junctions.conf` (path-only access log so a leftover GET query cannot persist coords).

The Overpass instance this service queries is a separate unit on the same host — `wander-overpass.service`, see `deploy/shelly-overpass/README.md`. It is deployed independently of this one; stopping it is a supported test, since traffic falls back to public Overpass within one request.
