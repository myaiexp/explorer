// Route-build dispatch by trip mode — picks buildOneWay / buildJunctionLoop / buildLoop.
// Loaded after screening.js, before app.js. Reads no DOM: all mode flags are
// passed in. The three builders are resolved from the global scope at call
// time (the browser exposes top-level function declarations on window; tests
// install fakes on globalThis).

// Dispatch a single route build for the given trip mode. Replaces the if/else
// block that was duplicated across generateDestination, the pick-on-map
// handler, restoreFromHash and rerouteWithCurrentSpread.
//
// opts:
//   tripMode         'one-way' | anything-else (a loop)
//   smartRouting     bool — junction-snapped loop vs plain envelope loop
//   winterMode       bool — forwarded to buildJunctionLoop (smart loops only)
//   maxKm            number — caller's max-distance budget; forwarded to
//                    buildJunctionLoop for the corridor cache key (smart loops only)
//   onProgress       msg => void — forwarded to buildJunctionLoop; also used
//                    to emit buildingMessage (see below)
//   cachedJunctions  prior junction pool to reuse (smart loops only); default null
//   buildingMessage  if set, emitted via onProgress before the one-way / plain
//                    loop builds; smart loops report their own progress from
//                    buildJunctionLoop, so the message is skipped there. default null
//   spread           precomputed { offsetMult, viaTs } (computeSpreadParams);
//                    forwarded to buildLoop / buildJunctionLoop so the routing
//                    layer stays DOM-free. Required for loop builds — callers pass
//                    getSpreadParams(); omitting it makes the loop builders throw.
//   degraded         bool — Layer 2 of the shelly-down pipeline reduction
//                    (osrm.js's isSelfHostedDown() latch, read once by
//                    route-view.js's readRouteBuildOptions and passed down from
//                    there). Forwarded to buildLoop, which skips its /nearest
//                    snap when true. Only the plain-loop branch takes it —
//                    smart round-trips never reach here while degraded;
//                    destination-resolve.js short-circuits before this
//                    function's smartRouting check. Default false so
//                    non-degraded callers (and existing tests) are unaffected.
//
// Returns { outbound, return, junctions }. junctions is null except for the
// smart-loop branch, which returns the pool buildJunctionLoop used or fetched.
async function buildRouteForMode(startLat, startLng, destLat, destLng, {
    tripMode, smartRouting, winterMode, maxKm, onProgress,
    cachedJunctions = null, buildingMessage = null, spread = undefined, degraded = false,
} = {}) {
    if (tripMode === 'one-way') {
        if (buildingMessage && onProgress) onProgress(buildingMessage);
        const outbound = await buildOneWay(startLat, startLng, destLat, destLng);
        return { outbound, return: null, junctions: null };
    }
    if (smartRouting) {
        const result = await buildJunctionLoop(
            startLat, startLng, destLat, destLng, { maxKm, onProgress, cachedJunctions, winterMode, spread });
        return { outbound: result.outbound, return: result.return, junctions: result.junctions };
    }
    if (buildingMessage && onProgress) onProgress(buildingMessage);
    const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { degraded });
    return { outbound: loop.outbound, return: loop.return, junctions: null };
}

globalThis.buildRouteForMode = buildRouteForMode;
