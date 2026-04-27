# Junction-Only Smart Routing Implementation Plan

**Goal:** Replace the current way-center-based smart routing with a junction-only via approach to eliminate within-leg lollipop stubs.

**Architecture:** Swap the candidate pool feeding `selectRoadVias` from way centers to junction nodes (OSM nodes referenced by ≥2 ways), with a way-center fallback for slots where the closest junction is too far from the geometric ideal to preserve loop shape. The 3-via-per-side oval, side classification, and nearest-to-geometric matching are unchanged. The geometric `buildLoop` (non-smart path) is untouched. U-turn mitigation is removed — junction selection eliminates the cause.

**Tech Stack:** Vanilla JS, Overpass API, OSRM `route` API.

**Spec:** `docs/plans/2026-04-27-junction-vias-design.md`

---

### Task 1: Junction-aware corridor fetch

[Mode: Direct]

**Files:**
- Modify: `app.js` — replace `fetchRoadsInCorridor` (currently at app.js:507) with `fetchCorridorRoadData`. Keep `HIGHWAY_EXCLUDE_DEFAULT` / `HIGHWAY_EXCLUDE_WINTER` constants in place (still used).

**Contract:**

```javascript
// Fetch ways in the corridor between start and dest, expanded by offsetKm on each side.
// Returns both junction nodes (≥2 way refs) and way centers, computed from a single Overpass response.
// junctions[] = candidates we PREFER (through-points by definition)
// wayCenters[] = fallback pool (used per-slot when nearest junction is too far from geometric ideal)
async function fetchCorridorRoadData(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode = false)
  → { junctions: [{lat, lng}, ...], wayCenters: [{lat, lng}, ...] }
```

**Overpass query (single request):**

```
[out:json][timeout:15];
way["highway"]["highway"!~"<exclude>"](<bbox>);
out body;
>;
out skel qt;
```

- `<exclude>` is the existing winter/default exclusion regex.
- `<bbox>` is the existing corridor bbox (min/max of start+dest lat/lng padded by `offsetKm/111` with cos correction). No change to bbox computation.

**Client-side processing:**

