# Junctions cache — Helsinki follow-up: kill Overpass dependency

## Status at handoff

`wander-junctions.service` is live on shelly:5001 (system unit, user `shelly`, bound to `100.69.160.113`), exposed via nginx at `https://mase.fi/api/junctions/`. The frontend (`fetchCorridorJunctions` in `app.js`) routes all junction lookups through it. Source lives at `explorer/junctions-cache/` in this repo. See `junctions-cache/README.md` for the basic shape.

What's deployed is correct but only solves part of the problem. Helsinki testing exposed two follow-ups.

**Update (2026-05-02):** Step 1 (start-anchored caching) shipped. Service now caches by `(start≈100m, ⌈maxKm⌉, exclude)` and fetches a wide `start ± maxKm` bbox once per key, filtering server-side per request. Legacy bbox path retained as fallback. Verify hit-rate via `/logs?n=50` after a fresh Helsinki test. If cold-path Overpass is still painful, proceed to Step 2.

## Problem 1 — cache misses every time in dense areas

Three Helsinki tests, all logged as misses:

```
miss bbox=60.1601,24.9304,60.1889,24.9651 count=12066 overpass_ms=845
miss bbox=60.1600,24.9302,60.1734,24.9901 count=7731  overpass_ms=606
miss bbox=60.1606,24.9192,60.1863,24.9556 count=12282 overpass_ms=6343
```

Each random destination yields a slightly different bbox (start→dest+padding); the current 4-decimal-place quantize (~11 m) doesn't merge them. So the cache helps within a single generation's retries (already covered by an in-app cache anyway) but not across generations.

## Problem 2 — public Overpass tail latency

The 6.3 s entry above is just Overpass having a bad day. Cold-cache calls inherit Overpass's tail, which is unpredictable and outside our control. The user's note: "Overpass is cucking us." The cache reduces frequency but doesn't fix the underlying dependency.

## Recommended path (two steps)

### Step 1 (cheap): start-anchored cache key

Replace bbox-keyed caching with start-anchored caching.

**Cache key:** `(quantize(startLat, ~100m) | quantize(startLng, ~100m) | maxRadiusKm | excludePreset)`

**Server flow:**

1. Frontend sends `?startLat&startLng&maxKm&minLat&minLng&maxLat&maxLng&exclude=…` (added params: `startLat`, `startLng`, `maxKm`).
2. Server computes the cache key from start + maxKm + exclude — independent of destination.
3. On miss: fetch a wide bbox = `start ± maxKm` in one Overpass query (covers all possible destinations from this start).
4. Filter the cached set to the requested bbox before returning, so the wire payload stays manageable (12k+ junctions can become a few hundred relevant ones).
5. Existing `bbox` + `exclude` params keep the per-request response shape unchanged from the client's POV.

