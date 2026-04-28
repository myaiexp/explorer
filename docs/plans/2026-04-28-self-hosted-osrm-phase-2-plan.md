# Phase 2 — Loop-Quality Filter (Overlap + Chirality + N-Retry) — Implementation Plan

**Goal:** Detect degenerate loops (outbound and return collapse onto the same shoreline road, typically near lakes) and reject them by trying both chiralities and re-picking from a ranked POI candidate pool. Surface a soft warning when no acceptable loop is found.

**Architecture:** Three additions on top of Phase 1. (1) A pure utility `loopOverlapFraction(outboundCoords, returnCoords)` that measures geometric overlap between two polylines as a `[0, 1]` fraction. (2) `buildLoop` and `buildJunctionLoop` build both chiralities in parallel (when in Finland) and return the lower-overlap one, exposing the score. (3) `generateDestination` ranks POI candidates by novelty, builds loops in order, and retries up to `MAX_RETRY_ATTEMPTS` times if overlap exceeds threshold, falling back to the best-seen result with a soft warning if all attempts are degenerate.

**Tech Stack:** Vanilla JS in `app.js`, new pure-helper file `loop-quality.js` (mirrors the `bbox.js` pattern), vitest+jsdom for tests. No backend or infra changes.

**Spec reference:** `docs/plans/2026-04-28-self-hosted-osrm-and-overlap-filter-design.md`, sections 4.1–4.6.

**Phase 1 line numbers** (post-`d0c3123`): bbox helpers in `bbox.js`; `OSRM_*` constants at `app.js:469`; `tryOsrm`/`tryNearest` at 483/533; `fetchRouteThrough`/`snapToRoad` at 501/545; `buildLoop` at 562; `buildJunctionLoop` at 643; `pickMostNovelDestination` at 362; `generateDestination` at 1155.

---

## File Structure

```
explorer repo:
  loop-quality.js                ← new: pure helpers (overlap + constants), like bbox.js
  index.html                     ← modify: <script src="loop-quality.js"> before app.js
  app.js                         ← modify: buildLoop, buildJunctionLoop,
                                   pickMostNovelDestination → rankByNovelty,
                                   generateDestination retry loop + warning
  tests/loop-quality.test.js     ← new: unit tests for loopOverlapFraction
  tests/rank-by-novelty.test.js  ← new: unit tests for ranking
```

No new files outside the explorer repo. No deploy artifacts changed.

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

## Task 2: Both-chirality `buildLoop` and `buildJunctionLoop`

**Files:**
- Modify: `app.js` (buildLoop at 562, buildJunctionLoop at 643)

**Contracts:**

