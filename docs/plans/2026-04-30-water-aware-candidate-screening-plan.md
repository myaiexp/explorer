# Water-Aware Candidate Screening Implementation Plan

**Goal:** Add a two-stage OSRM-only screening step between candidate generation and the smart-routing retry loop so destinations in water (or unreachable across water) never enter the retry pool.

**Architecture:** New pure helper module `screening.js` (loaded after `bbox.js` / `loop-quality.js` / `novelty.js`, before `app.js`) exposing `screenCandidates(start, candidates, { nearestFn, routeFn })`. `generateDestination` calls it after the candidate pool is built, replaces the pool with survivors, and falls back to a `bestRejected` candidate (with a water-locked-area warning chip) if nothing passes. Random-annulus pool size grows 5 → 15 so screening has enough survivors to pick from in lake-heavy starts.

**Tech Stack:** Vanilla JS browser script, no build step. Vitest + jsdom for tests, loaded via `node:vm` `runInThisContext` matching the existing `bbox.js` / `loop-quality.js` / `novelty.js` test pattern. Self-hosted OSRM-foot Finland at `https://mase.fi/api/osrm-fi/{nearest,route}/v1/foot`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `screening.js` | Create | Pure screening helpers + `screenCandidates` orchestrator. globalThis-exposed for browser + test parity. |
| `tests/screening.test.js` | Create | Unit tests for `passesStage1`, `detourRatio`, `screenCandidates`. |
| `app.js` | Modify | Bump random-annulus pool 5→15. Call `screenCandidates` after candidate pool built. Wire fallback to `bestRejected` and water-locked warning. |
| `index.html` | Modify | Add `<script src="screening.js?v=__COMMIT__" defer>` in load order (after the three existing pure helpers, before `app.js`). |
| `CLAUDE.md` | Modify | Update Architecture section to reflect the multi-file frontend (current text says "all application logic in app.js" — stale). |

No changes to `style.css`, `sync.js`, `fit-encoder.js`, `bbox.js`, `loop-quality.js`, `novelty.js`, server-side, or migrations.

---

## Task 1: `screening.js` module + tests

**[Mode: Direct]** — small file, contracts fully specified by the spec, no architectural decisions left.

**Files:**
- Create: `/home/mase/helm/worktrees/explorer/ce72bdba/screening.js`
- Create: `/home/mase/helm/worktrees/explorer/ce72bdba/tests/screening.test.js`

**Contracts:**

```js
// screening.js — water-aware reachability filtering for destination candidates.
// Loaded after bbox.js / loop-quality.js / novelty.js, before app.js.
// Pure module, no DOM access. OSRM I/O is dependency-injected.

const STAGE1_NEAREST_MAX_M = 500;   // tunable, meters
const STAGE2_DETOUR_MAX    = 2.2;   // tunable, ratio
const RANDOM_POOL_SIZE     = 15;    // tunable, candidate count

// Pure: did the candidate snap close enough to the foot graph?
// Returns false if nearestResult is null (OSRM /nearest failed).
// Distance is computed via globalThis.haversineM. NOTE: haversineM takes
// [lat, lng] ARRAYS (it reads index 0/1), not {lat, lng} objects. The
// implementation must adapt — recommended:
//     const snapM = haversineM(
//         [candidate.lat, candidate.lng],
//         [nearestResult.lat, nearestResult.lng]
//     );
// Calling haversineM with {lat, lng} objects silently returns NaN and would
// reject every candidate. Tests in this file exercise the {lat, lng} input
// path on the public API; the array adaptation must live inside screening.js.
function passesStage1(candidate, nearestResult) { ... }

// Pure: route_km / straight_km, or Infinity if either input is falsy.
// straightKm is haversine distance start→candidate (computed by caller).
// routeMeters is the OSRM /route response's `distance` field.
function detourRatio(routeMeters, straightKm) { ... }

// Async orchestrator — returns the screening verdict.
//   start      : { lat, lng }
//   candidates : array of { lat, lng, name? } (pool from POI/roads/random)
//   deps       : { nearestFn, routeFn }
//     nearestFn(candidate) → Promise<{lat, lng} | null>
//     routeFn(start, candidate) → Promise<{distance: meters} | null>
// Returns:
//   {
//     survivors:    array<candidate>  (passed both stages, original order preserved)
//     bestRejected: candidate | null  (lowest-detour rejected if any stage 2
//                                     happened; else smallest-snapM rejected;
//                                     null only if candidates was empty)
//     diagnostics:  array<{candidate, stage, reason, snapM, detour}>
//   }
// Each survivor and bestRejected gets { snapM, detour } annotated for downstream.
async function screenCandidates(start, candidates, deps) { ... }

// globalThis exposure (matching the pattern in bbox.js / loop-quality.js / novelty.js):
globalThis.STAGE1_NEAREST_MAX_M = STAGE1_NEAREST_MAX_M;
globalThis.STAGE2_DETOUR_MAX    = STAGE2_DETOUR_MAX;
globalThis.RANDOM_POOL_SIZE     = RANDOM_POOL_SIZE;
globalThis.passesStage1   = passesStage1;
globalThis.detourRatio    = detourRatio;
globalThis.screenCandidates = screenCandidates;
```

