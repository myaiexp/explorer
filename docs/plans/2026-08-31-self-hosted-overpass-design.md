# Self-hosted Overpass on shelly + server-side candidate selection

**Date:** 2026-08-31
**Status:** approved, not yet implemented

## Problem

`overpass.js` calls `https://overpass-api.de/api/interpreter` directly from the
browser. Two costs fall out of that.

**Rate limiting.** The public instance advertises `Rate limit: 2` per IP and
sheds load globally when busy, answering with 429 or 504. After three attempts
`queryOverpass` throws `POI search is busy. Please wait a moment and try again.`
(`overpass.js:47`), and `resolveCandidatePool` degrades the walk to a random
annulus point. Nothing is cached and every browser is its own IP, so re-rolling
from the same start re-runs the identical query against a stranger's server.

**Payload.** Measured 2026-08-31 from the VPS, start `62.24,25.75` (Jyväskylä):

| query | elements | bytes | wall time |
| --- | --- | --- | --- |
| roads, 3.85 km radius (a 5 km walk) | 14,043 ways | 5.2 MB | 1.5 s |
| roads, 9.6 km radius (a 25 km walk) | 25,337 ways | 9.4 MB | 1.5 s |
| any-POI, 3.85 km radius (13 types → 26 statements) | 1,141 | 263 KB | 3.0 s |

All of it reaches the phone, which then discards everything outside the annulus
and down-samples the remainder to 45 candidates (`capPool`). Wander is used on
mobile data in rural Finland; megabytes per re-roll is the everyday cost, and it
outlives the rate-limit problem.

## Approach

Run Overpass on shelly and move POI/road candidate selection behind the existing
`junctions-cache` service, which already owns an Overpass client, retry loop,
bounded cache, per-IP rate limiting and a global outbound concurrency cap.

Rejected alternatives:

- **Interpreter proxy only** — repoint `overpass.js` at a self-hosted
  `/api/overpass/interpreter` and change nothing else. Kills the 429s, leaves the
  5–9 MB payload, and now spends VPS bandwidth on it instead of Overpass's.
- **Precompute a POI/road dataset** from the pbf already on shelly into
  SQLite/Postgres. Millisecond queries and no Overpass server, but a bespoke
  extract pipeline that freezes the query surface to today's catalog.
- **Extend `junctions-cache` without self-hosting** — cache and filter
  server-side but keep querying the public instance. Cache hits get fast, cache
  misses still 429. The failure mode relocates instead of disappearing.

Route-quality work (dead-end candidate rejection, larger candidate pools) is
explicitly **out of scope**. It wants a stable baseline to measure against, and
this change moves the baseline. Captured as ideas instead.

## Architecture

```
browser ──HTTPS──> mase.fi/api/junctions/{pois,roads,junctions}   (nginx, existing)
                        │
                   shelly:5001  wander-junctions.service  (Node, existing)
                        │  cache · annulus filter · pool cap · concurrency cap
                        ├──> 127.0.0.1:5002  wander-overpass  (docker, NEW)
                        └──> overpass-api.de                  (fallback only)
```

The container binds to loopback. `junctions-cache` runs natively on the same
host and is the only consumer, so nothing needs to cross the tailnet.

### Why the docker image

Shelly has no web server — no nginx, no apache, no fcgiwrap (verified
2026-08-31), and no `osmium`/`osmconvert`. A native osm3s install needs a source
build (no AUR package exists; `yay -Ss overpass` returns only fonts), a
`dispatcher` daemon, a CGI-capable web server, a pbf→XML conversion step
(`init_osm3s.sh` takes `.osm.bz2`, not pbf), and a bespoke re-import script with
an outage window.

`wiktorn/overpass-api` bundles the osm3s build, nginx+fcgiwrap, the dispatcher
and the Geofabrik diff updater, and is designed for regional extracts. Docker
29.7.2 is already installed on shelly.

The cost is honest: shelly runs zero containers today, so this is a new
operational surface on a box whose pattern is native systemd units. It is
accepted against maintaining a private osm3s build plus a web server on a box
that has neither.

### Data freshness

