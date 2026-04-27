# Junction-Snap Loop — Redo Plan (Handoff)

**Status:** Spec, ready for a fresh session.
**Date:** 2026-04-27
**Supersedes:** `2026-04-27-junction-vias-design.md` and `2026-04-27-junction-vias-plan.md`. That earlier attempt was implemented, deployed, and then torn out — see §1 for what went wrong and why this redo is shaped differently.

---

## 1. Why the previous attempt failed (read this first)

The previous plan said "swap the candidate pool from way centers to junction nodes, keep everything else." Implemented faithfully. Deployed. Routes were visibly identical to the old broken smart routing — back-and-forth on a single street with a tiny divergence at one point, even at the widest spread setting. Mase's screenshot showed the failure clearly.

**Root cause** (verified empirically against the deployed code in central Helsinki):

The old `buildSmartLoop` used **classify-by-side + greedy closest-pick**:
1. `classifyRoads` split the candidate pool by cross-product sign relative to A→B.
2. `selectRoadVias` picked the closest candidate to each geometric ideal, with no max-distance cap.

In dense urban grids, most "junctions" (and most way centers) sit **on the main road that A→B follows**. Their cross-product is essentially zero; floating-point noise scatters them between the left and right pools. A junction sitting ~4 m off the centerline is "the closest" to a geometric ideal that's only 180 m off-axis (typical at default spread). So `selectRoadVias` repeatedly picked on-centerline junctions for **both** the left and right pools — the right and left vias collapsed onto the same road. OSRM dutifully routed both legs through that road. Back-and-forth, no loop.

**The working baseline (`buildLoop`) does not have this bug** because it never classifies by side. It generates each geometric envelope via with a directional offset (`envelopeOffsetPoint(..., side=-1)` for right, `side=+1` for left) and snaps each via **independently** to the nearest road within a tight radius (`max(0.3 km, offsetKm·0.5)`). The snap radius is small enough that a right-side via cannot snap to a left-side road. Direction is preserved through the snap. The loop holds.

**The lesson:** the snap step must be per-via and radius-bounded, not pool-classify-and-pick. This redo follows that pattern.

---

## 2. Goal

Add a junction-snap variant of `buildLoop` that the smart-routing toggle activates. The variant differs from `buildLoop` in **exactly one place**: where `buildLoop` calls `snapToRoad` (OSRM nearest-snap), the variant snaps to the closest **OSM junction node** in a corridor-fetched pool. Everything else — geometric envelope vias, snap radius, fallback when nothing is in range, route assembly — is identical.

The goal isn't a different loop shape. It's the **same** loop shape with snap targets that are guaranteed road-network through-points (junctions) rather than arbitrary nearest-road points (which can land on forest path stubs, dead-end side streets, etc.).

---

## 3. Constraints (do not violate these)

1. **Do not touch `buildLoop`.** It is the user's working baseline. Read it, mimic its structure, but leave the function itself untouched.
2. **Do not classify junctions by side.** Cross-product side classification is what broke the previous attempt. Use per-via independent snap with a radius cap, exactly as `buildLoop` does.
3. **Do not greedy-pick from a pool to match all 3 vias at once.** Each via's snap is independent of the others.
4. **Do not add u-turn detection / mitigation.** That code was removed for a reason — OSRM doesn't reliably emit `maneuver.modifier === "uturn"` for stub trips, so the mitigation was unreliable noise.
5. **Do not introduce a new smart-routing function name like `buildSmartLoop`.** That identifier is poisoned by the previous attempt. Use a new name (`buildJunctionLoop` is a fine choice).
6. **Single Overpass call per route generation** (with cache reuse on spread-slider re-route — see §6).

---

## 4. Architecture

### 4.1 New function: `buildJunctionLoop`

Same signature surface as `buildLoop` plus a junctions parameter for caching. Returns same shape as `buildLoop` plus `roads` for cache reuse:

```javascript
// Build a round-trip loop using junction-node snap instead of OSRM nearest-snap.
// cachedJunctions: optional previously-fetched junction array (skip Overpass on spread re-route).
// Returns { outbound, return, junctions } where junctions is the array used (passable as cachedJunctions next time).
async function buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, cachedJunctions = null, winterMode = false)
```

### 4.2 New function: `fetchCorridorJunctions`

Fetch OSM nodes in the corridor that are referenced by ≥2 highway ways (i.e. junction nodes). Single Overpass request.

```javascript
// Fetch junction nodes (referenced by ≥2 highway ways) in the corridor between start and dest,
// expanded by offsetKm on each side. Returns array of {lat, lng}.
async function fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode = false)
```

Overpass query (use the existing `queryOverpass` helper for retry/rate-limit handling):