**Constraints:**

- Module assumes `haversineM` is on globalThis (from `loop-quality.js`, already loaded earlier in the script tag order).
- Stage 1 fans out via `Promise.all` over `nearestFn(candidate)` for every candidate.
- Stage 2 fans out via `Promise.all` over `routeFn(start, candidate)` for stage-1 survivors only.
- A `nearestFn` returning null is treated as a stage 1 reject (snap distance unknown — safe to skip). A `routeFn` returning null is treated as a stage 2 reject (detour unknown — safe to skip). All-failures-degrade-to-pass behavior lives in app.js, not screening.js — screening reports survivors honestly and the integration layer decides what to do when survivors is empty.
- `bestRejected` selection: if any stage-1-survivor had its detour computed (even if rejected), pick the rejected candidate with the smallest detour. Otherwise (everything failed at stage 1) pick the rejected candidate with the smallest `snapM`. Returns null only if the input `candidates` array is empty.
- `survivors` array preserves the input candidate order (no internal re-sorting). Caller applies novelty ranking via existing `rankByNovelty`.
- Each survivor and `bestRejected` is the original candidate object **with** `snapM` and `detour` properties added (via shallow copy or property assignment — must not mutate the input array's objects).
- The diagnostics array contains one entry per input candidate, in input order. Used for debug logging only — no behavior depends on it.

**Test Cases** (`tests/screening.test.js` — load via `vm.Script(SRC).runInThisContext()` matching `loop-quality.test.js` pattern; depends on `loop-quality.js` being loaded first in the test setup so `haversineM` is available on globalThis):

```js
import { describe, test, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'node:vm';

const LOOP_QUALITY_SRC = readFileSync(resolve(__dirname, '../loop-quality.js'), 'utf8');
const SCREENING_SRC    = readFileSync(resolve(__dirname, '../screening.js'),    'utf8');

beforeAll(() => {
    new vm.Script(LOOP_QUALITY_SRC).runInThisContext();  // exposes haversineM
    new vm.Script(SCREENING_SRC).runInThisContext();
});

// ── passesStage1 ────────────────────────────────────────────────────────────

test('passesStage1: null nearestResult → false', () => {
    expect(globalThis.passesStage1({lat:60.17,lng:24.94}, null)).toBe(false);
});

test('passesStage1: snap within threshold → true', () => {
    // ~100 m offset, well under 500 m
    const c = {lat:60.17, lng:24.94};
    const n = {lat:60.1709, lng:24.94};
    expect(globalThis.passesStage1(c, n)).toBe(true);
});

test('passesStage1: snap exceeds threshold → false', () => {
    // ~1.1 km offset, over 500 m
    const c = {lat:60.17, lng:24.94};
    const n = {lat:60.18, lng:24.94};
    expect(globalThis.passesStage1(c, n)).toBe(false);
});

// ── detourRatio ────────────────────────────────────────────────────────────

test('detourRatio: identical km → 1.0', () => {
    // 5 km route, 5 km straight
    expect(globalThis.detourRatio(5000, 5)).toBeCloseTo(1.0, 5);
});

test('detourRatio: null route → Infinity', () => {
    expect(globalThis.detourRatio(null, 5)).toBe(Infinity);
});

test('detourRatio: zero straight → Infinity', () => {
    expect(globalThis.detourRatio(5000, 0)).toBe(Infinity);
});

test('detourRatio: 3× route → 3.0', () => {
    expect(globalThis.detourRatio(15000, 5)).toBeCloseTo(3.0, 5);
});

// ── screenCandidates ────────────────────────────────────────────────────────

const START = {lat:60.17, lng:24.94};
// Three candidates ~5 km away, far enough that detour math is meaningful.
const CANDS = [
    {lat:60.215, lng:24.94},  // c0
    {lat:60.215, lng:25.00},  // c1
    {lat:60.215, lng:25.06},  // c2
];

test('screenCandidates: all pass → all survivors, null bestRejected', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});  // ~11 m snap
    const routeFn   = async (s,c) => ({distance: 6000});  // ~6 km route, ~5 km straight → 1.2
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(3);
    expect(r.bestRejected).toBeNull();
    expect(r.survivors[0].snapM).toBeLessThan(20);
    expect(r.survivors[0].detour).toBeCloseTo(1.2, 1);
});

test('screenCandidates: all stage-1 fail → empty survivors, bestRejected by min snapM', async () => {
    // Three candidates with progressively larger snap distances, all > 500 m.
    const offsets = [0.01, 0.02, 0.005];  // ~1.1 km, 2.2 km, 0.55 km
    let i = 0;
    const nearestFn = async (c) => ({lat:c.lat + offsets[i++], lng:c.lng});
    const routeFn   = async () => { throw new Error('stage 2 should not be called'); };
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    // c2 had the smallest snap (~550 m), so it's bestRejected
    expect(r.bestRejected).toBe(CANDS[2]);
    expect(r.bestRejected.snapM).toBeGreaterThan(500);
});

test('screenCandidates: stage 1 passes but stage 2 rejects → bestRejected by min detour', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    // distances: c0 → 30 km route (6×), c1 → 20 km (4×), c2 → 50 km (10×) — all > 2.2
    const routes = [{distance:30000}, {distance:20000}, {distance:50000}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toBe(CANDS[1]);  // detour 4× is lowest of the three
    expect(r.bestRejected.detour).toBeCloseTo(4.0, 1);
});

test('screenCandidates: mixed → only survivors annotated', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    // c0 passes (1.2×), c1 rejected (5×), c2 passes (1.5×)
    const routes = [{distance:6000}, {distance:25000}, {distance:7500}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors).toEqual([
        expect.objectContaining({lat: CANDS[0].lat, lng: CANDS[0].lng}),
        expect.objectContaining({lat: CANDS[2].lat, lng: CANDS[2].lng}),
    ]);
    expect(r.bestRejected).toBe(CANDS[1]);
});

test('screenCandidates: nearestFn returns null for one → that one rejected, others screen', async () => {
    let call = 0;
    const nearestFn = async (c) => {
        call++;
        return call === 2 ? null : {lat:c.lat+0.0001, lng:c.lng};
    };
    const routeFn = async () => ({distance: 6000});
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
    expect(r.survivors.find(s => s === CANDS[1])).toBeUndefined();
});

test('screenCandidates: routeFn returns null for one → that one rejected at stage 2', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    let call = 0;
    const routeFn = async () => (++call === 2 ? null : {distance: 6000});
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(2);
});

test('screenCandidates: empty candidates → empty survivors, null bestRejected', async () => {
    const nearestFn = async () => { throw new Error('should not be called'); };
    const routeFn   = async () => { throw new Error('should not be called'); };
    const r = await globalThis.screenCandidates(START, [], {nearestFn, routeFn});
    expect(r.survivors).toHaveLength(0);
    expect(r.bestRejected).toBeNull();
    expect(r.diagnostics).toHaveLength(0);
});

test('screenCandidates: diagnostics array length equals input count, with stage labels', async () => {
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    const routes = [{distance:6000}, {distance:25000}, {distance:7500}];
    let i = 0;
    const routeFn = async () => routes[i++];
    const r = await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(r.diagnostics).toHaveLength(3);
    expect(r.diagnostics.map(d => d.stage)).toEqual(['survived', 'stage2-reject', 'survived']);
});

test('screenCandidates: input candidate objects are not mutated', async () => {
    const original = JSON.parse(JSON.stringify(CANDS));
    const nearestFn = async (c) => ({lat:c.lat+0.0001, lng:c.lng});
    const routeFn   = async () => ({distance: 6000});
    await globalThis.screenCandidates(START, CANDS, {nearestFn, routeFn});
    expect(CANDS).toEqual(original);
});
```

**Verification:**
Run: `pnpm vitest run tests/screening.test.js`
Expected: All tests pass.

**Commit after passing.**

---

## Task 2: Wire screening into `generateDestination`

**[Mode: Delegated]** — needs to navigate `generateDestination` (currently 158 lines, app.js:1217–1375), preserve the existing fallback/error semantics, and integrate cleanly with the smart-routing retry loop and the non-smart paths. Multiple integration choices to make carefully.

**Files:**
- Modify: `/home/mase/helm/worktrees/explorer/ce72bdba/app.js`

**Contracts:**

1. **Pool size bump.** Replace `Array.from({ length: 5 }, ...)` at app.js:1266, 1288, 1295 with `Array.from({ length: RANDOM_POOL_SIZE }, ...)`. Three sites.

2. **Adapter functions** for screening's dependency injection. Add module-private helpers near the existing OSRM helpers (~app.js:540):

   ```js
   // Adapter: matches screenCandidates' nearestFn contract.
   // Returns {lat, lng} or null on any failure.
   async function screeningNearestFn(c) {
       return tryNearest(`${OSRM_FI_NEAREST}/${c.lng},${c.lat}?number=1`);
   }

   // Adapter: matches screenCandidates' routeFn contract.
   // Returns {distance: meters} or null on any failure.
   async function screeningRouteFn(start, c) {
       const r = await fetchRouteThrough([
           {lat:start.lat, lng:start.lng},
           {lat:c.lat,     lng:c.lng}
       ]);
       return r ? {distance: r.distance} : null;
   }
   ```

3. **Screening call site** in `generateDestination`. Insert AFTER `candidatePool` is set in all three branches (after line 1299) and BEFORE the route-building section starts (line 1301):

   ```js
   // Screen candidates: reject points in water (stage 1) and across-water
   // destinations that would force long detours (stage 2). Both use OSRM only.
   onProgress('Checking reachability…');
   const screened = await screenCandidates(
       { lat: startLat, lng: startLng },
       candidatePool,
       { nearestFn: screeningNearestFn, routeFn: screeningRouteFn }
   );

   let waterLocked = false;
   if (screened.survivors.length > 0) {
       candidatePool = screened.survivors;
       dest = pickMostNovelDestination(candidatePool, existingDests);
       destName = dest.name || destName;
   } else if (screened.bestRejected) {
       // Everything failed screening — surface the least-bad anyway with a chip.
       candidatePool = [screened.bestRejected];
       dest = screened.bestRejected;
       destName = dest.name || destName;
       waterLocked = true;
   }
   // If candidates was empty (Overpass fully failed and random fallback also
   // failed somehow), the existing dest from before screening is kept.
   ```

   Note: `dest` and `destName` are already set by the pre-screening `pickMostNovelDestination`. The screening block re-picks from survivors. POI mode's `destName = dest.name` line at line 1285 is preserved by the `dest.name || destName` fallback above.

4. **Water-locked warning chip.** After the existing overlap-warning block (app.js:1364–1366), add:

   ```js
   if (waterLocked) {
       showWarning('This area is mostly water — try a different start or larger radius.');
   }
   ```

   `showWarning` already exists and is used by the overlap-warning above. The two warnings are mutually exclusive: water-locked means we picked `bestRejected`, which by definition didn't go through the retry loop's overlap path (since it's the only candidate). Confirm the existing `if (overlap !== null && overlap >= OVERLAP_BAD_THRESHOLD)` block is unreachable in the water-locked case — `overlap` stays null because no full retry-loop attempt completes a valid pair when there's only one (likely-bad) candidate. Verify during implementation; if both could fire, prefer the water-locked message (more specific).

5. **No screening for one-way mode**: re-evaluate. The spec says one-way also benefits from screening (catches across-water destinations silently producing bad routes). The integration above runs screening regardless of `tripMode`, which is correct. Confirm that one-way mode correctly consumes `dest` from screening and doesn't break — `buildOneWay(startLat, startLng, dest.lat, dest.lng)` at app.js:1306 takes raw lat/lng so it's fine.

6. **Error path**: wrap `screenCandidates` in try/catch. On unexpected rejection (not the per-candidate null returns — those are handled inside), log to console and skip screening: keep the original `candidatePool` and `dest` from before the screening block. This preserves "screening can never make a generate fail that would have succeeded before."

   ```js
   try {
       const screened = await screenCandidates(...);
       // ... (the body above)
   } catch (err) {
       console.warn('Screening failed, falling back to unscreened pool:', err);
       // candidatePool and dest unchanged
   }
   ```

**Constraints:**

- Must integrate with the existing flow without changing behavior for foreign starts (already gated upstream by `resolveStart` at app.js:1209).
- Must not break the existing chirality + overlap retry loop at app.js:1308–1342. The retry loop reads `candidatePool` indirectly via `rankByNovelty(candidatePool, ...)` — after screening, `candidatePool` is the survivors array, so retries operate on screened candidates only.
- Must not remove or rename existing functions (`buildLoop`, `buildJunctionLoop`, `pickMostNovelDestination`, `rankByNovelty`, `tryNearest`, `fetchRouteThrough`).
- The `onProgress('Checking reachability…')` call provides user feedback during screening — match the visual cadence of the existing onProgress messages.

**Verification:**

1. Type-clean: `node -e "require('vm').runInThisContext(require('fs').readFileSync('app.js','utf8'))"` (sanity parse — app.js is non-module so this checks syntax only). If it loads, syntax is fine.
2. Existing test suite still passes: `pnpm vitest run`
3. Manual smoke (dev server + browser):
   - Start http server: `python3 -m http.server 8080`
   - Navigate to http://localhost:8080/, set a Helsinki start, generate any-mode trip 3–5 km. Should produce a route, no console errors, no warning chip in clean cases.
   - Set a known-water start scenario: start at a lakeshore where the radius extends across the lake. Generate any-mode. Verify route is on the same shore (or warning chip if all candidates are water-locked).
   - Confirm one-way mode still works (set radio to "One way", generate).

**Commit after verification.**

---

## Task 3: Load order and doc updates

**[Mode: Direct]** — purely mechanical.

**Files:**
- Modify: `/home/mase/helm/worktrees/explorer/ce72bdba/index.html`
- Modify: `/home/mase/helm/worktrees/explorer/ce72bdba/CLAUDE.md`

**Contracts:**

1. **`index.html`**: Add `<script src="screening.js?v=__COMMIT__" defer></script>` between the `novelty.js` line (currently line 245) and `app.js` (line 246). Cache-busting placeholder must match the existing pattern — the `deploy` pipeline rewrites `__COMMIT__`.

2. **`CLAUDE.md`** Architecture section update. The current list says only `app.js`, `sync.js`, `fit-encoder.js`. Replace with the actual `index.html` load order (verified against the script tags — `defer` preserves document order):

   ```
   - `index.html` — structure
   - `style.css` — styles
   - `fit-encoder.js` — Garmin FIT course-file encoder (used by `exportFIT()` in app.js)
   - `sync.js` — cloud-backup sync engine (outbox + per-row upserts to `/explorer/api`)
   - `bbox.js` — Finland bounding box helpers (pure, globalThis-exposed)
   - `loop-quality.js` — loop overlap detection (pure, globalThis-exposed)
   - `novelty.js` — novelty ranking helpers (pure, globalThis-exposed)
   - `screening.js` — water-aware reachability filtering (pure, globalThis-exposed)
   - `app.js` — main application logic (orchestration, DOM, OSRM/Overpass calls)
   ```

   Also delete the stale parenthetical "(~95KB single file)" — it's no longer accurate.

**Verification:** Reload http://localhost:8080/, open browser console, verify no script-load errors and that `globalThis.screenCandidates` is defined.

**Commit after verification** (combined with task 2 if convenient — load order change must ship with the new file).

---

## Task 4: Threshold calibration verification

**[Mode: Direct]** — manual probing, no code changes unless thresholds need tuning.

**Files:**
- Possibly modify: `screening.js` (only if thresholds need tuning)
- Create (optional): `docs/plans/2026-04-30-water-aware-candidate-screening-calibration-notes.md` if substantive findings.

**Procedure:**

Run the dev server and exercise these scenarios with the browser dev console open. For each, observe survivor count and (if any) `bestRejected.snapM` / `bestRejected.detour` values printed to console (add a temporary `console.log('screening result:', screened)` in app.js for this task; remove before commit).

| Scenario | Start | Mode/Radius | Expected screening behavior |
|---|---|---|---|
| Päijänne shore | a town on Päijänne (e.g. Padasjoki) | any, 5–10 km | many candidates rejected at stage 1 (in lake) or stage 2 (across-lake); survivors all on same-shore. |
| Helsinki coastal | a Helsinki seaside spot (e.g. Lauttasaari) | any, 3–6 km | across-bay rejected at stage 2; survivors on same peninsula. |
| Helsinki dense urban | central Helsinki | any, 1–3 km | almost all candidates pass; survivors ≈ pool size. |
| Inland small lakes | a Finnish town with a small lake nearby (e.g. Jyväskylä) | any, 2–4 km | small-lake candidates may pass stage 1 (paths nearby) but stage 2 should catch across-lake; verify ratios stay sensible. |
| Northern wilderness | a Lapland village (e.g. Inari) | any, 5–15 km | stage 1 should not over-reject — wilderness has paths within 500 m. If many false rejects, raise STAGE1_NEAREST_MAX_M. |
| Roads mode | central Helsinki | roads, 2–4 km | candidates from Overpass roads, mostly pass; verify stage 2 doesn't false-reject twisty rural-style roads (it shouldn't in Helsinki). |
| POI mode | a town near a small island POI | poi, 2–5 km | a POI on a tiny ferry-only island should be rejected at stage 1 (snap > 500 m if no bridge) or stage 2 (huge detour via ferry-less land path). |

Tuning rules:

- If wilderness false-rejects > 1 in 5 attempts: raise `STAGE1_NEAREST_MAX_M` to 750 or 1000 m.
- If small-lake false-passes (across-tiny-lake routes accepted): lower `STAGE2_DETOUR_MAX` to 1.8 or 2.0.
- If twisty-rural false-rejects: raise `STAGE2_DETOUR_MAX` to 2.5.
- If both directions need tuning, document the conflict in calibration-notes.md and let a future session decide whether to add a second knob (e.g. distinct stage 2 thresholds for short vs long radii).

**Verification:** Document findings (even if no tuning needed) in a brief commit message or in the optional notes file. Calibration is an empirical task — "no changes needed" is a valid result.

**Commit only if thresholds change** or notes file is added.

---

## Mode Summary

| Task | Mode | Why |
|---|---|---|
| 1: screening.js + tests | Direct | Contracts fully specified; pure helpers + orchestrator with mocked deps. |
| 2: Wire into generateDestination | Delegated | Touches a 158-line function with multiple branches and an existing retry loop; integration choices benefit from a fresh agent reading the surrounding code. |
| 3: Load order + CLAUDE.md | Direct | Trivial mechanical edits. |
| 4: Threshold calibration | Direct | Manual browser probing; no architectural decisions. |

---
## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A tasks: Opus implements directly
- Mode B tasks: Dispatched to subagents
