# Road-Aware Loop Routing Implementation Plan

**Goal:** Replace geometric via-point placement with road-sourced vias, detect/fix u-turns, and show step-by-step loading progress.

**Architecture:** Keep the 3-via-per-side oval shape but pick vias from actual Overpass road data instead of empty geometry. After routing, scan OSRM step maneuvers for u-turns. When found, try alternative road snaps via OSRM `nearest` service. Loading UI shows each phase.

**Tech Stack:** Vanilla JS, OSRM route + nearest APIs, Overpass API (existing)

---

### Task 1: Geometry helpers — left/right classification and road-via matching

[Mode: Direct]

**Files:**
- Modify: `app.js` (add functions after the existing geometry section ~line 325)

**Contracts:**
```javascript
// Cross-product sign determines which side of line A→B point P falls on
// Returns 1 (left), -1 (right), or 0 (on line)
function classifyPointSide(aLat, aLng, bLat, bLng, pLat, pLng) → number

// Split road points into left/right arrays relative to start→dest line
function classifyRoads(roads, startLat, startLng, destLat, destLng) → { left: [], right: [] }

// From roads on one side, pick the 3 closest to the geometric ideal via positions
// geometricVias = array of {lat, lng} (the envelope-offset targets)
// Returns 3 {lat, lng} from roads, or geometric fallback if insufficient roads
function selectRoadVias(roads, geometricVias) → [{lat, lng}, {lat, lng}, {lat, lng}]
```

**Constraints:**
- `selectRoadVias` must fall back to geometric vias when fewer than 3 roads exist on a side
- Nearest-neighbor matching: for each geometric via, find the single closest road point (Haversine via existing `calculateDistance`)
- Don't reuse the same road point for multiple vias — once picked, remove from candidates

---

### Task 2: Fetch roads in route corridor

[Mode: Direct]

**Files:**
- Modify: `app.js` (add function near existing `fetchRoadsInRadius` ~line 389)

**Contracts:**
```javascript
// Fetch roads in the corridor between start and dest, expanded by offsetKm on each side
// Reuses the same Overpass query pattern as fetchRoadsInRadius but with a route-corridor bbox
// Returns array of {lat, lng} road center points
async function fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm) → [{lat, lng}, ...]
```

**Constraints:**
- Bbox: min/max of start+dest lat/lng, expanded by `offsetKm / 111` (+ lng cos correction) on all sides
- Same Overpass filters as `fetchRoadsInRadius`: exclude motorway, trunk, service, steps
- No distance filter needed (the bbox IS the filter)
- Respect existing Overpass error handling pattern

---

### Task 3: Enhanced OSRM routing with step data and u-turn detection

[Mode: Direct]

**Files:**
- Modify: `app.js` — update `fetchRouteThrough` (~line 429), add detection function

**Changes to `fetchRouteThrough`:**
- Add `steps=true&continue_straight=true` to the OSRM URL
- Parse and return `steps` array from the response (maneuver data)
- Return shape becomes: `{ coords, duration, distance, steps }` (steps is optional, null if unavailable)

**New function:**
```javascript
// Count u-turns in a route's step data
// Returns number of steps where maneuver modifier === "uturn"
function countUTurns(steps) → number
```

**Constraints:**
- `steps` may be nested inside `legs[].steps[]` — OSRM route response has legs, each with steps
- Must not break existing callers — `steps` is an additive field
- `continue_straight=true` goes on the URL query string

---

### Task 4: OSRM nearest service for via alternatives

[Mode: Direct]

**Files:**
- Modify: `app.js` (add near the OSRM section)

**Contracts:**
```javascript
// Fetch up to `count` nearest road snap points from OSRM nearest service
// OSRM nearest URL: base_url.replace('/route/', '/nearest/') + `/{lng},{lat}?number={count}`
// Returns array of {lat, lng} sorted by distance, or empty array on failure
async function fetchNearestRoadSnaps(lat, lng, count = 5) → [{lat, lng}, ...]
```

**Constraints:**
- OSRM nearest base URL: derive from `OSRM_BASE` by replacing `/route/` with `/nearest/`
- Coordinate order in URL is `lng,lat` (same as route service)
- Respect `requestDelay` (call `sleep()`)
- Graceful failure: return empty array if endpoint unavailable or errors

