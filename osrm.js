// OSRM routing + loop building — self-hosted OSRM-foot wrappers (route / nearest
// / table), road/junction snapping, and the envelope/junction loop builders.
// No DOM: callers pass a precomputed `spread`. Loaded after geometry.js (for
// calculateDistance / envelopeOffsetPoint / computeSpreadParams) and
// loop-quality.js (for loopOverlapFraction), before route-dispatch.js + app.js.

// Self-hosted OSRM-foot for Finland.
const OSRM_FI_BASE    = 'https://mase.fi/api/osrm-fi/route/v1/foot';
const OSRM_FI_NEAREST = 'https://mase.fi/api/osrm-fi/nearest/v1/foot';
const OSRM_FI_TABLE   = 'https://mase.fi/api/osrm-fi/table/v1/foot';

// Internal: fetch + parse OSRM /route response. Returns null on any failure.
async function tryOsrm(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.routes || data.routes.length === 0) return null;
        const r = data.routes[0];
        const steps = r.legs ? r.legs.flatMap(leg => leg.steps || []) : null;
        return {
            coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
            duration: r.duration,
            distance: r.distance,
            steps: steps
        };
    } catch { return null; }
}

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance, steps} or null.
async function fetchRouteThrough(waypoints) {
    const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
    const query = `${coordStr}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
    return tryOsrm(`${OSRM_FI_BASE}/${query}`);
}

// Internal: OSRM /nearest call. Returns {lat, lng} or null on any failure.
async function tryNearest(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.waypoints || !data.waypoints.length) return null;
        return { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
    } catch { return null; }
}

// Snap a geometric via to the nearest road point within maxKm.
// Returns the snapped point, or the original if snapping fails or is too far.
async function snapToRoad(via, maxKm = 0.5) {
    const snapped = await tryNearest(`${OSRM_FI_NEAREST}/${via.lng},${via.lat}?number=1`);
    if (!snapped) return via;
    const dist = calculateDistance(via.lat, via.lng, snapped.lat, snapped.lng);
    return dist <= maxKm ? snapped : via;
}

// Adapter for screenCandidates' tableFn contract: one OSRM /table call
// returns snap distance + route distance for every candidate at once,
// replacing N parallel /nearest + N parallel /route calls.
//
// `destinations[i].distance` is OSRM's snap distance for input coord i;
// `distances[0][i]` is the route distance from source[0] to coord i.
// Both arrays include source[0] at index 0, so candidate i lives at i+1.
async function screeningTableFn(start, candidates) {
    if (candidates.length === 0) return [];
    const coords = [
        `${start.lng},${start.lat}`,
        ...candidates.map(c => `${c.lng},${c.lat}`)
    ].join(';');
    const url = `${OSRM_FI_TABLE}/${coords}?sources=0&annotations=distance`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`osrm table http ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error(`osrm table ${data.code}`);
    const dests = data.destinations;
    const dists = data.distances && data.distances[0];
    if (!Array.isArray(dests) || !Array.isArray(dists)) {
        throw new Error('osrm table malformed');
    }
    return candidates.map((_, i) => {
        const d = dests[i + 1];
        const r = dists[i + 1];
        const snapM = d && typeof d.distance === 'number' ? d.distance : null;
        const routeM = typeof r === 'number' ? r : null;
        return { snapM, routeM };
    });
}

// Shared geometry for the two loop builders. Derives the per-side offset, the
// A/B endpoints, the via t-positions, and the snap radius (half the offset,
// floored at 0.3 km) from start/dest + the spread params. Pure — no DOM.
function buildLoopSetup(startLat, startLng, destLat, destLng, spread) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    // Defensive default to the 50% params if a caller omits spread — keeps this
    // pure (no DOM) while every real call path passes an explicit spread.
    const { offsetMult, viaTs } = spread || computeSpreadParams(50);
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    return {
        offsetKm,
        viaTs,
        A: { lat: startLat, lng: startLng },
        B: { lat: destLat,  lng: destLng },
        snapRadius: Math.max(0.3, offsetKm * 0.5),
    };
}

