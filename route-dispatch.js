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
//   tripMode         'one-way' | anything-else (a loop). One-way returns before
//                    the loop branch. A round trip is a junction loop unless
//                    degraded — there is no second flag for that choice.
//   winterMode       bool — forwarded to buildJunctionLoop (junction loops only)
//   maxKm            number — caller's max-distance budget; forwarded to
//                    buildJunctionLoop for the corridor cache key (junction loops only)
//   onProgress       msg => void — forwarded to buildJunctionLoop; also used
//                    to emit buildingMessage (see below)
//   cachedJunctions  prior junction pool to reuse (junction loops only); default null
//   buildingMessage  if set, emitted via onProgress before the one-way / plain
//                    loop builds; junction loops report their own progress from
//                    buildJunctionLoop, so the message is skipped there. default null
//   spread           precomputed { offsetMult, viaTs } (computeSpreadParams);
//                    forwarded to buildLoop / buildJunctionLoop so the routing
//                    layer stays DOM-free. Required for loop builds — callers pass
//                    getSpreadParams(); omitting it makes the loop builders throw.
//   degraded         bool — Layer 2 of the shelly-down pipeline reduction
//                    (osrm.js's isSelfHostedDown() latch, read once by
//                    route-view.js's readRouteBuildOptions and passed down from
//                    there). A degraded round trip takes the plain loop, which
//                    skips its /nearest snap, and skips the junction fetch:
//                    junctions-cache lives on the same machine as the OSRM the
//                    latch just gave up on. buildRouteForDestination
//                    short-circuits before findBestLoop on the generate path;
//                    spread-control.js and route-restore.js call this function
//                    directly, so the gate has to exist here too. Default false.
//   avoidBacktracking  bool — the #avoidBacktracking checkbox, read by
//                    route-view.js's readRouteBuildOptions. Widens the loop
//                    envelope and keeps the via snap inside it (see osrm.js's
//                    loop envelope constants). Forwarded to BOTH loop branches:
//                    it is pure geometry, so it applies equally to a junction
//                    loop and a plain one, and one-way has no envelope to widen.
//
// Returns { outbound, return, junctions }. junctions is null except for the
// junction-loop branch, which returns the pool buildJunctionLoop used or fetched.
async function buildRouteForMode(startLat, startLng, destLat, destLng, {
    tripMode, winterMode, maxKm, onProgress,
    cachedJunctions = null, buildingMessage = null, spread = undefined, degraded = false,
    avoidBacktracking = false,
} = {}) {
    if (tripMode === 'one-way') {
        if (buildingMessage && onProgress) onProgress(buildingMessage);
        const outbound = await buildOneWay(startLat, startLng, destLat, destLng);
        return { outbound, return: null, junctions: null };
    }
    if (!degraded) {
        const result = await buildJunctionLoop(
            startLat, startLng, destLat, destLng,
            { maxKm, onProgress, cachedJunctions, winterMode, spread, avoidBacktracking });
        return { outbound: result.outbound, return: result.return, junctions: result.junctions };
    }
    if (buildingMessage && onProgress) onProgress(buildingMessage);
    const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { degraded, avoidBacktracking });
    return { outbound: loop.outbound, return: loop.return, junctions: null };
}

globalThis.buildRouteForMode = buildRouteForMode;
