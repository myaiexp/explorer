# Phase 2 — Loop-Quality Filter (Overlap + Chirality + N-Retry) — Implementation Plan

**Goal:** Detect degenerate loops (outbound and return collapse onto the same shoreline road, typically near lakes) and reject them by trying both chiralities and re-picking from a ranked POI candidate pool. Surface a soft warning when no acceptable loop is found. **All Phase 2 changes are gated behind the existing smart-routing toggle** — when smart routing is OFF, behavior is exactly as it is today (single-chirality `buildLoop`, single attempt, no overlap detection, no warning). This isolation lets the original generation path keep working while we iterate on the improved one.

**Architecture:** Three additions on top of Phase 1, all reachable only via the smart-routing branch in `generateDestination`. (1) A pure utility `loopOverlapFraction(outboundCoords, returnCoords)` that measures geometric overlap between two polylines as a `[0, 1]` fraction. (2) `buildJunctionLoop` builds both chiralities in parallel (when in Finland) and returns the lower-overlap one, exposing the score. **`buildLoop` is NOT modified** — it remains the un-touched fallback used by the non-smart-routing path and by `buildJunctionLoop`'s internal Overpass/OSRM-failure fallback. (3) The smart-routing branch of `generateDestination` ranks POI candidates by novelty (via a new `rankByNovelty` helper added alongside the existing untouched `pickMostNovelDestination`), builds loops in order, and retries up to `MAX_RETRY_ATTEMPTS` times if overlap exceeds threshold, falling back to the best-seen result with a soft warning if all attempts are degenerate.

**Tech Stack:** Vanilla JS in `app.js`, new pure-helper file `loop-quality.js` (mirrors the `bbox.js` pattern), vitest+jsdom for tests. No backend or infra changes.

**Spec reference:** `docs/plans/2026-04-28-self-hosted-osrm-and-overlap-filter-design.md`, sections 4.1–4.6. Note: the spec describes Phase 2 as a global change; this plan deliberately scopes it tighter — gated behind the smart-routing toggle so the original `buildLoop` path stays a stable comparison baseline during iteration.

**Phase 1 line numbers** (post-`d0c3123`): bbox helpers in `bbox.js`; `OSRM_*` constants at `app.js:469`; `tryOsrm`/`tryNearest` at 483/533; `fetchRouteThrough`/`snapToRoad` at 501/545; `buildLoop` at 562 (UNTOUCHED in Phase 2); `buildJunctionLoop` at 643; `pickMostNovelDestination` at 362 (UNTOUCHED in Phase 2 — `rankByNovelty` is a pure addition); `generateDestination` at 1155 (only the smart-routing branch is modified).

---

## File Structure

```
explorer repo:
  loop-quality.js                ← new: pure helpers (overlap + constants), like bbox.js
  novelty.js                     ← new: pure helpers (rankByNovelty + minDistanceToExisting
                                   + shuffleInPlace), like bbox.js — testable in isolation
                                   without loading app.js
  index.html                     ← modify: <script src="loop-quality.js"> AND
                                   <script src="novelty.js"> before app.js, after bbox.js
  app.js                         ← modify ONLY:
                                   - buildJunctionLoop (both-chirality success path
                                     + viasLeftReturn → viasLeft rename)
                                   - ADD pickBetterLoop helper (used by buildJunctionLoop)
                                   - smart-routing branch of generateDestination
                                     (retry loop + warning chip)
                                   - ADD candidatePool capture alongside existing
                                     pickMostNovelDestination call sites
                                   - ADD showWarning UI primitive (or reuse existing)
                                   - buildLoop, pickMostNovelDestination,
                                     non-smart-routing branch, one-way branch UNTOUCHED
  tests/loop-quality.test.js     ← new: unit tests for loopOverlapFraction
  tests/rank-by-novelty.test.js  ← new: unit tests for ranking
```

No new files outside the explorer repo. No deploy artifacts changed.

`novelty.js` is loaded after `bbox.js` (so it can use `calculateDistance`-style helpers if needed) but before `app.js`. If `calculateDistance` is currently a function defined in `app.js` and is NOT in `bbox.js`, the implementer has two options: (a) move `calculateDistance` into a new shared helper file, or (b) keep `calculateDistance` in `app.js` and embed a haversine inside `novelty.js` (already needed in `loop-quality.js` as `haversineM`, so this is a 4-line copy or a third-shared-file). Either is fine. The contract is what matters.

---

## Task 1: `loop-quality.js` — overlap utility and constants

