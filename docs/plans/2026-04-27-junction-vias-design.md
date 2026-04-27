# Junction-Only Smart Routing — Design

**Status:** Design (pre-implementation)
**Date:** 2026-04-27
**Replaces:** the current "smart routing" (`buildSmartLoop` + `fetchRoadsInCorridor` + u-turn mitigation, app.js:648, app.js:507, app.js:696). The geometric `buildLoop` (app.js:619) is **untouched** — it remains the user's preferred working baseline.

## 1. Problem

The current smart-routing toggle is structurally broken. With "wide" at maximum it produces routes whose outbound and return overlap almost entirely, and within a single leg it produces "lollipop" stubs — the route walks up a side street, U-turns, and walks back. The U-turn mitigation in `buildSmartLoop` catches some of these but most slip through because OSRM doesn't always emit a `maneuver.modifier === "uturn"` for stub trips; it can be reported as separate arrive/depart steps with no u-turn flag.

The geometric `buildLoop` (the non-smart method) produces visibly more loop-shaped results in practice, but it still occasionally produces dead-end stubs. The user's preference is that `buildLoop` stay frozen as the closest-to-working baseline; **all changes happen in the smart-routing path**.

## 2. Root cause

OSRM `route` treats each waypoint as a **hard pass-through constraint**, not advice. The route MUST visit each waypoint exactly. Given that:

- `fetchRoadsInCorridor` returns `way center` per way (one point per OSM way).
- A way center can land anywhere along the way's geometry, including mid-segment on a residential cul-de-sac, an unconnected stub, or a one-block side road.
- `selectRoadVias` picks the closest such point to the geometric ideal — with no knowledge of whether that point is a through-point or a dead-end.
- OSRM, ordered to "pass through this point," does the cheapest thing it can: drive in, U-turn, drive out. Lollipop.

The bug is in **the candidate pool**. We're handing OSRM coordinates that have no guarantee of being routable through-points, and OSRM's only legal response at a stub-coordinate is a U-turn.

## 3. Approach: junction-only vias

Replace the candidate pool. Use **road junction nodes** (OSM nodes referenced by ≥2 ways) instead of way centers.

A junction node is by definition a place where multiple road segments meet. OSRM can enter the junction on one of the connecting ways and exit on another — passing through is cheaper than U-turning, so OSRM picks pass-through. Stubs caused by "via on a dead-end road" become structurally impossible at a junction, because the junction always has at least 2 outbound roads to choose from.

The 3-via-per-side oval structure is unchanged. Side classification (`classifyRoads`) and nearest-to-geometric-ideal matching (`selectRoadVias`) are unchanged. Only the source of `{lat, lng}` candidates flips from way centers to junction coordinates.

**Why not 1 anchor per leg?** Considered and rejected: a single anchor per leg makes the outbound and return cross at (or near) the anchor, producing an X / figure-8 instead of an O.

**Why not OSRM `alternatives=true`?** Already tried; doesn't help in practice for this app.

**Why not generate N candidate loops and pick the best?** API budget — Overpass + OSRM rate limits make multi-route fan-out infeasible.

## 4. What's replaced, what's kept

| Component | Action |
|---|---|
| `buildLoop` (app.js:619) | **Keep untouched.** User's working baseline. Still selected when smart routing is OFF. |
| `buildSmartLoop` (app.js:648) | **Replace** with junction-based version. Same name, same signature, same return shape. |
| `fetchRoadsInCorridor` (app.js:507) | **Replace** with `fetchCorridorRoadData`. Same signature; return shape changes to `{ junctions: [{lat, lng}, …], wayCenters: [{lat, lng}, …] }` (unified call producing both pools). |
| `classifyRoads` (app.js:365) | Keep. Reused by junction path. |
| `selectRoadVias` (app.js:379) | Keep. Reused by junction path. |
| `countUTurns` (app.js:567) + u-turn mitigation block (app.js:696) | **Delete.** Junction vias remove the cause; the mitigation is dead weight and adds OSRM calls. |
| `fetchNearestRoadSnaps` (app.js:574) | Delete if u-turn mitigation is the only caller. (Verify in implementation.) |
| Smart-routing toggle in UI | Keep label, keep behavior. Internally now junction-based. |

## 5. Components

### 5.1 `fetchCorridorRoadData(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode)`

Same signature as the function it replaces (`fetchRoadsInCorridor`). Returns `{ junctions: [{lat, lng}, …], wayCenters: [{lat, lng}, …] }` — both pools computed from a single Overpass response. Junctions are the preferred via candidates; way centers are the fallback pool used per-slot when the closest junction is too far from the geometric ideal (see §5.2).

**Overpass query (one request):**

```
[out:json][timeout:15];
way["highway"]["highway"!~"<exclude>"](<bbox>);
out body;
>;
out skel qt;
```

This returns:
1. All matching ways (each carrying its `nodes: [id, id, …]` array).
2. All referenced nodes (each with `id, lat, lon`) — the `>;` recurses ways into nodes, `out skel qt` emits just node id + position.