```
[out:json][timeout:15];
way["highway"]["highway"!~"<exclude>"](<bbox>);
out body;
>;
out skel qt;
```

- `<exclude>`: existing `HIGHWAY_EXCLUDE_DEFAULT` / `HIGHWAY_EXCLUDE_WINTER` constant.
- `<bbox>`: same corridor bbox computation `buildLoop` would imply (lat/lng pad of `offsetKm/111`, with cos correction on lng).
- Client-side: build `nodeWayCount: Map<nodeId, number>` from the `way.nodes` arrays; collect `{lat, lng}` from `node` elements where `nodeWayCount.get(id) >= 2`. Drop nodes missing coords (defensive).

**Note on "junction" definition:** a node referenced by ≥2 highway ways is the simplest definition and is what we're using here. Many of these are actually way-split nodes (where one road is split into two ways for tag changes like surface or maintenance) rather than real intersections. That's acceptable — they're still road-network through-points, which is the property we care about for snap targets. If practical results are still poor, **defer to a follow-up** rather than tightening the junction definition mid-implementation.

### 4.3 New helper: `snapToJunction`

Mirrors `snapToRoad`'s contract exactly, but searches a junction pool instead of OSRM:

```javascript
// Find the closest junction in the pool to `via` within maxKm.
// Returns the junction, or the original `via` if no junction is in range.
function snapToJunction(via, junctionPool, maxKm) {
    if (!junctionPool || junctionPool.length === 0) return via;
    let best = null, bestDist = Infinity;
    for (const j of junctionPool) {
        const d = calculateDistance(via.lat, via.lng, j.lat, j.lng);
        if (d < bestDist) { bestDist = d; best = j; }
    }
    return bestDist <= maxKm ? best : via;
}
```

Same fallback semantics as `snapToRoad`: if nothing's in range, return the geometric ideal. **No** OSRM-nearest fallback at this stage — let OSRM handle the geometric ideal directly. (We considered cascading to OSRM-nearest as a third tier but it complicates the code without a clear win; if low-density areas prove problematic, add it as a follow-up.)

### 4.4 `buildJunctionLoop` body (mirror `buildLoop`)

```javascript
async function buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, cachedJunctions = null, winterMode = false) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const { offsetMult, viaTs } = getSpreadParams();
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const A = { lat: startLat, lng: startLng };
    const B = { lat: destLat,  lng: destLng };

    const viasRight = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const viasLeftReturn = viaTs.slice().reverse().map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    let junctions = cachedJunctions;
    if (!junctions) {
        try {
            onProgress('Searching for junctions…');
            junctions = await fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode);
        } catch {
            // Overpass failure → fall back to buildLoop entirely
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            return { outbound: loop.outbound, return: loop.return, junctions: null };
        }
    }

    // Snap each via INDEPENDENTLY to its closest junction within radius. No classification.
    const snapRadius = Math.max(0.3, offsetKm * 0.5); // identical to buildLoop's radius
    const allVias = [...viasRight, ...viasLeftReturn];
    const snapped = allVias.map(v => snapToJunction(v, junctions, snapRadius));
    const snappedRight = snapped.slice(0, 3);
    const snappedLeft = snapped.slice(3);

    onProgress('Building outbound route…');
    const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
    onProgress('Building return route…');
    const ret      = await fetchRouteThrough([B, ...snappedLeft, A]);

    if (!outbound || !ret) {
        // Routing failure → fall back to buildLoop
        const loop = await buildLoop(startLat, startLng, destLat, destLng);
        return { outbound: loop.outbound, return: loop.return, junctions };
    }

    return { outbound, return: ret, junctions };
}
```

Compare line-by-line with `buildLoop`. The structure is identical except for:
- The Overpass fetch (with cache reuse) before the snap step.
- `snapToJunction` instead of `snapToRoad`.
- The fallback to `buildLoop` on failure.

That's the entire algorithmic difference.

---

## 5. UI wiring

Restore the smart-routing checkbox in `index.html` (the tear-out commit removed it). Place it back where it was — adjacent to the winter-mode toggle in the controls panel.

```html
<label class="checkbox-option">
    <input type="checkbox" id="smartRouting">
    <span>Smart routing <span class="hint">(slower, snaps to road junctions)</span></span>
</label>
```

Update the winter-mode tooltip back to mention smart routing too, since it'll once again gate the corridor query:

```html
<span>Winter mode <span class="hint">(prefers plowed roads; affects road destinations and smart routing)</span></span>
```

Wire 4 round-trip call sites in `app.js` to branch on the toggle. Find them by grepping for `buildLoop(startLat, startLng, dest`:

1. `generateDestination` (~line 1290 in current app.js)
2. Pick-on-map handler (~line 1380)
3. Shared-route loader (~line 1730)
4. Spread-slider re-route (~line 1890)