Both functions gain a both-chirality path. When start AND dest are in Finland (cheap self-hosted calls), build the mirror chirality in parallel and return the lower-overlap one with `overlap` exposed. Outside Finland, behavior matches Phase 1 single-chirality (overlap still computed and returned for the warning chip — it's a local computation, free).

Updated `buildLoop` (lines 562-585):

```js
// Build a routed loop A → vias → B → vias → A.
// In Finland: builds both chiralities (right-then-left and left-then-right)
// in parallel and returns the lower-overlap one. Outside: single chirality.
// Always returns { outbound, return, overlap } — overlap is null only if
// either leg failed.
async function buildLoop(startLat, startLng, destLat, destLng) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const { offsetMult, viaTs } = getSpreadParams();
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const A = { lat: startLat, lng: startLng };
    const B = { lat: destLat,  lng: destLng };

    const viasRight = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const viasLeft = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    const snapRadius = Math.max(0.3, offsetKm * 0.5);
    const allVias = [...viasRight, ...viasLeft];
    const snapped = await Promise.all(allVias.map(v => snapToRoad(v, snapRadius)));
    const snappedRight = snapped.slice(0, 3);
    const snappedLeft  = snapped.slice(3);

    const tryBoth = inFinland(startLat, startLng) && inFinland(destLat, destLng);

    if (tryBoth) {
        // Both chiralities in parallel — 4 OSRM calls.
        const [outA, retA, outB, retB] = await Promise.all([
            fetchRouteThrough([A, ...snappedRight, B]),
            fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
            fetchRouteThrough([A, ...snappedLeft, B]),
            fetchRouteThrough([B, ...snappedRight.slice().reverse(), A]),
        ]);
        return pickBetterLoop(outA, retA, outB, retB);
    }

    // Single chirality — Phase 1 behavior — 2 OSRM calls.
    const [outbound, ret] = await Promise.all([
        fetchRouteThrough([A, ...snappedRight, B]),
        fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
    ]);
    const overlap = (outbound && ret)
        ? loopOverlapFraction(outbound.coords, ret.coords) : null;
    return { outbound, return: ret, overlap };
}

// Helper: pick lower-overlap of two candidate (outbound, return) pairs.
// Falls back gracefully if one chirality fully failed.
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

Updated `buildJunctionLoop` (lines 643-683): same pattern — when in Finland, run both chiralities through `pickBetterLoop`. Junction snap happens once on the full vias array. Existing fallback to `buildLoop` on Overpass/OSRM failure is preserved (and inherits buildLoop's both-chirality logic).

**Required rename in `buildJunctionLoop`:** the current code at app.js:652 builds `viasLeftReturn = viaTs.slice().reverse().map(...)` (i.e., left vias constructed in REVERSED `t` order). For the both-chirality logic to work, this must change to `viasLeft = viaTs.map(...)` (forward `t` order, matching `viasRight`) — same rename as in `buildLoop` above. Reversal moves to call time via `.slice().reverse()` on whichever leg uses it. Without this rename, the left-chirality outbound leg in the both-chirality path would silently feed already-reversed vias as if they were forward-order, producing wrong geometry.

Key snippet for buildJunctionLoop (replacing the success path that currently does outbound + ret sequentially, and including the via-construction rename):

```js
// REPLACE the existing left-vias construction (currently at app.js:652
// using `viasLeftReturn = viaTs.slice().reverse().map(...)`) with this
// forward-order construction matching the right side:
const viasRight = viaTs.map(t =>
    envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
const viasLeft = viaTs.map(t =>
    envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
```

Then the success path:

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
        const loop = await buildLoop(startLat, startLng, destLat, destLng);
        return { ...loop, junctions };
    }
    return { ...picked, junctions };
}

// Single-chirality (foreign) path — current Phase 1 behavior:
onProgress('Building outbound route…');
const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
onProgress('Building return route…');
const ret = await fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]);
if (!outbound || !ret) {
    const loop = await buildLoop(startLat, startLng, destLat, destLng);
    return { ...loop, junctions };
}
const overlap = loopOverlapFraction(outbound.coords, ret.coords);
return { outbound, return: ret, overlap, junctions };
```

**Constraints:**
- The current `viasLeftReturn` variable (`viaTs.slice().reverse().map(...)`, app.js:572) is replaced with `viasLeft = viaTs.map(...)` — left side built in same `t` order as right. Reversal happens at fetch-call time (`.slice().reverse()`) so `pickBetterLoop` and the left-leg orderings stay readable.
- Both chiralities use the SAME snapped vias (snap step is once, not per chirality). Different chirality only changes the *order* and *side assignment*, not the snap targets.
- Mode A change at the integration level — single-file, well-defined replacements.
- Stale comment in current buildLoop about "tries both chiralities, picks least overlap" (app.js:502 in pre-Phase-1 numbering) is now true and should be kept (or rephrased to reflect actual behavior). Audit the comment block above buildLoop and clean it up.

**Test Cases:**

No new automated tests for the build*Loop integration — testing them requires mocking fetch and OSRM responses, which is heavy for what's mostly orchestration. The behavior is verifiable manually post-deploy. The unit-tested kernel (`loopOverlapFraction`) plus visual inspection is sufficient.

**Verification:**
```bash
# After deploy:
# 1. Generate route from Helsinki center to a destination across a peninsula
#    (e.g. Lauttasaari → Kulosaari via mainland) — DevTools Network shows 4
#    /api/osrm-fi/ calls in parallel, not 2 sequential.
# 2. Generate from a non-Finnish coord — Network shows 2 sequential public calls
#    (current behavior preserved).
```

**[Mode: Direct]**

**Commit after passing.**

---

## Task 3: Ranked candidates + retry loop in `generateDestination` + soft warning chip

**Files:**
- Modify: `app.js` (`pickMostNovelDestination` at 362, `generateDestination` at 1155)
- Create: `tests/rank-by-novelty.test.js`

**Contracts:**

### 3a — `rankByNovelty`

Replace `pickMostNovelDestination` internals with `rankByNovelty(candidates, existingDests)` returning the candidates ordered for retry use (most-novel-first, with the top half shuffled to preserve current variety semantics). Keep `pickMostNovelDestination` as a one-line wrapper.

**Critical: data formats.** `existingDests` is an array of 2-tuples `[[lat, lng], ...]` (returned by `getAllExistingDestinations` at app.js:358-360). `candidates` is an array of objects with `.lat`/`.lng` (sometimes also `.name`). Don't mix them up.

**Critical: behavior preservation.** The current `pickMostNovelDestination` (app.js:362-374) does NOT return the top-most candidate deterministically:
- No history → random pick from all candidates
- With history → score by min-distance-to-existing, sort descending, take top half, RANDOM pick from that pool

This randomization preserves variety. Naïvely returning a deterministic ranked list would silently change the no-retry call site's behavior. Solution: `rankByNovelty` shuffles the top half (and shuffles all candidates when history is empty), so `[0], [1], [2]` are random samples from the top half — matching current variety while still favoring novel candidates first for retries.

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
// after. Single-pick callers (pickMostNovelDestination) get the same
// random-from-top-half behavior as before; retry callers consume [0]..[N-1].
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

function pickMostNovelDestination(candidates, existingDests) {
    return rankByNovelty(candidates, existingDests)[0];
}
```

This preserves the current call-site distribution: for `existingDests.length > 0`, `pickMostNovelDestination` still returns a uniformly-random pick from the top-half by novelty. For empty history, it still returns a uniformly-random pick from all candidates. Only difference: retries (Task 3b) take `[1], [2]` from the same pre-shuffled top half — also random samples from the novel pool, no duplicates.

### 3b — Retry loop in `generateDestination`

Replace the single-pick + single-route block (app.js:1187-1248) with a retry loop:

```js
// Build ranked candidate list (same source as today, just ranked instead of picked)
let candidates;
try {
    if (locationType === 'roads') {
        const winterMode = document.getElementById('winterMode').checked;
        const roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress, winterMode);
        if (roads.length === 0) throw new Error('empty');
        candidates = rankByNovelty(roads, existingDests);
    } else if (locationType === 'any_poi' || locationType === 'poi') {
        const filters = locationType === 'any_poi'
            ? POI_TYPES.map(p => p.filter)
            : [POI_TYPES.find(p => p.key === locationTypeVal)?.filter].filter(Boolean);
        const label = locationType === 'any_poi'
            ? 'any POI'
            : POI_TYPES.find(p => p.key === locationTypeVal)?.label || 'places';
        onProgress(`Searching for ${label}…`);
        const pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax,
            filters.length === 1 ? filters[0] : filters, onProgress);
        if (pois.length === 0) throw new Error('empty');
        candidates = rankByNovelty(pois, existingDests);
    } else {
        const pool = Array.from({ length: 5 }, () =>
            generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
        candidates = rankByNovelty(pool, existingDests);
    }
} catch {
    // Existing Overpass-fail fallback path
    onProgress('Overpass unavailable, using random point…');
    const pool = Array.from({ length: 5 }, () =>
        generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
    candidates = rankByNovelty(pool, existingDests);
    usedFallback = true;
}

// Retry budget gated by Finland — foreign destinations get one shot
// (matches Phase 1 behavior, avoids surprise public-OSRM throughput hits).
const retryBudget = (tripMode !== 'one-way' && inFinland(startLat, startLng)
    && candidates.length > 0 && inFinland(candidates[0].lat, candidates[0].lng))
    ? Math.min(MAX_RETRY_ATTEMPTS, candidates.length)
    : 1;

let bestResult = null; // { dest, outbound, return, overlap, junctions, destName }
let cachedJunctions = null;

for (let i = 0; i < retryBudget; i++) {
    const dest = candidates[i];
    if (!dest) break;
    const destName = dest.name || null;

    let outboundRoute, returnRoute, junctions = null, overlap = null;
    if (tripMode === 'one-way') {
        onProgress('Building route…');
        outboundRoute = await buildOneWay(startLat, startLng, dest.lat, dest.lng);
        returnRoute = null;
        // No overlap concept for one-way — break after first attempt.
        bestResult = { dest, outboundRoute, returnRoute, overlap: null, junctions, destName };
        break;
    }

    if (document.getElementById('smartRouting').checked) {
        const winterMode = document.getElementById('winterMode').checked;
        const result = await buildJunctionLoop(startLat, startLng, dest.lat, dest.lng,
            onProgress, cachedJunctions, winterMode);
        outboundRoute = result.outbound;
        returnRoute = result.return;
        junctions = result.junctions;
        overlap = result.overlap;
        if (cachedJunctions === null) cachedJunctions = junctions; // cache for retries
    } else {
        onProgress(retryBudget > 1 ? `Building route… (attempt ${i + 1}/${retryBudget})` : 'Building route…');
        const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng);
        outboundRoute = loop.outbound;
        returnRoute = loop.return;
        overlap = loop.overlap;
    }

    // Track best-seen by overlap (lower is better; null overlap from full
    // route failure should not displace a real result).
    const candidate = { dest, outboundRoute, returnRoute, overlap, junctions, destName };
    if (!bestResult
        || (candidate.overlap !== null
            && (bestResult.overlap === null || candidate.overlap < bestResult.overlap))) {
        bestResult = candidate;
    }

    // Early exit if good enough
    if (overlap !== null && overlap < OVERLAP_BAD_THRESHOLD) break;
}

if (!bestResult || !bestResult.outboundRoute) {
    showError('Could not build a route to any candidate destination.');
    return;
}

displayRoute(startLat, startLng, bestResult.dest.lat, bestResult.dest.lng,
             straightMax, straightMin, bestResult.outboundRoute, bestResult.returnRoute,
             locationInput, bestResult.destName, tripMode, null, null);
if (currentSession) currentSession.junctions = bestResult.junctions;

// Soft warning if we couldn't find a non-degenerate loop
if (bestResult.overlap !== null && bestResult.overlap >= OVERLAP_BAD_THRESHOLD) {
    showWarning('This area has limited routing options — the loop overlaps significantly.');
}
```

### 3c — `showWarning` reuse

`app.js` already has `showError` and `showSuccess` (search for `showSuccess(` and `showError(`). Add a `showWarning` of the same shape that targets a third state (or repurposes existing toast styling). If a "warning"-styled toast doesn't exist yet, the simplest path is `showSuccess(msg)` with a different CSS class — implementer's call which existing UI primitive is closest.

**Constraints:**
- Junction cache: `buildJunctionLoop` accepts `cachedJunctions` already; we pass `null` on attempt 1 (Overpass fetch) and reuse the returned junction list on subsequent attempts. That means smart-routing retries don't re-query Overpass. Plain `buildLoop` retries don't query Overpass at all (only OSRM nearest), so no caching needed there.
- One-way mode: `tripMode === 'one-way'` short-circuits to `retryBudget = 1` regardless. No overlap concept for one-way trips.
- Foreign destinations get `retryBudget = 1` AND get single-chirality loops (from Task 2). Behavior is exactly Phase 1 minus the (free) overlap calculation that drives the warning chip.
- Warning chip fires whenever `overlap >= OVERLAP_BAD_THRESHOLD` is non-null at display time — applies to foreign queries too, since overlap is computed regardless. Useful info either way.
- The candidate-source try/catch changes: previously the catch landed inside the locationType branches with a fallback random pool. The retry loop wants `candidates` populated regardless, so the catch is restructured to set `candidates` before entering the retry loop. Behavior preserved.

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

Test loading note: extract `rankByNovelty`, `minDistanceToExisting`, and `shuffleInPlace` into a small pure-helper file (e.g. `novelty.js`), loaded before `app.js` in `index.html` — same pattern as `bbox.js` and `loop-quality.js`. `calculateDistance` is also needed by `minDistanceToExisting`; either move it to the helper file too, or keep `minDistanceToExisting` in app.js and only extract the helpers that don't depend on it. Implementer's call — both shapes are reasonable.

**Verification:**

```bash
pnpm vitest run tests/loop-quality.test.js tests/rank-by-novelty.test.js tests/in-finland.test.js
# Expected: all tests pass

# Manual browser verification (post-deploy):
# 1. Generate Helsinki round-trip — DevTools shows 4 parallel /api/osrm-fi calls
#    on first attempt. If overlap < 0.4, no retry. Network panel shows 4 calls total.
# 2. Pick a known lake-collapse start (somewhere in Päijänne or Saimaa with a
#    POI across the lake) — DevTools shows multiple attempts, network calls
#    in batches of 4 per attempt, up to 3 attempts. Either: a non-degenerate
#    loop is found and displayed, OR all 3 attempts collapse and the warning
#    chip appears.
# 3. Generate from non-Finnish coord — DevTools shows 2 sequential public calls,
#    no retries. If the result happens to overlap, warning chip still appears.
# 4. Smart-routing toggle ON in lake area — Overpass junction call happens once;
#    retry attempts reuse cached junctions (no second Overpass call).
```

**[Mode: Direct]**

**Commit after passing.**

---

## Out of Scope

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
