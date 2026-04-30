# Water-Aware Candidate Screening — Design

**Status:** Design (pre-implementation)
**Date:** 2026-04-30
**Predecessor:** `2026-04-28-self-hosted-osrm-and-overlap-filter-design.md` (the chirality + retry stack this builds on top of)

## 1. Problem

Finland is mostly lakes. Wander's destination generation produces three failure modes that the existing chirality + overlap-retry stack can't fix at the routing layer:

1. **Destination strictly in water.** The random-annulus path (`generateRandomPointAnnulus`, `app.js:361`) and the Overpass-fallback path drop candidates anywhere inside the radius — including the middle of Päijänne, Saimaa, the Bothnian Bay. OSRM `/route` to a lake-center is meaningless: it routes to the nearest road, often miles from where the user thinks they're going.
2. **Destination on land but across a large body of water.** The straight-line distance is small; the actual walking route requires a 5–10× detour around the lake. Today this manifests as a degenerate "loop" where the chirality+retry stack burns its full budget on candidates that all share the same problem (they're all on the wrong side of the same lake), then surfaces the least-bad one with a soft warning.
3. **Retry budget wasted.** With `MAX_RETRY_ATTEMPTS = 3`, the smart-routing loop can exhaust the entire budget on three water-locked picks before giving up. The retries do real OSRM work for results that were structurally hopeless from the start.

The chirality + overlap stack is the right tool for *marginal* cases (loops that mostly work but share a stretch of shoreline road). It is not the right tool for *structurally hopeless* candidates. Those should be filtered before the retry loop ever sees them.

## 2. Approach

Insert a **two-stage screening step** between candidate generation and the retry loop. Both stages are OSRM-only — no new Overpass dependency.

- **Stage 1 — reachability.** OSRM `/nearest` per candidate. If snap distance from candidate to the foot graph exceeds `STAGE1_NEAREST_MAX_M` (initial value: **500 m**), reject. This catches "point is in water" — the foot graph is dense enough across Finland that 500 m cleanly distinguishes "lake center" from "remote wilderness with paths nearby."
- **Stage 2 — detour sanity.** For stage-1 survivors, OSRM `/route` from start to candidate (no vias). Compute `routeKm / straightKm`. If the ratio exceeds `STAGE2_DETOUR_MAX` (initial value: **2.2**), reject. This catches "across a large lake" — the across-water signature is a route 3–10× longer than the straight line.

Survivors feed into the existing retry loop with their existing novelty ranking. Initial values for both thresholds are educated guesses; tuning happens during verification (Section 8). The chirality + overlap stack stays unchanged — it now operates on a higher-quality pool, so retries actually rescue marginal cases instead of papering over hopeless ones.

The random-annulus pool size grows from **5 → 15** so screening has enough survivors to pick from in lake-heavy starts. POI and roads pools stay at whatever Overpass returns (already typically larger).

This is approach **A** from the brainstorming round. Approaches B and C (peeling Overpass out of roads-mode and smart-routing junctions) are captured as deferred ideas.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ generateDestination()                                        │
│                                                              │
│   1. Resolve start (existing)                                │
│   2. Fetch candidates by mode (existing)                     │
│        - POI:   Overpass tag query                           │
│        - Roads: Overpass highway query                       │
│        - Any:   generateRandomPointAnnulus × 15  ← bumped    │
│        - Any (Overpass fallback): random annulus × 15        │
│                                                              │
│   3. Screen candidates  ← NEW                                │
│        - Stage 1: parallel /nearest, reject snap > 500 m     │
│        - Stage 2: parallel /route,   reject detour > 2.2     │
│        - Sort survivors by novelty (existing rankByNovelty)  │
│                                                              │
│   4. Retry loop (existing)                                   │
│        - operates on screened pool                            │
│        - chirality + overlap detection unchanged              │
│                                                              │
│   5. Display (existing)                                      │
└──────────────────────────────────────────────────────────────┘
```

The screening stage is the only new code path. Everything downstream of "Screen candidates" is unchanged.

## 4. Components

New file: **`screening.js`** — loaded after `bbox.js` / `novelty.js` / `loop-quality.js`, before `app.js` (matching the existing pure-helper-module pattern). Pure module, no DOM access. OSRM calls are passed in as injected functions (matches the dependency-injection pattern used by tests for `sync.js`).

Snap distance is computed inside `screening.js` using `haversineM` from `loop-quality.js` (already returns meters and matches the `STAGE1_NEAREST_MAX_M` constant's unit). The injected `nearestFn` returns the snapped point only; screening computes the distance from candidate → snap. This avoids any reliance on OSRM's response shape for distance and keeps the unit consistent across the module.

```
screening.js
  STAGE1_NEAREST_MAX_M     = 500   (constant, tunable, meters)
  STAGE2_DETOUR_MAX        = 2.2   (constant, tunable, ratio)
  RANDOM_POOL_SIZE         = 15    (constant)

  passesStage1(candidate, nearestResult)
      → boolean
        - false if nearestResult is null
        - true iff haversineM(candidate, nearestResult) ≤ STAGE1_NEAREST_MAX_M
        - precondition: caller has already attached snapM to the candidate
                         (see screenCandidates below)

  detourRatio(routeMeters, straightKm)
      → number (route_km / straight_km, or Infinity if route failed)

  screenCandidates(start, candidates, { nearestFn, routeFn })
      → { survivors, bestRejected, diagnostics }
        - nearestFn(candidate) → Promise<{lat, lng} | null>
                                  (matches existing tryNearest contract)
        - routeFn(start, candidate) → Promise<{distance: meters} | null>
                                  (subset of existing tryOsrm route response)
        - survivors:    array of candidates that passed both stages,
                         each annotated with { snapM, detour } for downstream
        - bestRejected: lowest-detour-ratio rejected candidate (or
                         smallest-snapM candidate if all stage 1 rejected),
                         used as fallback when survivors is empty
        - diagnostics:  per-candidate { stage, reason, snapM, detour }
                         for debug logging only
```

Stage 1 and stage 2 each fan out via `Promise.all` over their input pool — parallelism is intentional given self-hosted OSRM headroom. With the proposed pool sizes, worst case is 15 simultaneous `/nearest` calls and (after stage 1 filtering) up to 15 simultaneous `/route` calls per generate. This is well within the self-hosted instance's budget; no batching or sequential flow is required.

Modifications to `app.js`:

```
generateDestination():
  - bump random-annulus arrays from length 5 to RANDOM_POOL_SIZE
  - after candidatePool is set, call screenCandidates(...)
  - replace candidatePool with the screened survivors
  - if survivors is empty: use bestRejected as the only candidate,
    set a flag so the soft-warning chip text reflects "water-locked area"

Other call sites unchanged.
```

No HTML changes. No CSS changes. No new UI elements. Soft warning chip reuses the existing one but may get a second copy variant for the water-locked-area case.

## 5. Data flow

In-Finland round-trip generate, smart routing on:

```
user clicks Generate
  ↓
fetch candidates (POI/roads/random) — N candidates
  ↓
screen:
  parallel: /nearest × N        → mark stage 1 survivors
  parallel: /route   × N₁       → compute detour, mark stage 2 survivors
  sort survivors by novelty (rankByNovelty)
  ↓
retry loop (existing):
  for i in 1..min(3, |survivors|):
      build both chiralities for survivors[i]
      if overlap < 0.4: break
  ↓
display best-seen
  ↓
if survivors was empty → display bestRejected with "water-locked area" chip
if survivors non-empty but best.overlap ≥ 0.4 → existing "limited routing" chip
```

OSRM call budget per generate (typical, smart routing on, in-Finland):

| Step | Calls (today) | Calls (after) |
|---|---|---|
| Junction fetch (Overpass) | 1 | 1 |
| Stage 1 /nearest | 0 | 5–15 |
| Stage 2 /route | 0 | 0–15 |
| Retry loop /nearest (via snap) | up to 18 | up to 18 |
| Retry loop /route (4 legs × 3 attempts) | up to 12 | typically 4 (succeeds first try) |

Net: a few extra cheap probes upfront, fewer wasted full-loop retries downstream. Self-hosted OSRM has the headroom.

## 6. Error handling

| Failure | Behavior |
|---|---|
| OSRM `/nearest` 5xx or timeout for one candidate | Treat candidate as stage 1 reject (snap distance unknown — safe to skip) |
| OSRM `/nearest` 5xx for *all* candidates | Skip screening entirely for this generate; fall through to unscreened retry loop with current behavior. Don't fail the generate. |
| OSRM `/route` 5xx for one candidate (stage 2) | Treat as stage 2 reject (detour ratio unknown — safe to skip) |
| OSRM `/route` 5xx for *all* survivors | Same as above: skip stage 2, treat all stage 1 survivors as candidates, fall through to retry loop |
| All candidates rejected (zero survivors) | Use `bestRejected` as the single candidate, set water-locked-area flag for the warning chip. User still gets a route. |
| Overpass POI/roads fetch fails | Existing fallback to random-annulus path (unchanged) — random points then get screened normally |
| Out-of-Finland start | Existing `resolveStart` rejection (unchanged) — never reaches screening |

The general principle: **screening is a soft filter.** Any failure in the screening pipeline degrades gracefully to the today-behavior. Screening can never make a generate fail that would have succeeded before.

## 7. Testing

Unit tests (vitest, `tests/screening.test.js` matching existing layout):

- `passesStage1` — accepts when `haversineM(candidate, nearestResult)` ≤ threshold; rejects when over; rejects when nearestResult is null
- `detourRatio` — 1.0 for identical km, Infinity for null route, correct ratio for known fixtures
- `screenCandidates` — with mocked `nearestFn` / `routeFn`:
  - all candidates pass: returns full pool, empty bestRejected
  - all candidates stage-1 fail (lake): returns empty survivors, bestRejected = smallest-snap candidate
  - mixed stage 1/2 failures: returns correct survivor subset, bestRejected = lowest-detour candidate
  - mocked `/nearest` failure: matching candidate is rejected with diagnostic, others proceed
  - mocked `/route` failure for all: stage 2 gracefully degrades to "all stage 1 survivors are accepted"

Manual verification (the threshold-tuning step):

- Known lake-center start: pick a generate radius that puts Päijänne/Saimaa squarely in the annulus. Today: random/Overpass-fallback drops candidates in the lake. After: stage 1 rejects them all, screening surfaces the across-shore land candidates only.
- Known across-water start: a Helsinki suburb where the natural radius extends across a bay (Espoo, Lauttasaari). Today: degenerate loops common. After: stage 2 catches the across-bay candidates, retry loop succeeds on near-shore candidates.
- Known dense-urban start: Helsinki center. Should be effectively unchanged — almost everything passes both stages.
- Known wilderness start: somewhere in northern Finland with sparse paths. Verify stage 1 doesn't false-reject hiking destinations (this is where the 500 m threshold needs real numbers).
- Foreign start: still rejected by `inFinland` upstream. Sanity check, not a real test.

The threshold values **`STAGE1_NEAREST_MAX_M = 500`** and **`STAGE2_DETOUR_MAX = 2.2`** are starting points. The implementation plan should include a verification pass with real generates across these scenarios and a calibration step to tune the constants based on observed snap distances and detour ratios. If no clean threshold separates good from bad cases, that's a design feedback signal worth surfacing.

## 8. Out of scope (deferred to ideas backlog)

The brainstorming round identified two adjacent improvements that this design intentionally does not pursue:

- **B — drop Overpass from roads mode.** Replace `fetchRoadsInRadius` with random-annulus + OSRM `/nearest` snap. Loses winter-mode's "plowed roads only" filter. Captured as a separate idea.
- **C — drop Overpass from smart-routing junctions.** Use `buildLoop`'s OSRM-nearest via-snapping always; remove `fetchCorridorJunctions` and `buildJunctionLoop`. Slightly worse loop shape in dense-road areas, but immune to Overpass flakiness. Captured as a separate idea.

Also deferred:

- Static water-polygon dataset bundled with the frontend (e.g. a simplified Finnish coastline + lake-polygon GeoJSON for client-side point-in-polygon). Stricter than OSRM `/nearest` and Overpass-free, but adds bundle size and a maintenance dependency on the polygon source. The `/nearest` heuristic is good enough for the project's current scale.
- Screening-result caching across consecutive generates from the same start. The cost of re-screening is small enough that caching adds complexity without clear benefit.
- A user-visible "show me why this destination was picked" debug overlay using the diagnostics field. Possibly useful for tuning, but UI surface area not justified for a v1.
