# Public OSRM fallback + smart-routing toggle removal — design

**Date:** 2026-08-29
**Status:** approved

## 1. Problem

Shelly has been off the internet for several days and nobody is on site to fix it.
Everything Wander needs to route lives there:

| Service | Host | State |
| --- | --- | --- |
| OSRM-foot (`/api/osrm-fi/`) | shelly `100.69.160.113:5000` | unreachable |
| junctions-cache (`/api/junctions/`) | shelly `100.69.160.113:5001` | unreachable |

Measured 2026-08-29: `ping` 100% packet loss; both nginx proxies return `status=000`
after the full 15 s curl deadline.

The user-visible result is bad in three separate ways:

1. **Every generate hangs ~60 s** before anything appears. `FETCH_TIMEOUT_MS` is 20 s
   (`net.js:10`), but `buildLoop` awaits **three sequential** network stages — the
   parallel `nearest` batch, then the outbound route, then the return route
   (`osrm.js:147-152`) — and each gets its own 20 s ceiling. Smart routing adds a
   junctions fetch plus a `buildLoop` fallback on top, and the multi-candidate retry
   loop (`destination-resolve.js:169`) multiplies the whole thing again.
2. **The route is then a dashed straight line.** `tryOsrm` returns `null` on failure
   (`osrm.js:35`), so `renderRouteTail` takes its `fallbackStraight` branch
   (`route-view.js:113`) and draws start→dest as the crow flies.
3. **Nothing says so.** There is no toast on this path. Worse, the badges fabricate
   numbers: `computeRouteTotals` (`session.js:20-21`) substitutes the straight-line
   distance for a missing leg, so `distanceBadge` reads e.g. "6.2 km round trip" and
   the bike/car badges are derived from it (`route-view.js:67-73`). Only the walk
   badge hides itself, and only because duration happens to be 0.

So the app presents a confident distance, a bike time and a car time for a walk that
was never routed.

## 2. History — this fallback existed and was removed

`5abde82` (2026-04-28) added self-hosted OSRM-foot **with** a public fallback.
`1c821f3` (2026-04-29) removed the public half the next day:

> Public OSRM is no longer used in practice. […] Foreign coords now fail loudly at
> the OSRM call instead of fanning out to a throttled public service that we weren't
> really using.