`OVERPASS_DIFF_URL=https://download.geofabrik.de/europe/finland-updates/` —
verified public, no OAuth, refreshed daily (`sequenceNumber=4897`, last modified
2026-08-31 06:29 UTC). The container applies diffs on a timer
(`OVERPASS_UPDATE_SLEEP=3600`), so there is no re-import and no outage window.

This supersedes an earlier proposal to re-import weekly from the pbf that
`osrm-refresh.timer` already downloads. Diff updates are both simpler (no atomic
swap, no staging dir, no service restart) and fresher.

Container settings that matter:

- Pin the tag: `wiktorn/overpass-api:v0.7.62.11` (newest osm3s release tag,
  image rebuilt 2026-08-01, 134 MB). Never `latest` — the image holds a
  multi-hour import, and an unpinned pull that changes the DB format on a
  restart is a re-import, not a restart.
- `OVERPASS_MODE=init`, `OVERPASS_PLANET_URL` = the Geofabrik Finland pbf,
  `OVERPASS_PLANET_PREPROCESS` = the in-container `osmium cat` pbf→bz2 conversion.
- `OVERPASS_META=no` — the public Geofabrik extract carries no metadata, and
  nothing in Wander reads changeset/user. Halves disk and import time.
- `OVERPASS_USE_AREAS=false` — Wander never issues an `area` query. Leaving area
  generation on burns background CPU forever for output nothing reads.
- `OVERPASS_STOP_AFTER_INIT=false` — the image stops after init by default;
  under systemd it must keep serving.
- Data at `/srv/overpass/db`, matching `/srv/osrm`'s placement.

## Components

### 1. `wander-overpass` (new, shelly)

`docker run` under a systemd unit, in the shape of `deploy/shelly-osrm/`:

- `deploy/shelly-overpass/wander-overpass.service`
- `deploy/shelly-overpass/install.sh` — idempotent bootstrap plus smoke test,
  mirroring `deploy/shelly-osrm/install.sh`.

Initial import runs once in the background (pbf download, osmium conversion,
index). Expect hours and a few GB against 300 GB free. The public-Overpass
fallback covers that window, so there is no user-visible downtime.

### 2. `junctions-cache` — local-first Overpass client

**This applies to `/junctions` too, not only the new endpoints.** The junction
query is the heaviest of the three (`out body; >; out skel qt;` returns full way
geometry, not centroids), so leaving it pointed at the public instance would
leave the largest query on the thing being fixed.

`src/overpass.ts` today hardcodes one target
(`OVERPASS_URL = 'https://overpass-api.de/api/interpreter'`) and one 3-attempt
retry loop, with no notion of a local endpoint. It gains:

- `OVERPASS_URL` (local, default `http://127.0.0.1:5002/api/interpreter`) and
  `OVERPASS_FALLBACK_URL` (public) from env.
- A `isLocalOverpassDown` latch mirroring `osrm.js`'s `isSelfHostedDown` —
  5-minute hold, so a dead local instance is probed once per window rather than
  on every request.
- Target-aware retry pacing. `getStatusWaitSec` parses the *public* instance's
  "Slot available after" and sleeps up to 60 s, which is the right behavior for a
  shared server and the wrong behavior for a local one. Local failures retry
  fast; only the fallback path keeps the status-probe pacing.

`MAX_CONCURRENT = 2` in `overpass-limit.ts` stays at 2. It exists to be polite to
the public instance, which the fallback path still uses, and with caching in
front a local instance never sees enough concurrent misses for 2 to bind. Raising
it would mean making the gate target-aware for no measured gain.

The three fetchers (junctions, POIs, roads) share this client. They do **not**
share query building or response parsing: junctions extract shared nodes from
full way geometry, POIs read `center` + `tags.name`, roads read `center` only.

### 3. `junctions-cache` — two new endpoints

```
POST /pois   { startLat, startLng, minKm, maxKm, types: ["cafe","park"] | "all" }
POST /roads  { startLat, startLng, minKm, maxKm, exclude: "default" | "winter" }

→ { cache: "hit" | "miss" | "coalesced", count, total, overpassMs?, candidates: [...] }
```

`/pois` candidates carry `{lat, lng, name}`; `/roads` candidates carry
`{lat, lng}` — matching what `fetchPOIsInRadius`/`fetchRoadsInRadius` return
today, so `destination-resolve.js`'s expectations are unchanged.

Three responsibilities move from client to server:

- **Annulus filter** — the `minKm ≤ d ≤ maxKm` loop currently in both fetchers.
- **Pool cap** — `capPool`'s down-sample to `SCREENING_POOL_CAP` (45). The cache
  stores the *full* filtered set and samples per request, so a cached response
  still returns a fresh random 45 rather than the same 45 forever.
- **Retry and pacing** — `queryOverpass` and its status-probe loop delete from
  the frontend entirely.

**Cache key** mirrors the existing anchored junction mode:
`(start≈100 m, ⌈maxKm⌉, typesKey | exclude)`, with min/max applied per response
from the cached superset. Re-rolls from one start hit the cache regardless of
destination or distance tweak. It inherits the existing mode's property that a
smaller `maxKm` keys separately rather than reusing a larger cached superset —
kept for consistency rather than inventing superset lookup. The same applies to
`typesKey`: a `cafe` search and an `all` search from one start each miss
independently, even though `all` is a superset of `cafe`. Deliberate — subset
lookup would need the cache to reason about catalog containment, and `all` is
the default path anyway.

Keys must be **namespaced per query kind**. Roads and junctions take the same
`exclude` presets over the same bbox but run different queries (`out center`
versus `out body; >; out skel qt;`), so a shared key would serve junction points
as road candidates. Existing junction keys are `s|lat,lng|km|exclude`; roads and
POIs need their own prefixes.

`Entry` currently holds `{ junctions: LatLng[], cachedAt }`. POI candidates carry
a `name`, so the stored point type widens to `{ lat, lng, name? }`. Keeping the
persisted field name `junctions` avoids invalidating the on-disk snapshot —
`isValidEntry` would otherwise drop every existing row on load.

**`types` takes catalog keys, never filter strings.** Accepting raw Overpass
filters from the client would turn the proxy into an arbitrary-query injection
point against our own instance. The server keeps its own copy of the POI catalog
and maps keys → filters. That makes `POI_TYPES` a twin of the frontend's exactly
as `HIGHWAY_EXCLUDE` already is, guarded by a new parity test that fails RED on
drift.

The twin count does not grow. Moving road fetching server-side deletes the
frontend's `HIGHWAY_EXCLUDE_DEFAULT`/`_WINTER` outright, leaving `junctions-cache`
their sole owner — so `tests/overpass-exclude-parity.test.js` guards nothing and
goes with them. One twin retires as one arrives.