**Files:**
- Create: `loop-quality.js`
- Modify: `index.html` (add `<script src="loop-quality.js">` BEFORE `app.js`, AFTER `bbox.js`)
- Create: `tests/loop-quality.test.js`

**Why a separate file:** Same rationale as `bbox.js` in Phase 1 — pure helpers stay testable in isolation without faking Leaflet/DOM. Keeps the testable surface clean.

**Contracts:**

`loop-quality.js` — non-module browser script. Sets `window.loopOverlapFraction`, `window.OVERLAP_PROXIMITY_M`, `window.OVERLAP_BAD_THRESHOLD`, `window.MAX_RETRY_ATTEMPTS`. Pure JS, no DOM access, no other globals required.

```js
// Loop-quality utilities for detecting degenerate round-trips.
// Loaded after bbox.js, before app.js.

// Default 25 m: tight enough to require both legs to truly share roads
// (sub-block separation passes), loose enough that GPS-jitter-style
// minor coordinate differences still register as overlap.
const OVERLAP_PROXIMITY_M = 25;

// 40% — chirality alone fixes most marginal cases; >0.4 means the legs
// are sharing nearly half their length, which is the lake-collapse signal.
const OVERLAP_BAD_THRESHOLD = 0.4;

// 3 candidates: deepest novel candidate is usually the best-shape POI
// in the area; if none of the top 3 work, area is structurally bad.
const MAX_RETRY_ATTEMPTS = 3;

// Haversine in meters between two [lat, lng] points (matching the
// existing app.js coord shape produced by tryOsrm).
function haversineM(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// For each p in `from`, count it as "near" if ANY q in `to` is within
// OVERLAP_PROXIMITY_M. Returns the fraction of near points. Naïve O(n*m) —
// coords are 100–500 points typically, fine without spatial indexing.
//
// Early-exit note: the inner loop tracks `best` (running min distance) and
// breaks the moment `best < OVERLAP_PROXIMITY_M`. This is a perf
// optimization, not a correctness shortcut: the metric is the BINARY
// "is p near anywhere in to?" — once we find ONE q within proximity, the
// answer is yes and we can stop. We don't need the true minimum distance.
// Because `best` is monotonically decreasing, a break implies the
// post-loop check `best < OVERLAP_PROXIMITY_M` is true and the point is
// counted; no break implies no q within proximity was ever encountered.
function _directionalOverlap(fromCoords, toCoords) {
    if (!fromCoords || !toCoords || fromCoords.length === 0) return 0;
    let near = 0;
    for (const p of fromCoords) {
        let best = Infinity;
        for (const q of toCoords) {
            const d = haversineM(p, q);
            if (d < best) best = d;
            if (best < OVERLAP_PROXIMITY_M) break;
        }
        if (best < OVERLAP_PROXIMITY_M) near++;
    }
    return near / fromCoords.length;
}

// Symmetric overlap: max of A→B and B→A directional fractions.
// Returns 0 if either leg is empty/missing (degenerate input is treated
// as "no overlap detectable", not "perfect overlap" — the caller should
// already have null-checked the routes).
function loopOverlapFraction(outboundCoords, returnCoords) {
    if (!outboundCoords?.length || !returnCoords?.length) return 0;
    const a = _directionalOverlap(outboundCoords, returnCoords);
    const b = _directionalOverlap(returnCoords, outboundCoords);
    return Math.max(a, b);
}
```

`index.html` change:

```html
<!-- existing -->
<script src="bbox.js?v=..."></script>
<!-- new -->
<script src="loop-quality.js?v=..."></script>
<!-- existing -->
<script src="app.js?v=..."></script>
```

(Cache-buster substitution per existing build — matches bbox.js pattern.)

**Test Cases (`tests/loop-quality.test.js`):**

Load `loop-quality.js` only (not `app.js`) using the same browser-script-loading pattern as `tests/sync.test.js` / `tests/in-finland.test.js`. Pure helpers, no DOM. Tests:

```js
import { describe, test, expect } from 'vitest';
// (loading boilerplate per tests/sync.test.js)

describe('loopOverlapFraction', () => {
    test('identical polylines → 1.0', () => {
        const path = [[60.17, 24.94], [60.18, 24.95], [60.19, 24.96]];
        expect(loopOverlapFraction(path, path)).toBeCloseTo(1.0, 2);
    });

    test('opposite-direction same path → 1.0 (degenerate out-and-back)', () => {
        const out = [[60.17, 24.94], [60.18, 24.95], [60.19, 24.96]];
        const ret = [...out].reverse();
        expect(loopOverlapFraction(out, ret)).toBeCloseTo(1.0, 2);
    });

    test('parallel offset 100 m → near 0', () => {
        // ~100 m north offset (1° lat ≈ 111 km, so 100 m ≈ 0.0009°)
        const out = [[60.17, 24.94], [60.18, 24.94], [60.19, 24.94]];
        const ret = [[60.1709, 24.94], [60.1809, 24.94], [60.1909, 24.94]];
        expect(loopOverlapFraction(out, ret)).toBeLessThan(0.05);
    });

    test('partial overlap (half-shared) → ~0.5', () => {
        // First half identical, second half offset 200 m
        const out = [
            [60.17, 24.94], [60.18, 24.95],
            [60.19, 24.96], [60.20, 24.97],
        ];
        const ret = [
            [60.20, 24.97], [60.19, 24.96],     // shared (reversed)
            [60.1818, 24.95], [60.1718, 24.94], // offset ~200 m north
        ];
        const overlap = loopOverlapFraction(out, ret);
        expect(overlap).toBeGreaterThan(0.4);
        expect(overlap).toBeLessThan(0.7);
    });

    test('empty outbound → 0', () => {
        expect(loopOverlapFraction([], [[60, 24]])).toBe(0);
    });

    test('null returns → 0', () => {
        expect(loopOverlapFraction(null, [[60, 24]])).toBe(0);
        expect(loopOverlapFraction([[60, 24]], null)).toBe(0);
    });

    test('asymmetric leg lengths still report max', () => {
        // Long outbound, short return that exactly retraces beginning of outbound
        const out = Array.from({length: 20}, (_, i) => [60.17 + i*0.001, 24.94]);
        const ret = out.slice(0, 5).reverse();
        const overlap = loopOverlapFraction(out, ret);
        // ret→out is fully covered (1.0); out→ret is only ~25% covered.
        // Max is 1.0.
        expect(overlap).toBeCloseTo(1.0, 1);
    });
});
```

**Constraints:**
- `loop-quality.js` must load AFTER `bbox.js` and BEFORE `app.js` in `index.html`. Constants and `loopOverlapFraction` are referenced as bare names from app.js.
- Constants are tunable via top-of-file edit. Don't expose them through UI in this phase — defaults are good enough (per Phase 2 design: "tune at implementation," meaning post-deploy if needed).
- Coords format matches what `tryOsrm` already produces: `[[lat, lng], ...]`. Don't accept GeoJSON `[lng, lat]` order — that mismatch would be a silent bug.

**Verification:**
```bash
pnpm vitest run tests/loop-quality.test.js
```

**[Mode: Direct]**

**Commit after passing.**

---

## Task 2: Both-chirality `buildJunctionLoop` (smart-routing only)

**Files:**
- Modify: `app.js` (buildJunctionLoop at 643 only — `buildLoop` at 562 stays untouched)

**Contracts:**

