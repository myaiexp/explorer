// Route to a destination the user already has — the two "we know where we're
// going" flows: build a route to a chosen point (pick-on-map, shared link) and
// re-display a stored history/favorite entry. Loaded after route-view.js
// (displayRoute/getSpreadParams), route-dispatch.js (buildRouteForMode),
// map-view.js (clearMap) and history.js (saveToHistory); resolved as globals at
// call time. Neither picks a destination — that's generate.js.

// Shared 'clear → build → display → stash junctions' body for pick-on-map and
// shared-link restore. Both clear the map, build a route for the chosen trip mode
// (smart-routing read from the DOM, never for one-way), render it, and stash the
// junction pool on the new session. Callers differ only in where start/label/
// destName/tripMode come from and which progress message precedes the build:
//   loadingMessage   emitted via onProgress before the build (unconditional)
//   buildingMessage  forwarded to buildRouteForMode (shown for non-smart builds)
async function buildAndDisplay(startLat, startLng, destLat, destLng, {
    tripMode, locationInput, destName, onProgress,
    loadingMessage = null, buildingMessage = null, poiCategory = null,
}) {
    clearMap();
    if (loadingMessage) onProgress(loadingMessage);
    const smartRouting = tripMode !== 'one-way' && document.getElementById('smartRouting').checked;
    const r = await buildRouteForMode(startLat, startLng, destLat, destLng, {
        tripMode,
        smartRouting,
        winterMode: smartRouting && document.getElementById('winterMode').checked,
        maxKm: parseFloat(document.getElementById('maxDistance').value),
        onProgress,
        cachedJunctions: null,
        buildingMessage,
        spread: getSpreadParams(),
    });
    const session = displayRoute({
        startLat, startLng, destLat, destLng,
        outbound: r.outbound, ret: r.return,
        locationInput, destName, tripMode,
        poiCategory: poiCategory ?? null,
    });
    session.junctions = r.junctions;
    // Same gate as generateDestination: a dest with no outbound leg is a
    // dashed straight-line fallback, not a walkable route worth persisting.
    if (r.outbound) saveToHistory(session);
}

// Re-display a stored history/favorite entry. Lives here rather than in
// history.js because it is a render, not history CRUD — favorites.js used to
// depend on history.js solely to reach it.
function restoreResult(entry) {
    clearMap();
    // Prefer the real per-leg distances when the entry has them. Legacy entries
    // (saved before per-leg distances existed, or pulled from the cloud where
    // only the total is stored) fall back to assigning the whole total to the
    // outbound leg — numerically correct for the displayed total, which is all
    // displayRoute renders.
    //
    // UNITS: this is the km→metres boundary back into OSRM shape. Persisted
    // entry fields (distance / routeDistance / returnRouteDistance) are
    // KILOMETRES; the fake route objects below must carry METRES, because
    // displayRoute feeds them to computeRouteTotals, which divides by 1000.
    const hasLegDist = typeof entry.routeDistance === 'number';
    const outbound = entry.routeCoords
        ? { coords: entry.routeCoords,
            distance: (hasLegDist ? entry.routeDistance : entry.distance) * 1000,
            duration: entry.routeDuration || 0 }
        : null;
    const ret = entry.returnRouteCoords
        ? { coords: entry.returnRouteCoords,
            distance: (hasLegDist ? (entry.returnRouteDistance || 0) : 0) * 1000,
            duration: entry.returnRouteDuration || 0 }
        : null;
    // No saveToHistory here: re-displaying an existing history/favorite entry
    // must not create a new one (the old side effect in displayRoute did).
    displayRoute({
        startLat: entry.startLat, startLng: entry.startLng,
        destLat: entry.destLat, destLng: entry.destLng,
        outbound, ret,
        locationInput: entry.startLabel, destName: entry.destName, tripMode: entry.tripMode,
        poiCategory: entry.poiCategory ?? null,
    });
}

globalThis.buildAndDisplay = buildAndDisplay;
globalThis.restoreResult = restoreResult;