Start coordinates stay in the POST body, never the query string (finding #7559).
Unknown or empty `types` is a 400, not a silent empty union.

### 4. Frontend

`overpass.js` shrinks to two `POST /api/junctions/{pois,roads}` calls through
`fetchWithTimeout`. `queryOverpass`, the status probe, `HIGHWAY_EXCLUDE_*` and
the element-shaping loops all move server-side or delete.

`destination-resolve.js` keeps calling `capPool` on the returned pool. It is a
no-op once the server caps, but the OSRM `/table` fan-out it bounds is a *client*
cost, and the client should bound its own cost regardless of what a server sends.
`screening.js` stays the owner of `SCREENING_POOL_CAP`.

`tests/helpers/load.js` `SCRIPT_DEPS` lists `'overpass': ['net', 'geo-utils']`.
Once `bboxAround`/`haversineKm` move server-side, `geo-utils` is dead weight
there. That file has a reverse-completeness check, so a stale edge is a test
failure, not silent drift — the entry becomes `['net']`.

CSP drops `https://overpass-api.de` from `connect-src` in
`deploy/nginx-explorer.conf`. `tests/nginx-security.test.js` derives that
allowlist from the source, so it enforces the removal rather than merely
permitting it.

### 5. Default destination type

`any POI` becomes the default instead of `location (anywhere)`, which produces
the wildest routes.

**Why this ships with the infra change rather than separately.** It is a UX
change, and it was requested alongside this work — but it is also the one UX
change that depends on it. `any` is the only destination type that issues *no*
Overpass query at all; making `any_poi` the default converts every default-path
generate from zero Overpass calls into one, and `any_poi` is the most expensive
query in the catalog (a 26-statement union, measured at 3.0 s). Making it the
default against the public instance would have made "busy" strictly more likely.
It is safe to do precisely because the query is about to become local and cached.

Reordering `populateLocationTypeSelect` so `any_poi` is added first only helps
new users: `settings.js` restores `poiType` with `skipEmpty: true`, so an
existing saved `'any'` survives and nothing visibly changes. So the change is
reorder **plus** a one-time migration rewriting a stored `poiType === 'any'` to
`'any_poi'`, guarded by a flag so it fires exactly once — anyone who then
deliberately re-picks "anywhere" keeps it.

## Data flow

A round-trip generate for `any POI`, cold cache:

1. `generate.js` reads the form → `routingStrategy: 'any_poi'`, `straightMax = maxKm / ROUND_TRIP_SCALE`.
2. `resolveCandidatePool` → `fetchPOIsInRadius` → `POST /api/junctions/pois` with `types: "all"`.
3. nginx (`/api/junctions/`, `limit_req zone=api`) → shelly:5001.
4. `junctions-cache` misses, takes an outbound slot, queries `127.0.0.1:5002`
   for `start ± ⌈maxKm⌉`, caches the full set, filters to the annulus, samples 45.
5. Client receives ~45 candidates (kilobytes), runs novelty ranking, water
   screening via OSRM `/table`, then the junction loop build.

Cache hit skips steps 4's Overpass call. Local Overpass unreachable → the
fallback latch sends step 4 to `overpass-api.de` instead.

## Error handling

**Local Overpass down.** `junctions-cache` latches `isLocalOverpassDown` for 5
minutes and retries against `overpass-api.de` with the existing status-probe
pacing — the same shape as `osrm.js`'s `isSelfHostedDown`. Clients see no
difference.

**Both down.** The endpoint returns the existing 502 `POI search is busy. Please
try again.` `resolveCandidatePool`'s existing catch turns that into the random
annulus pool with the "Overpass unavailable, using random point…" progress
message. No new client-side branch.

**Empty result.** A successful query matching nothing returns `candidates: []`
and 200. The client's existing empty-pool branch ("No matching places found
nearby") handles it — distinct from the failure branch, as today.

**Bad request.** Unknown POI key, missing start/radius, or a malformed body is a
400 with a reason. The client treats it like any other failure.

**Import in progress.** Before the first import completes, the container answers
nothing useful; the fallback latch routes to public Overpass for the whole
window.

## Testing

**`junctions-cache`** — new endpoint tests in the shape of the existing
`post-junctions.test.ts`: param validation (unknown key, missing start,
malformed body), annulus filtering, cap sampling (randomized, not first-N),
cache key derivation and hit/miss/coalesced accounting, and the fallback latch
(local 5xx → public, latch expiry).

**Frontend** — `tests/overpass.test.js` loses the retry-loop tests (that logic
moved server-side; equivalents live in `junctions-cache`) and gains tests pinning
the POST body shape and the response→pool mapping.
Three frontend test files die with the code they cover:
`tests/overpass-parse.test.js` (13 tests over element extraction, the annulus
filter and query assembly — ported into the `junctions-cache` pool tests, not
lost), `tests/overpass-exclude-parity.test.js` (its twin ceases to exist), and
the `tests/helpers/overpass-fetch.js` harness they share. A new
`tests/poi-catalog-parity.test.js` guards the catalog twin.

`tests/nginx-security.test.js` needs two edits, not zero: it asserts
`csp).toMatch(/https:\/\/overpass-api\.de/)` directly, and its anti-vacuity
check asserts `hostsIn('overpass.js')).toContain('overpass-api.de')`. Both fail
once the frontend stops calling that host. The first is deleted; the second
re-anchors on a module that still fetches a third party (`elevation.js` →
`api.open-meteo.com`), so the scan keeps proving it can see real hosts.

Settings tests cover the one-time `any` → `any_poi` migration and that it does
not re-fire.

**Live verification** — generate a route for each destination type against the
deployed stack and confirm payload sizes drop from megabytes to kilobytes,
`cache: "hit"` on a re-roll from the same start, and that stopping the container
transparently falls back to public Overpass.

## Deferred

Filed as ideas, not built here:

- Dead-end candidate rejection using local road connectivity, now that Overpass
  queries are unmetered.
- Larger candidate pools / higher retry budgets, same reason.
- Whether `SCREENING_POOL_CAP` should still be 45 when the pool is server-chosen.
