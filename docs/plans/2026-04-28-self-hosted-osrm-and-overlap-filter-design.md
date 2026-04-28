# Self-Hosted OSRM + Overlap Filter — Design

**Status:** Design (pre-implementation)
**Date:** 2026-04-28
**Phases:** Two implementation plans land sequentially. Phase 1 is infra (no user-visible change). Phase 2 ships the route-quality improvement that Phase 1 unlocks.

## 1. Problem

Wander generates round-trip loops by routing two legs through geometric envelope vias (`buildLoop`, `app.js:532`). When the destination sits across or near a body of water — which is everywhere in Finland — the two legs collapse onto the same shoreline road. The "loop" becomes a degenerate out-and-back wearing loop clothing.

There is no in-place fix at the routing layer: when the destination is across a lake, no via tweak rescues it. The fix has to operate one level up — **route quality has to be measured and bad results have to be rejected, with re-pick from a candidate pool.** That requires routing more than once per generate.

The blocker is `routing.openstreetmap.de/routed-foot/...` — FOSSGIS's OSRM demo, capped at ~1 req/sec under fair-use. Spam-retries on a free public service are a non-starter.

A stale comment at `app.js:502` claims `buildLoop` "tries both chiralities (right-then-left vs left-then-right), picks least overlap." It does not — only one chirality is built. Wiring up what the comment promises is a separate near-free win that becomes a free win once we have the overlap-detection plumbing.

## 2. Approach

**Phase 1 — self-host OSRM-foot for Finland on shelly.** Removes the request-rate ceiling for Finland-bbox traffic (which is ~all real usage). Foreign traffic falls back to the public API with the existing throttle.

**Phase 2 — overlap detection + chirality + N-candidate retry.** Routing is now cheap, so:

1. For each generate, try **both chiralities** of `buildLoop`. Pick the lower-overlap one.
2. If the chosen result still exceeds an overlap threshold, **re-pick destination** from the already-fetched POI candidate pool and route again. Repeat up to a fixed budget.
3. If the budget is exhausted with all candidates degenerate, surface the *least-bad* result with a soft warning ("this area has limited routing options"). No error.

**Crucially, retries reuse already-fetched data.** Overpass POI/junction queries are not repeated — we already pull 5+ POI candidates in `pickMostNovelDestination`, retries pick a different one from that pool. Self-hosting changes the OSRM budget; Overpass remains unchanged.

## 3. Phase 1 — Self-hosted OSRM-foot

### 3.1 Hosting

| Layer | Choice |
| --- | --- |
| Machine | shelly (62 GB RAM, 339 GB free, Tailscale `100.69.160.113`) |
| Path | `/srv/osrm/finland/` |
| Engine | OSRM (existing API match — no frontend rewrite) |
| Pipeline | MLD (`osrm-extract -p foot.lua` → `osrm-partition` → `osrm-customize`) |
| Service | `osrm-foot.service` running `osrm-routed --algorithm mld` on `100.69.160.113:5000` (Tailscale only, not publicly bound) |
| User | dedicated `osrm` system user |

OSM data: Geofabrik Finland extract (`finland-latest.osm.pbf`, ~700 MB). Processed footprint ~5 GB on disk, ~2–4 GB RAM at runtime. Trivial on shelly.

**Why OSRM over Valhalla?** Drop-in API match — no changes to `fetchRouteThrough`, `snapToRoad`, or the OSRM-step→FIT-course pipeline. Valhalla would be a better long-term fit (lighter, walking-aware costing) but the migration cost isn't justified for a single-region instance.

### 3.2 Refresh

Weekly systemd timer (`osrm-refresh.timer`, fires Sunday 03:00 local):

1. Download fresh `finland-latest.osm.pbf` from Geofabrik
2. Run extract → partition → customize into a timestamped staging dir under `/srv/osrm/finland/processed/<UTC-timestamp>/`
3. On success, atomic-swap by `ln -sfn <UTC-timestamp> /srv/osrm/finland/processed/current` (symlink rewrite is atomic on Linux). `osrm-foot.service` reads from the `current` symlink path.
4. `systemctl restart osrm-foot`
5. Garbage-collect: keep the most recent 2 timestamped dirs, delete older ones

If any step fails, abort before the symlink swap. Existing instance keeps running on stale data; failure is logged. Geofabrik publishes daily but weekly is enough for walking — graphs don't shift week-over-week.

### 3.3 Exposure

VPS nginx adds a new location block:

