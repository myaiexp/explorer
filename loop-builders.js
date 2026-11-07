// Loop builders — envelope and junction-snapped round trips, and one-way legs.
// No DOM: callers pass a precomputed `spread`. Loaded after osrm.js
// (fetchRouteThrough, snapToRoad), overpass.js (fetchCorridorJunctions),
// geometry.js (loopVias) and loop-quality.js (loopOverlapFraction), before
// route-dispatch.js + app.js. haversineKm comes from geo-utils.js.

// Build a full oval loop: A → (right vias) → B → (left vias) → A.
// Returns { outbound, return } where each is {coords, duration, distance} or null.
// Builds a single chirality (right-side out, left-side back); buildJunctionLoop
// is the variant that tries both chiralities and picks the lower-overlap one.
// `spread` is the precomputed { offsetMult, viaTs } from computeSpreadParams.
// `degraded` (Layer 2 of the shelly-down pipeline reduction, see osrm-fallback
// tests) skips the /nearest snap entirely and routes through the raw geometric
// vias as-is — while we're already paced onto the public fallback (Layer 1),
// cutting 6 nearest calls down to 0 is a pure work reduction; it never affects
// whether we're allowed to make a request, only how many we make.
async function buildLoop(startLat, startLng, destLat, destLng, spread, { degraded = false, avoidBacktracking = false } = {}) {
    const { rightVias, leftVias, A, B, snapRadius } =
        loopVias(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });

    // The return leg walks the left side back toward A, so reverse it up front —
    // both branches below need it in that order.
    const reversedLeft = leftVias.slice().reverse();

    let snappedRight, snappedLeft;
    if (degraded) {
        snappedRight = rightVias;
        snappedLeft = reversedLeft;
    } else {
        // Snap all 6 vias to nearest roads in parallel (threshold: half the
        // offset distance).
        const allVias = [...rightVias, ...reversedLeft];
        const snapped = await Promise.all(allVias.map(v => snapToRoad(v, snapRadius)));
        snappedRight = snapped.slice(0, 3);
        snappedLeft = snapped.slice(3);
    }

    const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
    const ret      = await fetchRouteThrough([B, ...snappedLeft, A]);
    return { outbound, return: ret };
}

// Find the closest junction in the pool to `via` within snapRadius km.
// Returns the junction, or the original `via` if no junction is in range.
function snapToJunction(via, junctionPool, snapRadius) {
    if (!junctionPool || junctionPool.length === 0) return via;
    let best = null, bestDist = Infinity;
    for (const j of junctionPool) {
        const d = haversineKm(via.lat, via.lng, j.lat, j.lng);
        if (d < bestDist) { bestDist = d; best = j; }
    }
    return bestDist <= snapRadius ? best : via;
}

// Pick lower-overlap of two candidate (outbound, return) pairs. Falls back
// gracefully if one chirality fully failed. Used by buildJunctionLoop's
// both-chirality success path.
function pickBetterLoop(outOnRight, backOnLeft, outOnLeft, backOnRight) {
    const rightOk = outOnRight && backOnLeft;
    const leftOk = outOnLeft && backOnRight;
    if (rightOk && leftOk) {
        const ovRight = loopOverlapFraction(outOnRight.coords, backOnLeft.coords);
        const ovLeft = loopOverlapFraction(outOnLeft.coords, backOnRight.coords);
        return ovRight <= ovLeft
            ? { outbound: outOnRight, return: backOnLeft, overlap: ovRight }
            : { outbound: outOnLeft, return: backOnRight, overlap: ovLeft };
    }
    if (rightOk) {
        const ovRight = loopOverlapFraction(outOnRight.coords, backOnLeft.coords);
        return { outbound: outOnRight, return: backOnLeft, overlap: ovRight };
    }
    if (leftOk) {
        const ovLeft = loopOverlapFraction(outOnLeft.coords, backOnRight.coords);
        return { outbound: outOnLeft, return: backOnRight, overlap: ovLeft };
    }
    return { outbound: null, return: null, overlap: null };
}

// Junction-snap variant of buildLoop: same envelope vias, same snap radius,
// but snaps each via to the closest OSM junction in a corridor pool instead
// of OSRM nearest-snap. Builds both chiralities in parallel and returns the
// lower-overlap one. Falls back to buildLoop on Overpass/OSRM failure.
// The four lat/lng leaders stay positional; the rest is a named-options object:
//   maxKm            the caller's max-distance budget — forwarded to
//                    fetchCorridorJunctions for the start-anchored cache key
//   onProgress       msg => void progress callback
//   cachedJunctions  a previously returned `junctions` pool to skip Overpass
//   winterMode       excludes winter-unmaintained ways from the junction fetch
//   spread           precomputed { offsetMult, viaTs } from computeSpreadParams
//   avoidBacktracking  widens the envelope and keeps the junction snap inside
//                    it (see the loop envelope constants in geometry.js). Forwarded to every
//                    loopVias/buildLoop call below — including BOTH fallbacks,
//                    or a failed junction fetch would silently hand the user the
//                    legacy geometry the toggle exists to replace.
async function buildJunctionLoop(startLat, startLng, destLat, destLng, {
    maxKm, onProgress = () => {}, cachedJunctions = null, winterMode = false, spread = undefined,
    avoidBacktracking = false,
} = {}) {
    // Forward-order vias on each side (loopVias owns the envelope geometry).
    // Reversal happens at call time on the leg that needs it (return leg).
    const { rightVias: viasRight, leftVias: viasLeft, offsetKm, A, B, snapRadius } =
        loopVias(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });

    let junctions = cachedJunctions;
    if (!junctions) {
        try {
            // Only the Overpass fetch — a missing onProgress must not look like a network miss.
            junctions = await fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, maxKm, onProgress, winterMode);
        } catch {
            const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });
            return { outbound: loop.outbound, return: loop.return, overlap: null, junctions: null };
        }
    }

    const snappedRight = viasRight.map(v => snapToJunction(v, junctions, snapRadius));
    const snappedLeft  = viasLeft .map(v => snapToJunction(v, junctions, snapRadius));

    onProgress('Building both chiralities…');
    // First chirality walks out on the right vias and back on the reversed
    // left; the second walks out on the left and back on the reversed right.
    // The return leg is the other side, so these are not "out right / return right".
    const [outOnRight, backOnLeft, outOnLeft, backOnRight] = await Promise.all([
        fetchRouteThrough([A, ...snappedRight, B]),
        fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
        fetchRouteThrough([A, ...snappedLeft, B]),
        fetchRouteThrough([B, ...snappedRight.slice().reverse(), A]),
    ]);
    const picked = pickBetterLoop(outOnRight, backOnLeft, outOnLeft, backOnRight);
    if (!picked.outbound || !picked.return) {
        const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });
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
// buildJunctionLoop / buildLoop from the global scope at call time.
globalThis.buildLoop = buildLoop;
globalThis.snapToJunction = snapToJunction;
globalThis.pickBetterLoop = pickBetterLoop;
globalThis.buildJunctionLoop = buildJunctionLoop;
globalThis.buildOneWay = buildOneWay;
