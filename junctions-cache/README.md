# wander-junctions

Server-side cache for OSM road-junction lookups, fronting the public Overpass API. Used by the Wander frontend's smart-routing path.

## Run

```bash
pnpm install
pnpm dev                    # tsx watch
pnpm build && pnpm start    # production
```

Listens on `127.0.0.1:5001` (override with `PORT`/`HOST`). Persists cache to `./data/cache.json` (override with `CACHE_PATH`).

## Abuse controls

- **Per-IP rate limits** (token bucket, keyed on `X-Forwarded-For` then socket): `/junctions` 60/min, `/logs` 30/min, `/health` 120/min. These are defense-in-depth behind the nginx edge `limit_req` and also cover direct tailnet access that bypasses nginx.
- **Global Overpass concurrency cap** (`overpass-limit.ts`): at most 2 outbound Overpass fetches run at once (with a bounded wait queue; overflow → 502). In-flight dedup only collapses identical bboxes, so this is what stops a burst of *distinct* misses from fanning out into many parallel Overpass queries and getting the shared public instance banned.
- **`LOGS_TOKEN`** (optional env var): when set, `/logs` requires `Authorization: Bearer <LOGS_TOKEN>` (constant-time check). Unset ⇒ `/logs` stays open (default), since it's used for remote debugging and discloses only bbox lookups + cache stats.

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

Lives at `/srv/wander-junctions/junctions-cache` on shelly. Pushed via the `shelly` git remote — the bare repo's `post-receive` hook checks out, runs `pnpm install --frozen-lockfile && pnpm build`, and restarts `wander-junctions.service`. VPS nginx proxies `https://mase.fi/api/junctions/` → `100.69.160.113:5001`.