// Pure loop envelope geometry — the single source for the sin-envelope via
// points, shared by both loop builders here and buildDirectionsUrl in app.js
// (which draws the Google Maps link along the same oval). Built on
// buildLoopSetup so the offset formula lives in exactly one place.
// rightVias/leftVias are in forward (A→B) t-order; a leg that walks a side back
// toward A reverses that side at the call site (self-documenting). Spreads the
// setup fields (A, B, snapRadius, offsetKm, viaTs) so callers don't re-derive
// them. Pure — no DOM, no network.
function loopVias(startLat, startLng, destLat, destLng, spread) {
    const setup = buildLoopSetup(startLat, startLng, destLat, destLng, spread);
    const { offsetKm, viaTs } = setup;
    const rightVias = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const leftVias = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
    return { rightVias, leftVias, ...setup };
}

// Build a full oval loop: A → (right vias) → B → (left vias) → A.
// Returns { outbound, return } where each is {coords, duration, distance} or null.
// Builds a single chirality (right-side out, left-side back); buildJunctionLoop
// is the variant that tries both chiralities and picks the lower-overlap one.
// `spread` is the precomputed { offsetMult, viaTs } from computeSpreadParams.
async function buildLoop(startLat, startLng, destLat, destLng, spread) {
    const { rightVias, leftVias, A, B, snapRadius } = loopVias(startLat, startLng, destLat, destLng, spread);

    // Snap all 6 vias to nearest roads in parallel (threshold: half the offset
    // distance). The return leg walks the left side back toward A, so reverse it.
    const allVias = [...rightVias, ...leftVias.slice().reverse()];
    const snapped = await Promise.all(allVias.map(v => snapToRoad(v, snapRadius)));
    const snappedRight = snapped.slice(0, 3);
    const snappedLeft = snapped.slice(3);

    const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
    const ret      = await fetchRouteThrough([B, ...snappedLeft, A]);
    return { outbound, return: ret };
}

// Fetch OSM nodes referenced by ≥2 highway ways inside the corridor between
// start/dest, expanded by offsetKm on each side. Goes through the
// junctions-cache service on shelly (mase.fi/api/junctions) which handles
// Overpass calls + persistent caching.
//
// startLat/startLng + maxKm are sent so the server can cache once per
// (start, radius) instead of per destination bbox; it fetches a wide
// start ± maxKm bbox once and filters to the requested corridor. maxKm is
// the caller's max-distance budget (passed in, never read from the DOM here)
// so this stays pure and the cache key matches the radius the caller works in.
async function fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, maxKm, onProgress, winterMode = false) {
    const minLat = Math.min(startLat, destLat);
    const maxLat = Math.max(startLat, destLat);
    const minLng = Math.min(startLng, destLng);
    const maxLng = Math.max(startLng, destLng);
    const midLat = (minLat + maxLat) / 2;
    const latPad = offsetKm / 111;
    const lngPad = offsetKm / (111 * Math.cos(midLat * Math.PI / 180));
    const bbox = `${minLat - latPad},${minLng - lngPad},${maxLat + latPad},${maxLng + lngPad}`;
    const exclude = winterMode ? 'winter' : 'default';
    const params = new URLSearchParams({ bbox, exclude });
    if (Number.isFinite(maxKm) && maxKm > 0) {
        params.set('startLat', String(startLat));
        params.set('startLng', String(startLng));
        params.set('maxKm', String(maxKm));
    }
    const url = `/api/junctions/junctions?${params.toString()}`;
    if (onProgress) onProgress('Searching for junctions…');
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('POI search is busy. Please try again.');
    }
    const data = await response.json();
    return data.junctions || [];
}

// Find the closest junction in the pool to `via` within maxKm. Returns the
// junction, or the original `via` if no junction is in range.
function snapToJunction(via, junctionPool, maxKm) {
    if (!junctionPool || junctionPool.length === 0) return via;
    let best = null, bestDist = Infinity;
    for (const j of junctionPool) {
        const d = calculateDistance(via.lat, via.lng, j.lat, j.lng);
        if (d < bestDist) { bestDist = d; best = j; }
    }
    return bestDist <= maxKm ? best : via;
}

