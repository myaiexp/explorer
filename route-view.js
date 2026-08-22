// The route view — render a resolved route onto the map + result panel and make
// it the current session.
//
// Loaded after map-view.js (markers/polylines/route color), session.js
// (computeRouteTotals/routeSessionFields), elevation.js, geometry.js,
// session-state.js, favorites.js and result-panel.js — all resolved as globals at
// call time. Every path that puts a route on screen ends up in displayRoute:
// generate.js directly, pick-mode.js / share-link.js / the history + favorites
// lists via route-restore.js, and spread-control.js via renderRouteTail.

// ─── Spread slider (UI) ───────────────────────────────────────────────────────

// UI-layer wrapper: read the spread slider and compute its params (the pure
// computeSpreadParams lives in geometry.js). Lives here because every route
// build reads it and buildDirectionsUrl below needs it; spread-control.js layers
// the auto-reroute behaviour on top of this module rather than the other way
// round, so the dependency stays one-directional.
function getSpreadParams() {
    return computeSpreadParams(parseInt(document.getElementById('spreadSlider').value, 10));
}

// Routing-mode form state — the one DOM read for smart / winter / maxKm / spread.
// buildAndDisplay, rerouteWithCurrentSpread, and generateDestination used to
// each re-read these; a new flag (or a one-way/smart interaction) could land
// on pick-on-map and miss spread-reroute. smartRouting is off for one-way
// (no junctions to snap). winterMode is the checkbox as-is: dest-pool road
// filtering is independent of smart routing, and buildRouteForMode only
// consults winterMode on the smart-loop branch.
function readRouteBuildOptions(tripMode) {
    return {
        tripMode,
        smartRouting: tripMode !== 'one-way' && document.getElementById('smartRouting').checked,
        winterMode: document.getElementById('winterMode').checked,
        maxKm: parseFloat(document.getElementById('maxDistance').value),
        spread: getSpreadParams(),
    };
}

// Trip-mode distance label — the number the user types is one-way km or
// round-trip km depending on the radio. form-controls.js (change) and
// settings.js (restore) both call this so the two strings live in one place.
function syncDistanceLabel() {
    const isOneWay = document.getElementById('oneWay').checked;
    document.getElementById('distanceLabel').textContent =
        isOneWay ? 'One-way distance (km)' : 'Round-trip distance (km)';
}

// ─── Duration badges ──────────────────────────────────────────────────────────

function updateDurationBadges(totalWalkKm, walkDurationSec, tripMode) {
    const label = tripMode === 'one-way' ? 'one way' : 'round trip';
    document.getElementById('distanceBadge').textContent = `${totalWalkKm.toFixed(1)} km ${label}`;

    const walkEl = document.getElementById('walkBadge');
    if (walkDurationSec > 0) {
        walkEl.textContent = `🚶 ~${Math.round(walkDurationSec / 60)} min`;
        walkEl.style.display = 'inline-block';
    } else {
        walkEl.style.display = 'none';
    }

    const bikeEl = document.getElementById('bikeBadge');
    const carEl  = document.getElementById('carBadge');
    if (totalWalkKm > 0) {
        bikeEl.textContent = `🚲 ~${Math.round(totalWalkKm / 15 * 60)} min`;
        bikeEl.style.display = 'inline-block';
        carEl.textContent  = `🚗 ~${Math.round(totalWalkKm / 35 * 60)} min`;
        carEl.style.display  = 'inline-block';
    } else {
        bikeEl.style.display = 'none';
        carEl.style.display  = 'none';
    }
}

// ─── Google Maps directions URL ──────────────────────────────────────────────

function buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode) {
    const base = 'https://www.google.com/maps/dir/?api=1&travelmode=walking';
    if (tripMode === 'one-way') {
        return `${base}&origin=${startLat},${startLng}&destination=${destLat},${destLng}`;
    }

    // Round-trip: reuse osrm.js's loopVias so the Google Maps link traces the
    // same oval the in-app route does — one source for the envelope geometry.
    // The return leg walks the left side back toward the start, so reverse it.
    const { rightVias: outVias, leftVias } = loopVias(startLat, startLng, destLat, destLng, getSpreadParams());
    const retVias = leftVias.slice().reverse();

    const waypoints = [
        ...outVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`),
        `${destLat.toFixed(6)},${destLng.toFixed(6)}`,
        ...retVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)
    ].join('|');

    return `${base}&origin=${startLat},${startLng}&destination=${startLat},${startLng}&waypoints=${waypoints}`;
}

// ─── Display route results on map ────────────────────────────────────────────

// Shared render tail for the two route-drawing paths — first render (displayRoute)
// and spread reroute (rerouteWithCurrentSpread): draw the outbound + return
// polylines in the glow style, fit the map to them, update the duration badges +
// Google Maps directions link, and kick off the (non-blocking) elevation refetch.
// Returns the computed { totalWalkKm, totalDuration } so callers can stamp the
// session. `fallbackStraight` draws the dashed straight-line placeholder when
// there are no route coords — first render only; reroute passes false so a spread
// change that yields no route simply leaves the previous view in place.
function renderRouteTail(startLat, startLng, destLat, destLng, outbound, ret, tripMode, color, { fallbackStraight = false } = {}) {
    // Outbound + return read as one continuous walk; direction is conveyed by
    // the start dot vs dest pin.
    const allCoords = drawRoutePair(outbound, ret, color);
    if (allCoords.length === 0 && fallbackStraight) {
        drawRouteGlow([[startLat, startLng], [destLat, destLng]], color, { dashed: true });
        allCoords.push([startLat, startLng], [destLat, destLng]);
    }
    if (allCoords.length > 0) {
        map.fitBounds(L.latLngBounds(allCoords).pad(0.15));
    }

    const straightKm = haversineKm(startLat, startLng, destLat, destLng);
    const { totalWalkKm, totalDuration } =
        computeRouteTotals(outbound, ret, straightKm, tripMode);
    updateDurationBadges(totalWalkKm, totalDuration, tripMode);

    document.getElementById('directionsLink').href =
        buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode);

    // Fetch elevation profile (non-blocking); hide any stale chart while it loads.
    const routeCoords = [
        ...(outbound ? outbound.coords : []),
        ...(ret ? ret.coords : [])
    ];
    if (routeCoords.length > 0) {
        document.getElementById('elevationContainer').classList.remove('active');
        fetchElevations(routeCoords)
            .then(el => renderElevationChart(el, color))
            .catch(() => {});
    }

    return { totalWalkKm, totalDuration };
}

// Render a resolved route on the map + result panel and set it as the current
// session. Pure display + session build — it does NOT persist. Callers that
// create a genuinely new route (generateDestination, buildAndDisplay) call
// saveToHistory(session) themselves; restoreResult re-displays an existing entry
// and so must NOT (this function used to unshift a duplicate history entry and
// sync it to the cloud as a side effect of every history/favorite click).
// Returns the built session (also stored via session-state.js).
function displayRoute({ startLat, startLng, destLat, destLng, outbound, ret,
                        locationInput, destName, tripMode, straightMax = 0, straightMin = 0,
                        poiCategory = null }) {
    const routeColor = getRouteColor();

    // Markers + radius circles (map-view.js owns the mutable Leaflet state).
    addStartMarker(startLat, startLng, locationInput);
    addDestMarker(destLat, destLng, routeColor);
    addRadiusCircles(startLat, startLng, straightMax, straightMin);

    // Draw polylines, fit bounds, badges, directions link, elevation.
    const { totalWalkKm } = renderRouteTail(
        startLat, startLng, destLat, destLng, outbound, ret, tripMode, routeColor,
        { fallbackStraight: true });

    // Result panel (dest-specific bits the reroute path doesn't touch)
    const nameEl = document.getElementById('destName');
    if (destName) {
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(destName)}/@${destLat},${destLng},17z`;
        const a = document.createElement('a');
        a.href = mapsUrl;
        a.target = '_blank';
        a.textContent = destName;
        nameEl.replaceChildren(a);
        nameEl.style.display = 'block';
    } else {
        nameEl.replaceChildren();
        nameEl.style.display = 'none';
    }

    document.getElementById('destCoords').textContent =
        `${destLat.toFixed(6)}, ${destLng.toFixed(6)}`;
    document.getElementById('streetViewLink').href =
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${destLat},${destLng}`;

    document.getElementById('resultPanel').classList.add('active');

    const session = setCurrentSession({
        startLat, startLng, startLabel: locationInput,
        destLat, destLng, destName: destName || null,
        tripMode: tripMode || 'round',
        // Caller-supplied — never the live #locationTypeSelect. Restore /
        // pick-on-map / share-link have no category of their own and pass
        // null; generateDestination forwards the dropdown that produced the dest.
        poiCategory: poiCategory ?? null,
        distance: totalWalkKm,
        ...routeSessionFields(outbound, ret),
    });

    // Panel state that follows from the session, in one place — every entry
    // point (generate, pick-on-map, shared link, history/favorite restore) gets
    // the same derivation instead of setting the buttons itself.
    updateFavoriteBtn();
    syncMarkVisitedBtn();
    return session;
}

globalThis.getSpreadParams = getSpreadParams;
globalThis.readRouteBuildOptions = readRouteBuildOptions;
globalThis.syncDistanceLabel = syncDistanceLabel;
globalThis.updateDurationBadges = updateDurationBadges;
globalThis.buildDirectionsUrl = buildDirectionsUrl;
globalThis.renderRouteTail = renderRouteTail;
globalThis.displayRoute = displayRoute;