The `<exclude>` filter and `<bbox>` are computed exactly as in the current `fetchRoadsInCorridor` (winter-mode highway exclusion list, corridor bbox padded by `offsetKm`).

**Client-side junction extraction:**

```
nodeWayCount = Map<nodeId, integer>
for each way in elements where way.type === 'way':
    for each nodeId in way.nodes:
        nodeWayCount[nodeId]++

junctions = []
for each node in elements where node.type === 'node':
    if nodeWayCount[node.id] >= 2:
        junctions.push({ lat: node.lat, lng: node.lon })

return junctions
```

Memory is fine: a corridor in Helsinki center returns at most a few thousand ways and tens of thousands of node refs — trivially handled in JS.

### 5.2 Low-density fallback

In sparse areas (suburbs, forest edges) the closest junction to a geometric-ideal via may be far enough away that the loop shape collapses. To preserve loop shape in those cases:

- After `selectRoadVias` picks a junction for a given geometric ideal, measure `distance(junction, geometricIdeal)`.
- If that distance exceeds a threshold (proposal: `max(0.5 km, offsetKm * 0.6)`), fall back to a way-center candidate (re-run the old way-center selection just for that one slot).
- Stubs may then occur in those slots, but they were occurring already in low-density areas and the loop shape is more visually important than stub-freeness in such regions.

Threshold tuning is deferred to implementation — the design fixes the rule, not the constants.

`fetchCorridorRoadData` returns both pools from a single Overpass response: junctions are extracted from nodes referenced by ≥2 ways, and way centers are computed client-side as the mean lat/lng of each way's referenced nodes. No second Overpass call is needed.

### 5.3 `buildSmartLoop` (replacement)

Same signature, same return shape, same caller integration. Internal flow:

1. `onProgress('Searching for junctions…')`
2. Fetch junctions + way centers via the unified corridor call (or use `cachedRoads`, now containing both pools).
3. Compute geometric ideal vias (existing `envelopeOffsetPoint` logic, unchanged).
4. `classifyRoads` on the junction list → `{ left, right }`.
5. For each side: `selectRoadVias(junctions[side], geometricVias)` produces 3 picks.
6. For any pick whose distance from its geometric ideal exceeds the fallback threshold, replace it with the closest way-center on the same side.
7. `onProgress('Building outbound route…')` → `fetchRouteThrough([A, ...rightVias, B])`.
8. `onProgress('Building return route…')` → `fetchRouteThrough([B, ...leftVias, A])`.
9. If either route fails, fall back to `buildLoop` (same as today).
10. Return `{ outbound, return, outboundVias, returnVias, roads }` (where `roads` is the unified `{ junctions, wayCenters }` payload for caching).

**Removed:** the u-turn detection + mitigation rounds. Junction selection eliminates the cause; mitigation is no longer needed.

### 5.4 Caching shape change

`currentSession.cachedRoads` previously held `[{lat, lng}, …]` (way centers). It now holds `{ junctions: [...], wayCenters: [...] }`. Spread-slider re-routes that previously skipped Overpass continue to work — the cached payload is just richer.

## 6. UX / UI

- Smart-routing toggle label and position unchanged.
- Loading text changes: `"Searching for roads…"` → `"Searching for junctions…"` (cosmetic, optional).
- No new settings, no new sliders, no schema changes for saved settings or backup sync.

## 7. Testing

- **Manual smoke tests** in three representative areas:
  - Helsinki center (dense grid) — the case shown in the failing screenshots.
  - A suburban area with a mix of dense and sparse — exercises the fallback.
  - A rural / forest-edge case — exercises the fallback at the limit and confirms no regression vs current behavior.
- For each: confirm visible loop shape, confirm no within-leg stub artifacts.
- **No backend test changes.** Backend (`server/`) is unaffected.
- **Frontend tests:** the existing `tests/sync.test.js` is unrelated and unchanged. No new tests are required for this design — junction extraction is straightforward client-side counting and the integration is checked manually as above.

## 8. Risks & open questions

- **Junction density in sparse areas.** The fallback handles this, but the threshold (`max(0.5 km, offsetKm * 0.6)`) is a guess. Implementation phase will tune it on real cases.
- **Junctions on cul-de-sacs of cul-de-sacs.** A junction connecting two short stub roads is technically still a junction but the local neighborhood is dead-end-ish. OSRM still has a non-U-turn option (enter on one stub, exit on the other), so the worst case is an inelegant detour rather than a lollipop. Acceptable.
- **Overpass response size.** `out body; >; out skel qt;` over a corridor in Helsinki center is meaningfully larger than the current `out center` query (full node data vs. one center per way). Should still be well under Overpass response limits at typical wander radii (few km), but worth eyeballing during implementation. If it becomes a problem, query optimization is a separate concern.

## 9. Out of scope

- Geometric polyline-fold detection as a last-resort safety net for stubs that slip through. Captured as a follow-up idea, not part of this design.
- Replacing or modifying `buildLoop`. Explicitly off-limits per the user.
- OSRM `alternatives=true`, single-anchor routing, search-N-routes — all considered and rejected above.