At each site, replace the unconditional `buildLoop` call (in the round-trip branch) with:

```javascript
const useSmartRouting = document.getElementById('smartRouting').checked;
const winterMode = document.getElementById('winterMode').checked;
let result;
if (useSmartRouting) {
    result = await buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, cachedJunctions, winterMode);
    cachedJunctions = result.junctions; // for spread-slider re-route only
} else {
    onProgress('Building route…');
    result = await buildLoop(startLat, startLng, destLat, destLng);
}
const outbound = result.outbound, ret = result.return;
```

For the spread-slider re-route only (site #4), the `cachedJunctions` var lives on `currentSession` so re-routes skip Overpass. Add a `junctions` field to `currentSession`'s init (in `displayRoute`) and to its updates in the spread-slider re-route block. The other 3 sites pass `null` for `cachedJunctions`.

Add a `smartRouting` line to `saveSettings` / `restoreSettings` so the toggle persists in `localStorage` (mirror the existing `winterMode` lines).

---

## 6. What's already done (in the tear-out commit you'll be working on top of)

- `buildSmartLoop`, `fetchCorridorRoadData`, `selectViasWithFallback`, `selectRoadVias`, `classifyRoads`, `classifyPointSide` — **deleted**.
- Smart-routing checkbox — **removed from index.html**.
- All 4 round-trip call sites — **simplified to call `buildLoop` only**.
- `currentSession.cachedRoads`, `outboundVias`, `returnVias` — **all `null` after tear-out**. You'll re-introduce a `currentSession.junctions` cache for the spread-slider re-route.
- Winter-mode tooltip — **updated** to "prefers plowed roads over forest paths for road destinations". When you re-add smart routing, update it again per §5.

So the codebase you'll edit has `buildLoop` as the only round-trip path, with no smart-routing branch anywhere. Your job is to add `buildJunctionLoop` + helpers and re-introduce the toggle that selects between them.

---

## 7. Verification (manual, in browser)

You're done when all of these pass. Test in a deployed (or `python3 -m http.server`-served) browser, not just by reading code.

1. **Smart-routing OFF in central Helsinki, default spread**: produces a clearly distinct outbound (blue) and return (orange) loop covering several blocks. Same as `buildLoop` does today. Sanity check that you didn't break the baseline.
2. **Smart-routing ON in central Helsinki, default spread**: produces a clearly distinct outbound and return loop, comparable in shape to (1). NOT back-and-forth on a single street. NOT identical to (1) — the snap targets differ — but qualitatively the same loop topology.
3. **Smart-routing ON at maximum spread** (slider = 100): produces a wide loop covering more area than (2). NOT a thin oval that collapses to overlap.
4. **Smart-routing ON in a low-density area** (forest edge, sparse suburb): produces *some* routed loop. If junctions in range are sparse, the snap falls back to the geometric ideal and OSRM still routes — possibly with stubs. Acceptable; document if it regresses noticeably vs. `buildLoop` OFF in the same spot.
5. **Smart-routing toggle persists** across page reloads (localStorage).
6. **Spread slider re-route with smart on** doesn't refetch Overpass (check Network tab — only OSRM calls, no overpass-api.de).
7. **Smart-routing OFF behavior is unchanged** vs. before your changes (the working baseline must stay intact).

If (2) or (3) shows back-and-forth-on-one-street, **stop**. Something is wrong. Most likely cause: you accidentally introduced classification by side, or the snap radius is too generous. Re-read §1 and §3.

---

## 8. Out of scope (for this redo)

- Tightening the "junction" definition (≥2 ways with different `name` tags, ≥3 ways, compass-quadrant filter). Defer to a follow-up if §7's verification produces poor results — they're independent improvements, not blockers.
- Multi-anchor / triangle / figure-8 loop strategies. The whole point of this redo is "buildLoop's structure but with junction snap." Different loop strategies are a separate design.
- Exposing junction count or quality metrics in the UI.
- Self-hosted OSRM with custom profile or `exclude` segments. Tracked elsewhere as a self-hosted-OSRM idea.

---

## 9. References

- `app.js:529 buildLoop` — the function to mirror.
- `app.js:516 snapToRoad` — the helper to mirror.
- `app.js:339 envelopeOffsetPoint` — the geometric via generator (reuse, don't duplicate).
- `app.js:474 HIGHWAY_EXCLUDE_DEFAULT` / `HIGHWAY_EXCLUDE_WINTER` — reuse in the Overpass query.
- `app.js:411 queryOverpass` — reuse for retry/rate-limit handling.
- `2026-04-27-junction-vias-design.md` and `2026-04-27-junction-vias-plan.md` — the failed previous attempt. Read them only as a cautionary tale; the architecture they describe is what NOT to build.
