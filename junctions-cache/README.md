# wander-junctions

Server-side cache for OSM road-junction lookups, fronting the public Overpass API. Used by the Wander frontend's smart-routing path.

## Run

```bash
pnpm install
pnpm dev                    # tsx watch
pnpm build && pnpm start    # production
```

Listens on `127.0.0.1:5001` (override with `PORT`/`HOST`). Persists cache to `./data/cache.json` (override with `CACHE_PATH`).

The store is bounded so neither memory nor the JSON snapshot grows without limit: entries expire after `CACHE_TTL_MS` (default 30 days — a stale entry is refetched on the next read, not served forever), and the entry count is capped at `CACHE_MAX_ENTRIES` (default 500, oldest-`cachedAt`-first eviction on insert). Both bounds are also applied when the snapshot is loaded at startup.

## Tests

```bash
pnpm test        # vitest (node env; every tests/*.test.ts carries // @vitest-environment node)
pnpm typecheck   # tsc over src + tests via tsconfig.test.json
```

`pnpm build` only compiles `src/**` (the base `tsconfig.json` include), so it never type-checks the test files — `pnpm typecheck` uses `tsconfig.test.json` to close that gap and catch unsafe casts/mocks in tests.

## Abuse controls

- **Per-IP rate limits** (token bucket, keyed on `X-Forwarded-For` then socket): `/junctions` 60/min, `/logs` 30/min, `/health` 120/min. These are defense-in-depth behind the nginx edge `limit_req` and also cover direct tailnet access that bypasses nginx.
- **Global Overpass concurrency cap** (`overpass-limit.ts`): at most 2 outbound Overpass fetches run at once (with a bounded wait queue; overflow → 502). In-flight dedup only collapses identical bboxes, so this is what stops a burst of *distinct* misses from fanning out into many parallel Overpass queries and getting the shared public instance banned.
- **`LOGS_TOKEN`** (env var): `/logs` is **closed by default** — it echoes anchored-lookup events that include the walker's `start` at ~110 m precision (≈ home) and roaming radius, and is publicly reachable via the VPS proxy at `/api/junctions/logs`. Set `LOGS_TOKEN` to reopen it behind an `Authorization: Bearer <LOGS_TOKEN>` (constant-time check); unset ⇒ `401`. journald (see [Logs](#logs)) is the primary, already-authenticated log path, so leaving it closed loses nothing operationally.

## Endpoint

```
GET /junctions?bbox=<minLat,minLng,maxLat,maxLng>&exclude=default|winter
              [&startLat=<lat>&startLng=<lng>&maxKm=<km>]
GET /health
GET /logs?n=<count>
```

Two cache modes:

- **Start-anchored** (when `startLat`/`startLng`/`maxKm` are all sent): one Overpass call per `(start≈100m, ⌈maxKm⌉, exclude)`. Server fetches `start ± maxKm` once, filters to `bbox` per response. Designed so re-rolls from the same start hit the cache regardless of destination.
- **Bbox-keyed** (legacy fallback when start params are absent): one Overpass call per quantized requested bbox. Kept so frontend rollout can lag the service.

Response:

```json
{
    "cache": "hit" | "miss",
    "count": 1834,
    "total": 30412,
    "overpassMs": 2345,
    "junctions": [{ "lat": 62.123, "lng": 21.456 }, ...]
}
```

`total` is the size of the underlying cached set (anchored mode only); `count` is the filtered slice returned in `junctions`.

## Logs

One stdout line per request, captured by journald on shelly:

```
ssh shelly journalctl -u wander-junctions -f -o cat
```

Format: ISO timestamp + level + key=value pairs.

## Deploy

Lives at `/home/shelly/Projects/explorer/junctions-cache` on shelly (`WorkingDirectory` of `wander-junctions.service`; bare repo `ssh://shelly/home/shelly/explorer.git`). Pushed via the `shelly` git remote — the post-receive hook checks out, runs `pnpm install --frozen-lockfile && pnpm build` when `junctions-cache/` changed, and restarts the unit. Persistent cache: `CACHE_PATH=/home/shelly/.local/state/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` → `100.69.160.113:5001`. Same-origin from `/explorer` — no CORS (the client is `fetch('/api/junctions/junctions')`); the edge `limit_req` is the DoS control.