```
location /api/osrm-fi/ {
    proxy_pass http://100.69.160.113:5000/;
    add_header Access-Control-Allow-Origin * always;
}
```

Matches the existing `/api/poe/trade/` and `/api/poe/crafting/` patterns. No new cert work.

### 3.4 No public bind

`osrm-routed` binds to the Tailscale IP, not `0.0.0.0`. Public reach is exclusively through nginx. UFW is unchanged — Tailscale traffic uses the existing `tailscale0` allowlist.

## 4. Phase 2 — Overlap filter + chirality + retry

### 4.1 Overlap metric

Function: `loopOverlapFraction(outbound, ret)` → `[0, 1]`.

For each point on `outbound.coords`, find the nearest point on `ret.coords` (haversine). Count the fraction of points where that nearest-distance is below `OVERLAP_PROXIMITY_M` (default 25 m). Repeat with legs swapped (in case lengths differ). Return the **max** of the two fractions.

Naïve O(n·m) is fine — coords arrays are typically 100–500 points. If profiling later shows it's hot, swap in a grid index.

Default threshold: `OVERLAP_BAD_THRESHOLD = 0.4` (40 %). Tunable. Lower = stricter.

### 4.2 Chirality

`buildLoop` currently builds:

```
A → right_vias → B → left_vias_reversed → A
```

Add the mirror:

```
A → left_vias → B → right_vias_reversed → A
```

Build both in parallel (4 OSRM calls instead of 2). Compute overlap for each. Return the lower-overlap one. Same change in `buildJunctionLoop`.

This alone fixes some lake-collapse cases — the side that's water-blocked in one chirality may have land in the other.

### 4.3 N-candidate retry

`generateDestination` (`app.js:~1180`) currently picks 1 of 5 candidates via `pickMostNovelDestination`, then routes that one. Replace with:

```
attempt 1: pick most-novel candidate, build loop (both chiralities)
            → if overlap < threshold, done
attempt 2: pick next-most-novel unused candidate, build loop
            → if overlap < threshold, done
... up to MAX_RETRY_ATTEMPTS (default 3)
fallback:  return the lowest-overlap result seen across all attempts
            with soft warning chip
```

POI fetch happens **once**. Junction-corridor fetch (smart-routing path) also happens once and is cached for the whole retry sequence — `buildJunctionLoop` already accepts `cachedJunctions`.

Budget at default settings:
- 3 candidates × 2 chiralities = 6 OSRM-route calls per generate (worst case)
- 6 OSRM-nearest calls (once, shared)
- 1 Overpass POI call (unchanged)
- 1 Overpass junction call if smart-routing (unchanged)

Self-hosted easily handles 6 routes; the public fallback would not — see 4.5.

### 4.4 Geographic gating

```js
const FINLAND_BBOX = { minLng: 19.0, maxLng: 32.0, minLat: 59.0, maxLat: 71.0 };

function inFinland(lat, lng) {
    return lat >= FINLAND_BBOX.minLat && lat <= FINLAND_BBOX.maxLat &&
           lng >= FINLAND_BBOX.minLng && lng <= FINLAND_BBOX.maxLng;
}
```

If start AND destination are both in-bbox → use self-hosted, full retry budget, no throttle.
Otherwise → use public, **retry budget = 0** (just route once, accept what we get), keep existing `requestDelay` throttle. Foreign users get today's behavior; no regression, no abuse of the public service.

### 4.5 Fallback

`fetchRouteThrough` and `snapToRoad` gain an internal try-self-hosted-first wrapper for in-bbox calls:

```
if (inFinland) {
    try selfHosted
    on 5xx/timeout/network-error → fall through to public (one-shot, throttled)
}
else {
    public (existing path, throttled)
}
```

A self-hosted failure during a retry sequence does not exhaust the retry budget — it's transparent. But it does flip subsequent calls in the same sequence to throttled-public for safety, since we're now competing with everyone else.

**Signal mechanism:** a closure-scoped `selfHostedDegraded` boolean inside `generateDestination`. Set by the wrapper on first self-hosted failure for that generate; checked at the top of every subsequent route/nearest call in the same sequence. Reset implicitly when the next generate begins (new closure). No module-level mutable state — concurrent generates (rare but possible via rapid re-clicks) don't poison each other's sequences.

### 4.6 No new UI

Phase 2 is invisible by default — better routes for the same generate. The "soft warning chip" for exhausted retries reuses the existing toast/notification mechanism in `app.js`. No new toggle, no settings entry.