**Frontend:** `fetchCorridorJunctions` needs the start point and max radius (already available from the user's distance setting). Just add the extra query params.

**Expected outcome:** one Overpass call per (start, maxRadius) instead of per destination. Helsinki testing should jump from ~0% to ~75% hit rate.

**Watch out:**

- Helsinki's 5 km radius bbox returns ~30k junctions. Server-side filter to the requested corridor before responding so the network payload stays small. Cache stores the full set on disk.
- Cache file size grows: each Helsinki entry could be ~2 MB JSON. Fine for ~50 entries; revisit if it gets unwieldy.
- Keep the old per-bbox path working when `startLat`/`maxKm` are absent — frontend rollout might lag the service.

### Step 2 (proper): pre-extract junctions from PBF

Even with start-anchored caching, the FIRST request for any new start still hits public Overpass and inherits its tail latency. Eliminate the dependency entirely.

**Approach:**

- Once per OSM data refresh, run a small extraction job (osmium tool or similar) on shelly against the same Finland PBF that already feeds `osrm-foot.service`.
- Output: a static dataset of junction nodes (every OSM node referenced by ≥2 highway ways), filtered per exclude preset, indexed for fast bbox lookup (R-tree, geohash grid, or just a sorted array bucketed by 0.1° cell).
- Service reads from that local dataset instead of hitting Overpass. Cold paths become local file reads, sub-millisecond.

This is a bigger task — extraction pipeline, scheduled refresh tied to OSRM's data refresh, on-disk index format, server lookup code — but eliminates the public Overpass dependency for junctions entirely. Service shape stays the same from the client's POV.

**Order of preference:** ship Step 1 first (small, immediate win), use the logs to confirm the hit-rate hypothesis, then commit to Step 2 if cold-path Overpass calls are still painful. If Step 1 alone makes Helsinki testing feel snappy, Step 2 might be deferrable.

## Existing infrastructure (don't redo)

- **Service:** `wander-junctions.service` on shelly. System unit at `/etc/systemd/system/`. `User=shelly`, env: `PORT=5001`, `HOST=100.69.160.113`, `CACHE_PATH=/home/shelly/.local/state/wander-junctions/cache.json`.
- **Source layout:** `explorer/junctions-cache/` — Hono + TypeScript + pnpm. `src/server.ts` (routes), `src/cache.ts` (Map + persistent JSON), `src/overpass.ts` (fetch + retry, ports app.js's `queryOverpass`), `src/log.ts` (stdout + ring buffer).
- **Persistent cache file:** `/home/shelly/.local/state/wander-junctions/cache.json`, atomic rename + 200 ms debounce. Survives restarts and pushes.
- **Deploy:** `git push shelly HEAD:master` (or just run `deploy` — it picks up the shelly remote automatically). Post-receive hook at `/home/shelly/explorer.git/hooks/post-receive` only rebuilds if `junctions-cache/` actually changed, so unrelated frontend pushes don't churn the service.
- **nginx route on VPS:** `location /api/junctions/` proxies to `http://100.69.160.113:5001/`, in `/etc/nginx/sites-enabled/default` next to `/api/osrm-fi/`. Has `proxy_read_timeout 60s`.
- **Logs endpoint:** `GET https://mase.fi/api/junctions/logs?n=N` returns the last N events from an in-memory ring buffer (500 entries). Use this for verification — no SSH to shelly needed. Output is `{logs: [{ts, level, fields}, ...]}`.
- **In-flight dedup:** identical concurrent requests share one Overpass call (`cache.ts`'s `inflight` Map). Keep this when refactoring.
- **Exclude regex constants:** mirrored between `app.js` (`HIGHWAY_EXCLUDE_DEFAULT`/`_WINTER`) and `junctions-cache/src/overpass.ts` (`HIGHWAY_EXCLUDE.default`/`.winter`). Keep them in sync if either side changes.

## Verification recipe

```bash
# tail the live ring buffer (no shelly access needed)
curl -sN "https://mase.fi/api/junctions/logs?n=50" | python3 -c "
import json, sys
for e in json.load(sys.stdin)['logs']:
    f = e['fields']
    print(e['ts'], e['level'], ' '.join(f'{k}={v}' for k, v in f.items()))
"
```

After Step 1: generate four routes from the same Helsinki start with smart routing on. Expect `miss` once, then `hit hit hit`. Generate from a Tampere start: `miss` (different key), then hits.

After Step 2: every request should be `cache=hit` from a local lookup, with no `overpass_ms` in any entry.

## Reference: useful conversation context

- The current cache exists because Helsinki Overpass was freezing the UI for several seconds. We accepted that the FIRST request is slow but expected re-rolls to be instant. Helsinki proves that's not happening with bbox-based caching.
- The user does not run any commands on shelly — all observability needs to be reachable from the VPS. The `/logs` endpoint exists for this reason.
- All exclude lists, OSRM endpoints, etc. live at the boundaries between `app.js`, `junctions-cache/src/overpass.ts`, and `osrm-foot.service` — keep that boundary stable when refactoring.