That reasoning was about **foreign coordinates**, which the app no longer accepts at
all (starts outside `FINLAND_BBOX` are rejected). It was never about our own backend
going down — even though the original design specified exactly that case
(`2026-04-28-self-hosted-osrm-and-overlap-filter-design.md` §4.5: *"on
5xx/timeout/network-error → fall through to public (one-shot, throttled)"*).

Residue of the removal: `bbox.js`'s header still says "Finland bbox helpers for
routing endpoint selection", but `inFinland` is now only an input guard
(`share-link.js:66`, `location-input.js:70`). No endpoint selection remains.

Self-hosting was never about capability. Per the same design doc (line 13), the
blocker was FOSSGIS's demo being *"capped at ~1 req/sec under fair-use. Spam-retries
on a free public service are a non-starter."* Self-hosting bought **request volume**,
nothing else.

## 3. Which public server

**`https://routing.openstreetmap.de/routed-foot/` (FOSSGIS).** Verified 2026-08-29:

| Probe | Result |
| --- | --- |
| foot profile is real | 5767 m / 4615 s → **4.5 km/h** |
| …vs the same pair on `routed-car` | 6082 m / 626 s → 35 km/h (different graph, different hints) |
| `nearest` endpoint | works |
| the app's real query — 5 waypoints, `geometries=geojson&steps=true&overview=full&continue_straight=true` | `code: Ok`, 4 legs, 662 geometry coords, 16 steps in leg 0 |
| latency | ~150 ms |

`fetchRouteThrough` therefore works against it **unchanged** — only the base URL differs.

**Not `router.project-osrm.org`.** It returns byte-identical results for `foot` and
`driving` (same distance, same duration, same waypoint `hint` strings): one car graph,
profile path segment ignored. Routing walkers onto it would silently produce driving
routes — worse than the honest straight line. Recorded here so nobody reaches for it.

## 4. The constraint: request volume

The pipeline was rebuilt assuming an unmetered backend. Per **one** loop build:

| Path | OSRM calls |
| --- | --- |
| `buildLoop` (default) — `osrm.js:147-152` | 6 `nearest` snaps **fired as one parallel burst** + 2 route = **8** |
| `buildJunctionLoop` (smart) — `osrm.js:261-264` | 4 route (both chiralities) + junctions-cache lookups |

Times up to 3 candidates in the quality-retry loop → **8–24 requests per generate**.
Against ~1 req/sec fair use, pointing today's pipeline at FOSSGIS would be abusive on
the first click. A fallback has to be a *reduced pipeline*, not a swapped URL.

## 5. Design

### 5.1 Degraded public mode

Entered only when self-hosted fails. Reduces a generate to **2 requests, serialized**:

| Knob | Self-hosted | Degraded public |
| --- | --- | --- |
| via snapping (`snapToRoad`) | 6 `nearest` calls | **skipped** — geometric vias used as-is |
| chiralities | both | **one** |
| candidates / quality retries | up to 3 | **1, no retries** |
| junction snapping | yes | **skipped** |
| pacing | none | **≥1.1 s between requests, serialized** |
| total per generate | 8–24 | **2** |

Junction snapping is skipped on its own merit, not because shelly is down: when we are
not snapping vias at all, junction-snapping them is pointless, and it is more requests.

The price is honest and worth stating in the toast: **rougher loops, slower**.

### 5.2 Two layers — compliance is not allowed to depend on flag plumbing

The reduction in §5.1 spans three files, so *how* the knobs are enforced matters. Split
into two independent layers:

**Layer 1 — endpoint fallback + throttle. Per request, internal to `osrm.js`.**
`tryOsrm`/`tryNearest` fall back to the public server themselves, and every public
request goes through the serialized ≥1.1 s queue (§5.3). No caller changes, no flags.
This is what guarantees fair use, and it holds **even on the very first build after
shelly dies** — the build that discovers the outage still has non-degraded flags and
will issue its full 8 requests, but they are paced, so they are compliant. Slow, not
abusive.

**Layer 2 — pipeline reduction. Per build, an explicit flag.**
`degraded` joins the options object returned by `readRouteBuildOptions`
(`route-view.js:32`), read from `isSelfHostedDown()`, and is threaded down exactly like
`smartRouting`/`winterMode`. This matches the convention `destination-resolve.js:5`
states outright: *"mode flags (winterMode, smartRouting) are passed in, matching
route-dispatch.js."* Consumers:

| Consumer | Behaviour when `degraded` |
| --- | --- |
| `buildLoop` (`osrm.js:147-152`) | skip `snapToRoad`, use geometric vias |
| `buildJunctionLoop` (`osrm.js:256-265`) | not called at all (see below) |
| `buildRouteForDestination` (`destination-resolve.js:209`) | take the plain `buildLoop` branch, no junctions |
| `findBestLoop` (`destination-resolve.js:169`) | `retryBudget = 1` |

Layer 2 only ever makes things faster and cheaper. If it were wired wrong, the result
is a slow generate — never a fair-use breach. That separation is the point.

### 5.2.1 The latch

Lives in `osrm.js`, next to the URL constants it selects between.

- `OSRM_PUBLIC_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot'`.
- A module-scoped latch `selfHostedDownUntil` (timestamp, 0 = healthy).
- `tryOsrm` classifies its failure: fetch threw (transport) or `!res.ok` (http) sets
  the latch to `now + 5 min`; a valid 200 with no usable geometry is a genuine
  *no-route* and must **not** latch — that is a property of the destination, not the
  backend.
- While latched, calls go straight to public and skip the 20 s self-hosted timeout.
  After it expires the next call re-probes self-hosted, so recovery needs no reload.

Module-level mutable state is safe here: `withLoading` (`loading.js`) is the
one-build-at-a-time mutex, so exactly one build is ever in flight. This is stated as a
comment at the latch, because it is the assumption that makes it correct.

### 5.3 Throttle

A promise-chain queue in `osrm.js` serializes public requests with a ≥1.1 s gap.
Only public requests are queued; self-hosted keeps its current parallel burst.

### 5.4 What the user sees

- **Entering degraded mode:** one toast per **page load** (not per generate, and not
  per `currentSession` — `session-state.js`'s session is the route on screen and resets
  every generate) — backend is down, using the public server, results and speed are
  worse.
- **Both backends fail:** the existing dashed straight line, now with a warning
  saying it is a straight-line placeholder rather than a walk. This absorbs the
  standalone "no route" warning discussed before this design.
- **Badges on the straight-line path stop asserting a walk:** distance is labelled
  straight-line, and the bike/car badges hide. Fixed at the render boundary
  (`renderRouteTail`/`updateDurationBadges`), not in `computeRouteTotals` — that
  function's straight-line substitution is still correct for a *partial* result
  (round trip whose return leg alone failed).

### 5.5 Error handling

| Case | Behaviour |
| --- | --- |
| self-hosted transport/http failure | latch 5 min, fall through to public, toast once |
| self-hosted 200 + no route | no latch, no fallback — genuine no-route, warn |
| public also fails | straight line + warning |
| self-hosted recovers | latch expires, next generate is full quality, no reload |

## 6. Part 2 — delete the smart-routing toggle

Smart routing has had enough live testing and is clearly better, so it stops being a
choice and becomes the behaviour.

**The checkbox is load-bearing in a way the obvious file list misses.**
`readRouteBuildOptions` (`route-view.js:35`) does
`document.getElementById('smartRouting').checked` **unconditionally**, and three call
sites depend on it: `generate.js:57`, `spread-control.js:40`, `route-restore.js:22`.
Deleting `#smartRouting` from `index.html` without fixing that function throws
`TypeError: null.checked` on every build, every spread reroute and every shared-link
restore. `route-view.js` must be changed first, or in the same commit.

**And the real smart path is not in `route-dispatch.js`.** `generate.js` routes through
`buildRouteForDestination` (`destination-resolve.js:209`), whose
`if (tripMode !== 'one-way' && smartRouting)` gate owns the multi-candidate overlap-retry
loop — that loop *is* "smart routing" as the user experiences it.
`route-dispatch.js`'s smart branch is only reached with a real flag value from
`route-restore.js` and `spread-control.js`. A change that only touches
`generate.js`/`route-dispatch.js` would silently drop generate back to the plain
single-shot `buildLoop`.

Full surface — 6 source files, 8 test files:

- `route-view.js` — `readRouteBuildOptions` stops reading the checkbox (**do this first**).
- `index.html` — remove `#smartRouting` and its label.
- `destination-resolve.js` — drop the `smartRouting` gate at `:209`; the smart path
  becomes unconditional for round trips, keeping its existing `buildLoop` fallback.
  Note `:219` already passes `smartRouting: false` on a fallback path — that call must
  keep meaning "plain loop", so it needs an explicit replacement, not a blind deletion.
- `route-dispatch.js` — collapse the two branches of `buildRouteForMode`.
- `generate.js`, `spread-control.js`, `route-restore.js` — stop threading the flag.
- `settings.js` — remove its persistence (and leave stored values harmlessly ignored).
- Tests: `settings`, `route-dispatch`, `route-view`, `generate`, `destination-resolve`,
  `spread-control`, `route-restore`, `app`.

Degraded public mode (§5.1) still skips junctions, so the two compose: shelly down ⇒ no
junctions attempt at all, regardless of the toggle being gone.

**Kept in this doc, planned as its own task group.** Part 2 is independently motivated
and could stand alone, but it shares the junctions-vs-degraded interaction above, so
the reasoning belongs in one place. It is sequenced strictly after part 1.

Sequenced **after** part 1 so the fallback exists before smart routing loses its
escape hatch.

## 7. Testing

Frontend suite is vitest + jsdom, loaded through `tests/helpers/load.js`.

| Area | Test |
| --- | --- |
| endpoint selection | latched → public URL; unlatched → self-hosted URL |
| latch classification | transport/http failure latches; 200-with-no-route does **not** |
| latch expiry | after expiry the next call re-probes self-hosted |
| throttle | two queued public calls are ≥1.1 s apart (fake timers) |
| degraded pipeline | no `nearest` calls; one chirality; one candidate |
| toast | fires once per session on entering degraded, not per generate |
| straight-line badges | distance labelled straight-line; bike/car hidden |
| partial result | round trip with only the return leg missing keeps today's estimate |
| compliance independent of flags | a build that discovers the outage mid-flight still paces its remaining public calls, even though its `degraded` flag was false |
| toggle removal — the throw | `readRouteBuildOptions` returns options with **no** `#smartRouting` element in the DOM, for all three callers (generate, spread reroute, shared-link restore) |
| toggle removal — no silent downgrade | a round-trip generate still takes the multi-candidate `destination-resolve.js` path, not the single-shot `buildLoop` |
| toggle removal | no `#smartRouting` reference survives in JS or HTML |

Full suite via `test-suite` before commit.

## 8. Out of scope

- Reviving shelly, or any change to `deploy/shelly-osrm/`.
- Caching public results.
- A user-facing setting to force public routing.