## 5. Components

```
shelly:
  /srv/osrm/finland/
    pbf/finland-latest.osm.pbf
    processed/foot.osrm.*               ← active
    staging/                            ← refresh writes here, atomic swap
  /etc/systemd/system/
    osrm-foot.service                   ← runs osrm-routed
    osrm-refresh.service                ← oneshot refresh script
    osrm-refresh.timer                  ← weekly
  /usr/local/bin/osrm-refresh.sh        ← refresh logic

VPS:
  /etc/nginx/sites-enabled/default      ← +location /api/osrm-fi/

explorer (frontend):
  app.js
    OSRM_FI_BASE constant
    inFinland() helper
    fetchRouteThrough() — bbox-gated, fallback path
    snapToRoad()        — bbox-gated, fallback path
    buildLoop()         — both chiralities, returns lower-overlap
    buildJunctionLoop() — both chiralities, returns lower-overlap
    loopOverlapFraction() — new util
    generateDestination() — N-candidate retry loop
```

## 6. Data flow (Phase 2, in-Finland generate)

```
user clicks Generate
  ↓
fetch POIs from Overpass (1 call)
  ↓
candidates = pickRanked(pois)        ← all 5, ranked by novelty
  ↓
for attempt in 1..MAX_RETRY_ATTEMPTS:
    dest = candidates[attempt-1]
    [snapped vias for both chiralities]
    [route 4 legs in parallel via self-hosted OSRM]
    overlap_a = loopOverlapFraction(legA_out, legA_ret)
    overlap_b = loopOverlapFraction(legB_out, legB_ret)
    best = lower(a, b)
    track best-seen-so-far across attempts
    if best.overlap < threshold:  break
display(best-seen)
if best-seen.overlap >= threshold: show soft warning chip
```

## 7. Error handling

| Failure | Behavior |
| --- | --- |
| Self-hosted OSRM 5xx / timeout | Transparent fallback to public for that call; subsequent calls in same sequence go throttled-public |
| Self-hosted refresh fails | Existing instance keeps running on stale data; logged to journal |
| All retry candidates degenerate | Display lowest-overlap result with soft warning chip |
| Out-of-Finland generate | Single-shot public route, existing throttle, no retry, no overlap check (matches today) |
| Overpass fails | Existing fallback (`generateRandomPointAnnulus`) — unchanged |

## 8. Testing

**Phase 1:**
- After deploy, curl `https://mase.fi/api/osrm-fi/route/v1/foot/24.94,60.17;24.95,60.18?overview=full` → 200 + valid OSRM JSON. (URL profile is `foot` since this is a fresh deploy and we control the convention; OSRM doesn't validate the path-profile against the loaded Lua profile, but using `foot` here is clearer than the `driving`-as-default historical quirk that FOSSGIS still uses.)
- Manual: routing.openstreetmap.de version of same call (which uses `/route/v1/driving`) returns equivalent geometry (sanity)
- After refresh timer fires once, verify journal shows success and `osrm-foot.service` was restarted
- Disk usage stays under 10 GB on shelly

**Phase 2:**
- Unit test `loopOverlapFraction()` with synthetic fixtures: identical polylines → 1.0; opposite-direction parallel offset 10 m → 1.0; opposite-direction parallel offset 100 m → ~0.0; perpendicular crossing → near 0.0
- Unit test `inFinland()` boundary cases (Helsinki yes, Stockholm no, Mariehamn yes)
- Manual: known lake-collapse start/dest pair in Päijänne / Saimaa region — before: degenerate loop; after: either passes (different chirality) or retry picks better destination
- Manual: foreign generate (e.g. start in Stockholm) → public path used, no retries, behavior unchanged from today
- Manual: simulate self-hosted-down by stopping `osrm-foot.service` → verify in-Finland generate falls back transparently and still produces a route

## 9. Out of scope

- **Self-hosting Overpass.** Captured as a separate idea. Planet-scale data, much bigger lift. Not on the critical path — Overpass slot-based limits are gentle for our 1–2 calls per generate.
- **Valhalla migration.** Captured as a separate idea. Better engine for walking, but API-incompatible — defer until/unless we need planet-wide self-hosted routing.
- **Coverage beyond Finland.** Sweden + Norway + Estonia would be nice for Nordic-cross-border routes. Currently no real usage signal. Defer.
- **User-facing "loop quality" indicator.** Could surface the overlap score in UI for transparency. Defer until Phase 2 ships and we see if it's useful.