- The Overpass response contains two element types: `way` (with `nodes: [id, …]` arrays and a `center: {lat, lon}` if present) and `node` (with `id, lat, lon`).
- Build `nodeWayCount: Map<nodeId, number>` by iterating ways and incrementing the count for each node id in `way.nodes`.
- Build `nodeCoords: Map<nodeId, {lat, lng}>` from the `node` elements.
- `junctions = [...nodeWayCount entries with count ≥ 2].map(id → nodeCoords[id])` (filter out any id missing from `nodeCoords` defensively).
- `wayCenters = ways.filter(w => w.center).map(w => ({ lat: w.center.lat, lng: w.center.lon }))` — same shape the old function produced, recomputed from the same response. **Important:** `out body; >; out skel qt;` does NOT include way centers by default. Use `out center;` *additionally*, or compute centers client-side from the ways' node coordinates (mean of the way's nodes).
- **Decision:** compute way centers client-side from the way nodes (mean lat/lng across the way's referenced nodes). Avoids a second Overpass call and keeps the response schema as specified above.

**Constraints:**

- Single Overpass request. No fan-out.
- Handles Overpass rate-limit errors via the existing `queryOverpass` helper (same pattern as `fetchRoadsInCorridor` today).
- If a way has fewer than 2 nodes (degenerate), skip when computing its center.
- No filtering of junctions by side here — `classifyRoads` does that downstream.

**Verification:**

- Manually invoke from the browser console with a Helsinki-center start/dest pair and `offsetKm = 0.6`. Confirm `result.junctions.length` is in the hundreds and `result.wayCenters.length` is similar order of magnitude. Spot-check a few junction coordinates against OSM to confirm they sit at visible road intersections.
- Confirm the response decodes without errors for a sparse forest-edge case.

**Commit after passing.**

---

### Task 2: Junction-first `buildSmartLoop` orchestrator

[Mode: Direct]

**Files:**
- Modify: `app.js` — replace the body of `buildSmartLoop` (currently at app.js:648). Keep the function name, signature, and return shape (the `roads` field's internal shape changes — see below).

**Contract:**

```javascript
async function buildSmartLoop(startLat, startLng, destLat, destLng, onProgress, cachedRoads = null, winterMode = false)
  → { outbound, return, outboundVias, returnVias, roads }
```

- `outbound`, `return`: same shape as today (`{coords, duration, distance, steps}` or `null`).
- `outboundVias`, `returnVias`: arrays of 3 `{lat, lng}` points actually used.
- `roads`: now `{ junctions: [...], wayCenters: [...] }` (was `[{lat, lng}, ...]` of way centers). This is the value passed back into `buildSmartLoop` as `cachedRoads` on spread-slider re-routes.

**Algorithm:**

1. Compute `straightDist`, `offsetMult`, `viaTs`, `offsetKm`, `A`, `B` exactly as today.
2. Compute geometric ideal vias (existing `envelopeOffsetPoint` calls — unchanged).
3. Resolve `roadData`:
   - If `cachedRoads` is provided AND has the new shape, use it.
   - Otherwise, `onProgress('Searching for junctions…')` then `await fetchCorridorRoadData(...)`.
   - On Overpass failure (catch block), fall back to `buildLoop(...)` exactly as today, returning `{ ..., roads: null }`.
4. `const { left: leftJ, right: rightJ } = classifyRoads(roadData.junctions, startLat, startLng, destLat, destLng);`
   `const { left: leftW, right: rightW } = classifyRoads(roadData.wayCenters, startLat, startLng, destLat, destLng);`
5. `outboundVias = selectViasWithFallback(rightJ, rightW, geoViasRight, offsetKm);`
   `returnVias  = selectViasWithFallback(leftJ,  leftW,  geoViasLeft,  offsetKm);`
6. `onProgress('Building outbound route…')` → `await fetchRouteThrough([A, ...outboundVias, B])`.
7. `onProgress('Building return route…')` → `await fetchRouteThrough([B, ...returnVias, A])`.
8. If either route is `null`, fall back to `buildLoop(...)` and return its result with the geometric vias (same as today's failure branch).
9. **No u-turn mitigation step.** Return `{ outbound, return: ret, outboundVias, returnVias, roads: roadData }`.

**New helper to add (private to the smart-loop section):**

```javascript
// Pick 3 vias from junctions on a side, falling back to way centers per-slot
// when the chosen junction is too far from the geometric ideal.
// thresholdKm = max(0.5, offsetKm * 0.6)
function selectViasWithFallback(junctionsOnSide, wayCentersOnSide, geometricVias, offsetKm)
  → [{lat, lng}, {lat, lng}, {lat, lng}]
```

**Algorithm for `selectViasWithFallback`:**

- `thresholdKm = Math.max(0.5, offsetKm * 0.6)`.
- Run the existing `selectRoadVias(junctionsOnSide, geometricVias)` to get 3 junction picks (or geometric fallback when junctions are insufficient — `selectRoadVias` already returns `geometricVias` when `roads.length < 3`; preserve that behavior).
- For each pick `i`, if it equals the geometric fallback (junctions were insufficient) OR `calculateDistance(picks[i], geometricVias[i]) > thresholdKm`:
  - Replace `picks[i]` with `selectRoadVias(wayCentersOnSide, [geometricVias[i]])[0]` if way centers on that side has ≥3 entries — otherwise replace with the way-center result over a relaxed pool, falling back to the geometric ideal as last resort.
  - **Simpler:** if `wayCentersOnSide.length ≥ 1`, replace with the way center on that side closest to `geometricVias[i]`. If no way centers on that side, leave the geometric ideal in place.

**Constraints:**

- No mutation of `selectRoadVias` or `classifyRoads`. Reuse them as-is.
- The function `buildLoop` must not be called or modified except as the existing failure-fallback branch.
- Preserve `requestDelay` between OSRM calls (already handled inside `fetchRouteThrough`).
- The progress callback messages: `'Searching for junctions…'`, `'Building outbound route…'`, `'Building return route…'`. No `'Optimizing route…'` message anymore.

**Verification:**

- Manual: with smart routing ON, generate a round trip in central Helsinki — confirm no within-leg lollipop stubs (no segments going up a side street and back). Confirm outbound and return have visibly different paths.
- Manual: with smart routing ON, generate a round trip in a low-density area (forest edge, suburban) — confirm a routed loop is produced (loop shape may be coarser, but no crash, no straight-line, no infinite spinner).
- Manual: with smart routing OFF, behavior should be identical to before (still calls `buildLoop`).

**Commit after passing.**

---

### Task 3: Integration cleanup — remove dead code and update cached-roads consumers

[Mode: Direct]

**Files:**
- Modify: `app.js` — delete `countUTurns` (currently app.js:567) and `fetchNearestRoadSnaps` (currently app.js:574). Confirm no other callers exist; if grep shows only `buildSmartLoop` referenced them, the deletions are safe. Update the `currentSession.cachedRoads` shape expectations at the call sites (app.js:1328, 1420, 1783, 1944, 1984–2001).

**Contracts:**

- `currentSession.cachedRoads` may be `null` OR `{ junctions: [...], wayCenters: [...] }`. The caller code stores whatever `buildSmartLoop` returned in `result.roads` and passes it back into the next `buildSmartLoop` call. Callers MUST NOT introspect the shape — only `buildSmartLoop` and `fetchCorridorRoadData` know the shape.
- All four `buildSmartLoop` call sites already use this pass-through pattern (see app.js:1328, 1420, 1783, 1944). Confirm during implementation; no signature changes expected at those sites.

**Constraints:**

- Do NOT touch `buildLoop`. It remains the smart-routing-OFF code path.
- If grep finds any unexpected caller of `countUTurns` or `fetchNearestRoadSnaps` outside `buildSmartLoop`, stop and ask before deleting.
- The `steps` field on `fetchRouteThrough` results is still useful for downstream consumers (FIT export, directions URL). Do NOT remove the `steps=true&continue_straight=true` query params in `fetchRouteThrough`.

**Verification:**

- `grep -n 'countUTurns\|fetchNearestRoadSnaps' app.js` — should return zero matches after this task.
- Page loads cleanly, smart-routing toggle works, spread slider re-routes work (this exercises the `cachedRoads` pass-through).

**Commit after passing.**

---

### Task 4: Loading text and cache-bust

[Mode: Direct]

**Files:**
- Modify: `index.html` — bump `app.js?v=6` to `app.js?v=7`.
- Modify: `app.js` — verify the `'Searching for junctions…'`, `'Building outbound route…'`, `'Building return route…'` strings from Task 2 are present and consistent. Remove any leftover `'Optimizing route…'` string references.

**Constraints:**

- This task is cosmetic-only and exists to ensure deployed users get the new `app.js` without browser-cache staleness.

**Verification:**

- `grep -n "Optimizing route" app.js` — should return zero matches.
- View page in browser at deployed URL after `deploy`, hard-refresh, confirm new `?v=7` is in the script tag.

**Commit after passing.**

---

## Execution
**Skill:** Subagent Dev
- Mode A tasks (1–4): Opus implements directly. Spec is detailed, changes are localized to a single file (plus a one-line `index.html` bump), and there are no design decisions left for the implementer to make.