// Pick lower-overlap of two candidate (outbound, return) pairs. Falls back
// gracefully if one chirality fully failed. Used by buildJunctionLoop's
// both-chirality success path.
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

// Junction-snap variant of buildLoop: same envelope vias, same snap radius,
// but snaps each via to the closest OSM junction in a corridor pool instead
// of OSRM nearest-snap. Builds both chiralities in parallel and returns the
// lower-overlap one. Falls back to buildLoop on Overpass/OSRM failure.
// cachedJunctions: pass a previously returned `junctions` to skip Overpass.
// maxKm: the caller's max-distance budget — forwarded to fetchCorridorJunctions
// for the start-anchored cache key (replaces a former DOM read in that helper).
async function buildJunctionLoop(startLat, startLng, destLat, destLng, maxKm, onProgress, cachedJunctions = null, winterMode = false, spread = undefined) {
    // Forward-order vias on each side (loopVias owns the envelope geometry).
    // Reversal happens at call time on the leg that needs it (return leg).
    const { rightVias: viasRight, leftVias: viasLeft, offsetKm, A, B, snapRadius } =
        loopVias(startLat, startLng, destLat, destLng, spread);

    let junctions = cachedJunctions;
    if (!junctions) {
        try {
            onProgress('Searching for junctions…');
            junctions = await fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, maxKm, onProgress, winterMode);
        } catch {
            const loop = await buildLoop(startLat, startLng, destLat, destLng, spread);
            return { outbound: loop.outbound, return: loop.return, overlap: null, junctions: null };
        }
    }

    const snappedRight = viasRight.map(v => snapToJunction(v, junctions, snapRadius));
    const snappedLeft  = viasLeft .map(v => snapToJunction(v, junctions, snapRadius));

    onProgress('Building both chiralities…');
    const [outA, retA, outB, retB] = await Promise.all([
        fetchRouteThrough([A, ...snappedRight, B]),
        fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
        fetchRouteThrough([A, ...snappedLeft, B]),
        fetchRouteThrough([B, ...snappedRight.slice().reverse(), A]),
    ]);
    const picked = pickBetterLoop(outA, retA, outB, retB);
    if (!picked.outbound || !picked.return) {
        const loop = await buildLoop(startLat, startLng, destLat, destLng, spread);
        return { outbound: loop.outbound, return: loop.return, overlap: null, junctions };
    }
    return { ...picked, junctions };
}

// Build a single routed leg A → B. Returns {coords, duration, distance} or null.
async function buildOneWay(startLat, startLng, destLat, destLng) {
    return fetchRouteThrough([
        { lat: startLat, lng: startLng },
        { lat: destLat,  lng: destLng }
    ]);
}

// Explicit globalThis exports. route-dispatch.js resolves buildOneWay /
// buildJunctionLoop / buildLoop from the global scope at call time, and the
// vm-based tests read these off globalThis.
globalThis.OSRM_FI_BASE = OSRM_FI_BASE;
globalThis.OSRM_FI_NEAREST = OSRM_FI_NEAREST;
globalThis.OSRM_FI_TABLE = OSRM_FI_TABLE;
globalThis.tryOsrm = tryOsrm;
globalThis.fetchRouteThrough = fetchRouteThrough;
globalThis.tryNearest = tryNearest;
globalThis.snapToRoad = snapToRoad;
globalThis.screeningTableFn = screeningTableFn;
globalThis.buildLoopSetup = buildLoopSetup;
globalThis.loopVias = loopVias;
globalThis.buildLoop = buildLoop;
globalThis.fetchCorridorJunctions = fetchCorridorJunctions;
globalThis.snapToJunction = snapToJunction;
globalThis.pickBetterLoop = pickBetterLoop;
globalThis.buildJunctionLoop = buildJunctionLoop;
globalThis.buildOneWay = buildOneWay;