---

### Task 5: Main routing orchestrator — `buildSmartLoop`

[Mode: Delegated]

**Files:**
- Modify: `app.js` — new function replacing `buildLoop`, plus integration

**Contract:**
```javascript
// Build a round-trip loop using road-sourced vias with u-turn mitigation
// onProgress(message) callback updates loading text
// cachedRoads: optional previously-fetched roads (for spread slider re-routes)
// Returns { outbound, return, outboundVias, returnVias, roads }
//   outbound/return: same shape as before ({coords, duration, distance, steps})
//   outboundVias/returnVias: the actual via coords used (for Google Maps URL)
//   roads: the fetched road data (for caching)
async function buildSmartLoop(startLat, startLng, destLat, destLng, onProgress, cachedRoads = null) → object
```

**Algorithm:**
1. `onProgress('Searching for roads…')` → fetch roads via `fetchRoadsInCorridor` (or use `cachedRoads`)
2. Compute geometric via targets using existing `getSpreadParams` + `envelopeOffsetPoint`
3. Classify roads into left/right via `classifyRoads`
4. Match to road vias via `selectRoadVias` (per side)
5. `onProgress('Building outbound route…')` → route outbound with road vias
6. `onProgress('Building return route…')` → route return with road vias
7. Count u-turns in both routes via `countUTurns`
8. If u-turns > 0 (max 2 adjustment rounds):
   - `onProgress('Optimizing route…')`
   - For each via near a u-turn: call `fetchNearestRoadSnaps`, try alternatives
   - Re-route the affected leg, keep if fewer u-turns
9. Return full result with vias and roads for caching

**Constraints:**
- Max 2 optimization rounds to cap API calls
- Preserve `requestDelay` between all OSRM calls
- Fall back to geometric vias entirely if road fetch fails
- The `onProgress` callback is the loading text updater

---

### Task 6: Wire into UI — generateDestination, rerouteWithCurrentSpread, buildDirectionsUrl

[Mode: Delegated]

**Files:**
- Modify: `app.js` — update `generateDestination` (~line 816), `rerouteWithCurrentSpread` (~line 1383), `buildDirectionsUrl` (~line 662), `displayRoute` (~line 686)

**Changes:**

1. **`generateDestination`**: Replace `buildLoop()` call with `buildSmartLoop()`, passing a progress callback that sets `loadingEl.querySelector('p').textContent`

2. **`rerouteWithCurrentSpread`**:
   - Store `roads` from `buildSmartLoop` result in `currentSession.cachedRoads`
   - Pass `currentSession.cachedRoads` to `buildSmartLoop` on re-route (skip re-fetching Overpass)

3. **`displayRoute`**: Store `outboundVias` and `returnVias` in `currentSession`

4. **`buildDirectionsUrl`**:
   - Accept optional `outboundVias` and `returnVias` params
   - Use stored vias from `currentSession` instead of recomputing geometric ones
   - Fall back to geometric computation if vias not available

5. **Pick mode handler** (~line 925): Also use `buildSmartLoop` instead of `buildLoop`

**Constraints:**
- `currentSession` must include: `outboundVias`, `returnVias`, `cachedRoads`
- Bump cache-bust query string in index.html (`?v=3`)

---

### Task 7: Loading UI polish

[Mode: Direct]

**Files:**
- Modify: `app.js` — loading messages are already set inline; just ensure the `onProgress` callback pattern works cleanly in all code paths (generate, pick mode, shared URL restore, spread re-route)

**Loading message sequence for round trips:**
```
"Searching for roads…"
"Building outbound route…"
"Building return route…"
"Optimizing route…"          ← only if u-turns detected
"Optimizing route (retry)…"  ← only if still u-turns after first fix
```

**For one-way trips:** No change (still "Building route…")

**For spread slider re-routes:**
```
"Adjusting route…"           ← roads already cached, skip search message
"Optimizing route…"          ← only if needed
```

---

## Execution
**Skill:** superpowers:subagent-driven-development
- Mode A tasks (1, 2, 3, 4, 7): Opus implements directly — straightforward, clear contracts
- Mode B tasks (5, 6): Dispatched to subagents — multiple integration points, needs codebase exploration