`buildJunctionLoop` gains a both-chirality success path. When start AND dest are in Finland (cheap self-hosted calls), build the mirror chirality in parallel and return the lower-overlap one with `overlap` exposed. Outside Finland, behavior matches Phase 1 single-chirality (overlap still computed and returned for the warning chip — it's a local computation, free).

**`buildLoop` is explicitly NOT modified.** It stays as it is today (single-chirality, no overlap field on the return value). It is reached:
- From the non-smart-routing branch of `generateDestination` — preserves today's UX exactly.
- From `buildJunctionLoop`'s internal fallback when Overpass or both OSRM legs fail — preserves today's degraded-fallback behavior.

This means `buildLoop`'s return shape is unchanged: `{ outbound, return }` (no `overlap`). Callers that consume buildLoop directly don't need to know about Phase 2.

### Required rename in `buildJunctionLoop`

The current code at app.js:652 builds `viasLeftReturn = viaTs.slice().reverse().map(...)` (left vias in REVERSED `t` order). For the both-chirality logic to work, this must change to `viasLeft = viaTs.map(...)` (forward `t` order, matching `viasRight`). Reversal moves to call time via `.slice().reverse()` on whichever leg uses it. Without this rename, the left-chirality outbound leg in the both-chirality path would silently feed already-reversed vias as if they were forward-order, producing wrong geometry.

```js
// REPLACE the existing left-vias construction (currently at app.js:652
// using `viasLeftReturn = viaTs.slice().reverse().map(...)`) with this
// forward-order construction matching the right side:
const viasRight = viaTs.map(t =>
    envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
const viasLeft = viaTs.map(t =>
    envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
```

### `pickBetterLoop` helper (new, defined alongside `buildJunctionLoop`)

```js
// Helper: pick lower-overlap of two candidate (outbound, return) pairs.
// Falls back gracefully if one chirality fully failed. Used only by
// buildJunctionLoop's both-chirality success path.
function pickBetterLoop(outA, retA, outB, retB) {
    const aOk = outA && retA;
    const bOk = outB && retB;
    if (aOk && bOk) {
        const ovA = loopOverlapFraction(outA.coords, retA.coords);
        const ovB = loopOverlapFraction(outB.coords, retB.coords);
        return ovA <= ovB
            ? { outbound: outA, return: retA, overlap: ovA }
            : { outbound: outB, return: retB, overlap: ovB };
    }
    if (aOk) {
        const ovA = loopOverlapFraction(outA.coords, retA.coords);
        return { outbound: outA, return: retA, overlap: ovA };
    }
    if (bOk) {
        const ovB = loopOverlapFraction(outB.coords, retB.coords);
        return { outbound: outB, return: retB, overlap: ovB };
    }
    return { outbound: null, return: null, overlap: null };
}
```

### `buildJunctionLoop` success path

```js
const tryBoth = inFinland(startLat, startLng) && inFinland(destLat, destLng);

if (tryBoth) {
    onProgress('Building both chiralities…');
    const [outA, retA, outB, retB] = await Promise.all([
        fetchRouteThrough([A, ...snappedRight, B]),
        fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
        fetchRouteThrough([A, ...snappedLeft, B]),
        fetchRouteThrough([B, ...snappedRight.slice().reverse(), A]),
    ]);
    const picked = pickBetterLoop(outA, retA, outB, retB);
    if (!picked.outbound || !picked.return) {
        // Fall back to the un-touched buildLoop (no overlap field)
        const loop = await buildLoop(startLat, startLng, destLat, destLng);
        return { outbound: loop.outbound, return: loop.return, overlap: null, junctions };
    }
    return { ...picked, junctions };
}

// Single-chirality (foreign) path — current Phase 1 behavior plus an
// overlap calculation for the warning chip:
onProgress('Building outbound route…');
const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
onProgress('Building return route…');
const ret = await fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]);
if (!outbound || !ret) {
    const loop = await buildLoop(startLat, startLng, destLat, destLng);
    return { outbound: loop.outbound, return: loop.return, overlap: null, junctions };
}
const overlap = loopOverlapFraction(outbound.coords, ret.coords);
return { outbound, return: ret, overlap, junctions };
```

**Constraints:**
- Both chiralities use the SAME snapped vias. Snap step is once, not per chirality. Different chirality only changes the *order* and *side assignment*, not the snap targets.
- `buildJunctionLoop`'s return shape grows an `overlap` field (number or null). Callers must accept null. The retry loop in Task 3 handles null correctly (treats as worst-case).
- The fallback path through `buildLoop` returns `{outbound, return}` from buildLoop, which we wrap with `overlap: null, junctions`. This preserves the today's-buildLoop behavior on the fallback path while keeping the return shape consistent.
- `buildLoop` is NOT touched. Do not refactor it. Do not add an `overlap` field. Leave the file region around app.js:562-585 unchanged. (Verification step below explicitly checks this.)
- Mode A change at the integration level — single-file, well-defined replacements.

**Test Cases:**

No new automated tests for `buildJunctionLoop` orchestration — testing it requires mocking fetch + OSRM responses, which is heavy for what's mostly glue code. The behavior is verifiable manually post-deploy. The unit-tested kernel (`loopOverlapFraction`) plus visual inspection is sufficient.

**Verification:**
```bash
# 1. buildLoop is genuinely untouched:
git diff master -- app.js | grep -A 30 "buildLoop"
# Expected: no changes inside the buildLoop body (lines around 562-585).
# Only buildJunctionLoop and pickBetterLoop additions show up.

# After deploy:
# 2. Smart-routing OFF, generate Helsinki round-trip — DevTools Network shows
#    2 sequential /api/osrm-fi calls (Phase 1 behavior preserved exactly).
# 3. Smart-routing ON, generate Helsinki round-trip — DevTools Network shows
#    Overpass junction call, then 4 parallel /api/osrm-fi/ route calls.
# 4. Smart-routing ON, generate from non-Finnish coord — Network shows 2
#    sequential public OSRM calls (Phase 1 single-chirality preserved for
#    foreign queries even with smart routing on).
```

**[Mode: Direct]**

**Commit after passing.**

---

## Task 3: Ranked candidates + retry loop in smart-routing branch + soft warning chip

**Files:**
- Modify: `app.js` (smart-routing branch of `generateDestination` at 1155 only)
- ADD to `app.js`: `rankByNovelty`, `minDistanceToExisting`, `shuffleInPlace` helpers
- Create: `tests/rank-by-novelty.test.js`

**Contracts:**

### 3a — `rankByNovelty` (pure addition; `pickMostNovelDestination` is NOT modified)

Add `rankByNovelty(candidates, existingDests)` as new code alongside the existing untouched `pickMostNovelDestination` (app.js:362). Both functions co-exist:
- `pickMostNovelDestination` keeps its current logic and call sites — used by the non-smart-routing branch and the one-way branch of `generateDestination`. Behavior unchanged.
- `rankByNovelty` is the new ranked-list function used only by the smart-routing branch's retry loop.

The minor scoring-logic duplication between the two is intentional safety — fully isolating the change to the smart path. After Phase 2 ships and stabilizes, a future cleanup pass can de-duplicate by having `pickMostNovelDestination` delegate to `rankByNovelty`. This plan does NOT do that cleanup.

**Critical: data formats.** `existingDests` is an array of 2-tuples `[[lat, lng], ...]` (returned by `getAllExistingDestinations` at app.js:358-360). `candidates` is an array of objects with `.lat`/`.lng` (sometimes also `.name`). Don't mix them up.

**Behavior choice for retry use:** `rankByNovelty` orders candidates most-novel-first, with the top half shuffled. The retry loop consumes `[0], [1], [2]` — three uniformly-random picks from the top-half novel pool, distinct (no candidate is tried twice).

```js
// Internal helper: min haversine distance from candidate `c` (object with
// .lat/.lng) to any point in `existingDests` (array of [lat, lng] tuples).
function minDistanceToExisting(c, existingDests) {
    return existingDests.reduce(
        (min, [eLat, eLng]) => Math.min(min, calculateDistance(c.lat, c.lng, eLat, eLng)),
        Infinity
    );
}

// Fisher-Yates in place. Returns the same array for chaining.
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Order candidates for retry use: most-novel half (shuffled) first, rest
// after. Used only by the smart-routing branch's retry loop.
function rankByNovelty(candidates, existingDests) {
    if (!candidates.length) return [];
    if (!existingDests || existingDests.length === 0) {
        return shuffleInPlace(candidates.slice());
    }
    const scored = candidates.map(c => ({
        c,
        score: minDistanceToExisting(c, existingDests),
    }));
    scored.sort((a, b) => b.score - a.score);
    const topSize = Math.max(1, Math.ceil(scored.length / 2));
    const top = shuffleInPlace(scored.slice(0, topSize).map(x => x.c));
    const rest = scored.slice(topSize).map(x => x.c);
    return [...top, ...rest];
}

// pickMostNovelDestination at app.js:362-374 is NOT modified.
```

### 3b — Retry loop, scoped to the smart-routing branch only

The structure of `generateDestination` (app.js:1155+) currently has three branches at the route-building stage (app.js:1232-1248):

1. `tripMode === 'one-way'` — calls `buildOneWay`. **Untouched in Phase 2.**
2. `smartRouting` toggle ON — calls `buildJunctionLoop`. **This branch is rewritten to use the retry loop.**
3. else (smart routing OFF) — calls `buildLoop`. **Untouched in Phase 2.**

The candidate-picking stage (app.js:1187-1229) currently picks one destination via `pickMostNovelDestination` for all three branches. This stays untouched. The smart-routing branch additionally derives a ranked candidate list via `rankByNovelty` for retry purposes — picking the same source POI/road/random pool.

**Restructuring approach:** keep the existing single-pick logic that lands at app.js:1229 with `dest = pickMostNovelDestination(...)`. The non-smart and one-way branches use this `dest` exactly as today. The smart-routing branch re-derives a ranked list from the same pool and runs the retry loop.

To avoid re-fetching POIs/roads/random-points, the candidate pool used in the smart-routing retry must be the same one that produced `dest`. Two options:

- **Option A (recommended):** Capture the candidate pool (the array passed to `pickMostNovelDestination`) in a local variable, then `rankByNovelty` over it inside the smart-routing branch. Single Overpass fetch, deterministic same-pool retry. Add one local variable assignment to each of the three pool-creation paths.
- Option B: Re-call `pickMostNovelDestination` repeatedly until N distinct picks. Wastes work and doesn't get the deterministic shuffled-top-half ordering.

Use Option A. Wire it like this — at each point that currently sets `dest = pickMostNovelDestination(pool, existingDests)`, also retain the pool in a `candidatePool` variable scoped to the function:

```js
let candidatePool = null; // populated alongside `dest`, used by the smart-routing retry

// Inside the 'roads' branch:
candidatePool = roads;
dest = pickMostNovelDestination(roads, existingDests);

// Inside the 'any_poi' / 'poi' branch:
candidatePool = pois;
dest = pickMostNovelDestination(pois, existingDests);
destName = dest.name;

// Inside the Overpass-fail catch blocks (which already build a random pool):
candidatePool = candidates;  // the random-points array already named `candidates`
dest = pickMostNovelDestination(candidates, existingDests);

// Inside the else (locationType !== known) branch (also a random pool):
candidatePool = candidates;
dest = pickMostNovelDestination(candidates, existingDests);
```

Then the route-building stage becomes:

```js
let outboundRoute, returnRoute, junctions = null;
let overlap = null;          // Phase 2: tracked for warning chip in smart-routing branch
let bestSeen = null;         // Phase 2: best-overlap result across retries

if (tripMode === 'one-way') {
    // UNCHANGED from today
    onProgress('Building route…');
    outboundRoute = await buildOneWay(startLat, startLng, dest.lat, dest.lng);
    returnRoute = null;
} else if (document.getElementById('smartRouting').checked) {
    // PHASE 2 — retry loop
    const winterMode = document.getElementById('winterMode').checked;
    const ranked = candidatePool ? rankByNovelty(candidatePool, existingDests) : [dest];

    // Retry budget gated by Finland — foreign destinations get one shot
    // (matches Phase 1 behavior, avoids surprise public-OSRM throughput hits).
    const retryBudget = (inFinland(startLat, startLng)
        && ranked.length > 0 && inFinland(ranked[0].lat, ranked[0].lng))
        ? Math.min(MAX_RETRY_ATTEMPTS, ranked.length)
        : 1;

    let cachedJunctions = null;

    for (let i = 0; i < retryBudget; i++) {
        const tryDest = ranked[i];
        if (!tryDest) break;

        onProgress(retryBudget > 1
            ? `Building route… (attempt ${i + 1}/${retryBudget})`
            : 'Building route…');
        const result = await buildJunctionLoop(startLat, startLng,
            tryDest.lat, tryDest.lng, onProgress, cachedJunctions, winterMode);
        if (cachedJunctions === null) cachedJunctions = result.junctions;

        // Track best-seen by overlap (lower is better; null displaces nothing)
        const candidate = {
            dest: tryDest,
            destName: tryDest.name || null,
            outbound: result.outbound,
            return: result.return,
            overlap: result.overlap,
            junctions: result.junctions,
        };
        if (!bestSeen
            || (candidate.overlap !== null
                && (bestSeen.overlap === null || candidate.overlap < bestSeen.overlap))) {
            bestSeen = candidate;
        }

        // Early exit if good enough
        if (candidate.overlap !== null && candidate.overlap < OVERLAP_BAD_THRESHOLD) break;
    }

    // Promote best-seen result back into the outer-scope variables so the
    // existing displayRoute call shape stays unchanged.
    if (bestSeen) {
        dest = bestSeen.dest;
        destName = bestSeen.destName;
        outboundRoute = bestSeen.outbound;
        returnRoute = bestSeen.return;
        junctions = bestSeen.junctions;
        overlap = bestSeen.overlap;
    }
} else {
    // UNCHANGED from today (non-smart-routing path)
    onProgress('Building route…');
    const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng);
    outboundRoute = loop.outbound;
    returnRoute = loop.return;
}

displayRoute(startLat, startLng, dest.lat, dest.lng,
             straightMax, straightMin, outboundRoute, returnRoute,
             locationInput, destName, tripMode, null, null);
if (currentSession) currentSession.junctions = junctions;

// Phase 2: soft warning if smart-routing exhausted retries with degenerate result
if (overlap !== null && overlap >= OVERLAP_BAD_THRESHOLD) {
    showWarning('This area has limited routing options — the loop overlaps significantly.');
}
```

### 3c — `showWarning` reuse

`app.js` already has `showError` and `showSuccess` (search for `showSuccess(` and `showError(`). Add a `showWarning` of the same shape that targets a third state (or repurposes existing toast styling). If a "warning"-styled toast doesn't exist yet, the simplest path is `showSuccess(msg)` with a different CSS class — implementer's call which existing UI primitive is closest.

**Constraints:**
- **Non-smart-routing branch is bit-for-bit unchanged.** No `rankByNovelty`, no retry loop, no overlap calculation, no warning chip. Reaches `buildLoop` exactly as today.
- **One-way branch is bit-for-bit unchanged.** No retry, no overlap. Reaches `buildOneWay` exactly as today.
- Junction cache: `buildJunctionLoop` accepts `cachedJunctions` already; we pass `null` on attempt 1 (Overpass fetch) and reuse the returned junction list on subsequent attempts. Retries don't re-query Overpass.
- Foreign destinations under smart routing: `retryBudget = 1` AND single-chirality loops (from Task 2). Behavior is exactly Phase 1 minus the (free) overlap calculation that drives the warning chip.
- Warning chip fires only from the smart-routing branch (it's the only branch that computes `overlap`). Non-smart users never see it. This is intentional — the chip is part of the new path.
- The `candidatePool` capture is a pure addition — it's set alongside the existing `pickMostNovelDestination` call sites without altering them. If the smart-routing branch isn't entered, `candidatePool` is set but unused (harmless).

**Test Cases (`tests/rank-by-novelty.test.js`):**

Important: tests must reflect the actual behavior — shuffling within the top half — not assert deterministic ordering. Tests assert SET membership of top half vs rest, plus invariants (length, no duplicates). Note `existingDests` is `[[lat, lng], ...]`, NOT objects.

```js
import { describe, test, expect } from 'vitest';
// (loading boilerplate per tests/sync.test.js. Recommendation: extract
// rankByNovelty + minDistanceToExisting + shuffleInPlace into a small
// pure-helper file like bbox.js / loop-quality.js, since loading the
// whole app.js into jsdom is painful.)

describe('rankByNovelty', () => {
    test('empty candidates → empty array', () => {
        expect(rankByNovelty([], [])).toEqual([]);
        expect(rankByNovelty([], [[60, 24]])).toEqual([]);
    });

    test('no existing destinations → all candidates returned, length preserved', () => {
        const cands = [{lat: 60, lng: 24}, {lat: 61, lng: 25}];
        const ranked = rankByNovelty(cands, []);
        expect(ranked.length).toBe(2);
        expect(new Set(ranked)).toEqual(new Set(cands));
    });

    test('with history, clearly-more-novel candidates appear in top half', () => {
        // existingDests is [[lat, lng], ...] — tuple form
        const existing = [[60.0, 24.0]];
        const veryClose1 = {lat: 60.001, lng: 24.001};
        const veryClose2 = {lat: 60.002, lng: 24.002};
        const veryFar1   = {lat: 65.0,   lng: 28.0};
        const veryFar2   = {lat: 67.0,   lng: 30.0};
        const ranked = rankByNovelty([veryClose1, veryClose2, veryFar1, veryFar2], existing);
        const topHalf = new Set(ranked.slice(0, 2));
        const bottomHalf = new Set(ranked.slice(2));
        expect(topHalf).toEqual(new Set([veryFar1, veryFar2]));
        expect(bottomHalf).toEqual(new Set([veryClose1, veryClose2]));
    });

    test('odd-length top half ceil(n/2)', () => {
        const existing = [[60.0, 24.0]];
        const cands = Array.from({length: 5}, (_, i) => ({
            lat: 60 + i * 0.5, lng: 24,
        }));
        // Top half is ceil(5/2) = 3. The 3 farthest from [60, 24] are
        // indices 2, 3, 4 (lats 61, 61.5, 62).
        const ranked = rankByNovelty(cands, existing);
        expect(ranked.length).toBe(5);
        const top = new Set(ranked.slice(0, 3));
        expect(top).toEqual(new Set([cands[2], cands[3], cands[4]]));
    });

    test('preserves all candidates, no duplicates, no extras', () => {
        const cands = Array.from({length: 5}, (_, i) => ({lat: 60 + i*0.01, lng: 24}));
        const ranked = rankByNovelty(cands, [[60, 24]]);
        expect(ranked.length).toBe(5);
        expect(new Set(ranked)).toEqual(new Set(cands));
    });
});

describe('pickMostNovelDestination', () => {
    test('with empty history, picks from candidates uniformly (smoke)', () => {
        const cands = [{lat: 60, lng: 24}, {lat: 61, lng: 25}];
        const picked = pickMostNovelDestination(cands, []);
        expect(cands).toContain(picked);
    });

    test('with history, picks from top half (i.e. one of the two farthest)', () => {
        const existing = [[60.0, 24.0]];
        const close = {lat: 60.001, lng: 24.001};
        const far1  = {lat: 65.0,   lng: 28.0};
        const far2  = {lat: 67.0,   lng: 30.0};
        // Run many times — pickMostNovelDestination should never return the close one
        for (let i = 0; i < 50; i++) {
            const picked = pickMostNovelDestination([close, far1, far2], existing);
            expect([far1, far2]).toContain(picked);
        }
    });
});
```

Test loading: load `novelty.js` (NOT `app.js`) using the same browser-script-loading pattern as `tests/sync.test.js`. `novelty.js` is small and pure (per the File Structure section above), parses cleanly in jsdom.

**Verification:**

```bash
pnpm vitest run tests/loop-quality.test.js tests/rank-by-novelty.test.js tests/in-finland.test.js
# Expected: all tests pass

# Manual browser verification (post-deploy):
#
# A. Smart-routing OFF — non-smart path completely unchanged
# 1. Toggle smart routing OFF, generate Helsinki round-trip — DevTools shows
#    2 sequential /api/osrm-fi calls (Phase 1 single-chirality buildLoop).
#    No retry messages, no warning chip ever.
# 2. Toggle smart routing OFF, generate near a known lake-collapse area —
#    same degenerate behavior as today (no overlap detection, no retry).
#    This is the deliberate iteration-safety baseline.
#
# B. Smart-routing ON — Phase 2 active
# 3. Toggle smart routing ON, generate Helsinki round-trip — DevTools shows
#    Overpass junction call, then 4 parallel /api/osrm-fi route calls on
#    first attempt. If overlap < 0.4 → no retry, network total ~5 calls.
# 4. Toggle smart routing ON, pick a known lake-collapse start (Päijänne /
#    Saimaa with a POI across water) — DevTools shows up to 3 attempts of
#    4 parallel calls each. Either a non-degenerate loop is found and
#    displayed, OR all 3 attempts collapse and the warning chip appears.
# 5. Smart routing ON, retry attempts reuse cached junctions — Overpass call
#    happens once, no second Overpass fetch even across multiple retries.
#
# C. One-way mode — unchanged
# 6. One-way mode, any destination — Phase 1 behavior. No retry, no warning.
#
# D. Foreign destinations
# 7. Smart routing ON, generate from non-Finnish coord — DevTools shows 2
#    sequential public OSRM calls, no retries. If overlap >= 0.4, warning
#    chip appears.
```

**[Mode: Direct]**

**Commit after passing.**

---

## Out of Scope

- **Modifying `buildLoop` or the non-smart-routing branch.** Deliberately deferred — the original generation path stays as a stable comparison baseline while we iterate on the smart-routing improvements. After Phase 2 ships, validates, and stabilizes, the non-smart path's role gets re-evaluated (likely deprecated and removed, but that's a separate decision).
- **De-duplicating `pickMostNovelDestination` and `rankByNovelty` scoring logic.** Intentional duplication for safety isolation — `pickMostNovelDestination` stays bit-for-bit identical so non-smart-path users get exactly today's pick distribution. Cleanup is a future task.
- Closure-scoped `selfHostedDegraded` flag from spec section 4.5: deferred. Phase 1 has been live and stable; the cross-call coordination this flag provides is over-engineering until we see actual self-hosted brownouts during retry sequences. Capture as an idea if needed.
- User-facing overlap-score badge on every route (idea #863): explicitly deferred — wait to see if the warning chip is enough.
- Auto-widening spread before re-picking (idea #864): explicitly deferred.
- Bbox check on individual candidates within the retry loop: candidates returned from Overpass POI search ARE within `straightMax` of the start, which is itself bbox-checked, so they're effectively in Finland already.

---

## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A tasks: Opus implements directly
- Mode B tasks: Dispatched to subagents

All three tasks are Mode A. Task 1 is pure-helper boilerplate. Task 2 is single-file orchestration changes with a clear contract and a small helper extraction. Task 3 is the largest — restructures `generateDestination` — but the new shape is fully spec'd above; implementer's only judgment call is the `showWarning` UI primitive and whether `rankByNovelty` needs to be extracted to a helper file for testability.
