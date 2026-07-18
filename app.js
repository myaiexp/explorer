// ─── POI types ────────────────────────────────────────────────────────────────

const POI_CATEGORIES = [
    { group: 'Nature & outdoors', pois: [
        { label: 'park',           key: 'park',           filter: '["leisure"="park"]' },
        { label: 'nature reserve', key: 'nature_reserve', filter: '["leisure"="nature_reserve"]' },
        { label: 'forest',         key: 'forest',         filter: '["landuse"="forest"]' },
        { label: 'beach',          key: 'beach',          filter: '["natural"="beach"]' },
        { label: 'viewpoint',      key: 'viewpoint',      filter: '["tourism"="viewpoint"]' },
    ]},
    { group: 'Activity', pois: [
        { label: 'playground',     key: 'playground',     filter: '["leisure"="playground"]' },
        { label: 'sports pitch',   key: 'pitch',          filter: '["leisure"="pitch"]' },
    ]},
    { group: 'Food & drink', pois: [
        { label: 'cafe',           key: 'cafe',           filter: '["amenity"="cafe"]' },
        { label: 'restaurant',     key: 'restaurant',     filter: '["amenity"="restaurant"]' },
        { label: 'pub or bar',     key: 'pub',            filter: '["amenity"~"pub|bar"]' },
    ]},
    { group: 'Culture', pois: [
        { label: 'library',        key: 'library',        filter: '["amenity"="library"]' },
        { label: 'museum',         key: 'museum',         filter: '["tourism"="museum"]' },
        { label: 'historic site',  key: 'historic',       filter: '["historic"]' },
    ]},
];

// Flat lookup for POI definitions. Exposed as a global so destination-resolve.js
// (loaded before app.js) can resolve POI filters/labels at call time.
const POI_TYPES = POI_CATEGORIES.flatMap(c => c.pois);
globalThis.POI_TYPES = POI_TYPES;

// ─── Map view ────────────────────────────────────────────────────────────────
// The Leaflet map, its mutable state (markers/destMarker/circle/innerCircle/
// routeLines), marker/route/circle drawing, the visited-routes overlay, route
// color persistence (getRouteColor/setRouteColor + ROUTE_COLORS), escapeHtml,
// and the pin/here-dot icons live in map-view.js (loaded before app.js). `map`,
// `visitedLayerGroup`, and every draw/clear/render helper are used here as
// globals. visitedLayerVisible (the overlay toggle state) stays here — the
// toggle itself is app.js UI; see toggleVisitedLayer below.
let visitedLayerVisible = true;

// ─── Session state ────────────────────────────────────────────────────────────

// Current in-progress destination (reset on each generation)
let currentSession = null;

// Map-click mode for "pick destination" feature
let pickMode = false;

// ─── Sync helpers ────────────────────────────────────────────────────────────
// maybeRequestConsent + syncedPut/syncedDelete live in sync-helpers.js (loaded
// before app.js); used here (markAsVisited) and by the CRUD modules as globals.

// ─── localStorage ─────────────────────────────────────────────────────────────
// readStoredArray + the array accessors (getVisits, getSavedLocations,
// getFavorites, getHistory) and their storage keys (VISITS_KEY,
// SAVED_LOCATIONS_KEY, FAVORITES_KEY, HISTORY_KEY) live in storage.js (loaded
// before app.js); used here as globals.

// ─── Settings / saved locations ──────────────────────────────────────────────
// Settings persistence (SETTINGS_KEY/SETTINGS_FIELDS + saveSettings/
// restoreSettings/initSettingsListeners) lives in settings.js; saved-locations
// CRUD (toggleSaveLocation/selectSavedLocation/deleteSavedLocation/
// renderSavedLocations/updateSaveLocationBtn) in saved-locations.js. Both loaded
// before app.js; wired in the Init section below.

// ─── Map helpers ─────────────────────────────────────────────────────────────
// createPinIcon/createHereDotIcon, drawRouteGlow/drawRoutePair, clearMap,
// clearRouteLines, addStartMarker/addDestMarker/addRadiusCircles live in
// map-view.js; used below as globals.

// ─── Location helpers ────────────────────────────────────────────────────────

function parseLocation(input) {
    input = input.trim();
    const coordRegex = /^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/;
    const match = input.match(coordRegex);
    if (match) {
        const lat = parseFloat(match[1]);
        const lng = parseFloat(match[2]);
        if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
            return { lat, lng, isAddress: false };
        }
        throw new Error('Invalid coordinates. Latitude must be between -90 and 90, longitude between -180 and 180.');
    }
    return { address: input, isAddress: true };
}

async function geocodeAddress(address) {
    const response = await fetchWithTimeout(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}`
    );
    const data = await response.json();
    if (data.length === 0) {
        throw new Error(`Could not find location: "${address}". Try being more specific or use coordinates instead.`);
    }
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ─── Geolocation ─────────────────────────────────────────────────────────────

function useMyLocation() {
    const btn = document.getElementById('useLocationBtn');
    if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser.');
        return;
    }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            document.getElementById('location').value =
                `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
            btn.disabled = false;
        },
        (err) => {
            showError('Could not get your location: ' + err.message);
            btn.disabled = false;
        },
        { timeout: 10000 }
    );
}

// ─── Geometry ─────────────────────────────────────────────────────────────────
// calculateDistance, bearingRad, envelopeOffsetPoint, generateRandomPointAnnulus
// and computeSpreadParams live in geometry.js (loaded before app.js); used here
// as globals.

// ─── Novelty helpers ──────────────────────────────────────────────────────────
// pickMostNovelDestination lives in destination-resolve.js. getAllExistingDestinations
// stays here — it reads the visits store and is passed down as existingDests.

function getAllExistingDestinations() {
    return getVisits().map(v => [v.destLat, v.destLng]);
}

// ─── Overpass / OSRM ──────────────────────────────────────────────────────────
// Overpass querying (queryOverpass, fetchPOIsInRadius, fetchRoadsInRadius +
// HIGHWAY_EXCLUDE_*) lives in overpass.js. OSRM routing + loop building (tryOsrm,
// fetchRouteThrough, snapToRoad, screeningTableFn, buildLoopSetup, buildLoop,
// fetchCorridorJunctions, snapToJunction, pickBetterLoop, buildJunctionLoop,
// buildOneWay) lives in osrm.js. Both load before app.js; used here as globals.

// ─── Spread slider (UI) ───────────────────────────────────────────────────────

// UI-layer wrapper: read the spread slider and compute its params (the pure
// computeSpreadParams lives in geometry.js). Call sites pass the result into the
// routing layer so the routing functions stay DOM-free.
function getSpreadParams() {
    return computeSpreadParams(parseInt(document.getElementById('spreadSlider').value, 10));
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

// ─── UI helpers ───────────────────────────────────────────────────────────────
// showToast + the showError/showSuccess/showWarning wrappers live in toast.js
// (loaded before app.js); call them directly as globals.

// Run an async task with the global loading spinner active and the generate
// button disabled. Restores both and resets the loading caption in a finally,
// so every caller gets identical setup/teardown even when the task throws.
// Passes `fn` an onProgress(msg) callback that writes the loading caption —
// withLoading already owns #loading, so this replaces the identical closure the
// callers used to define. Callers keep their own error handling (showError).
async function withLoading(fn) {
    const loadingEl = document.getElementById('loading');
    const genBtn = document.getElementById('generateBtn');
    const onProgress = msg => { loadingEl.querySelector('p').textContent = msg; };
    loadingEl.classList.add('active');
    genBtn.disabled = true;
    try {
        return await fn(onProgress);
    } finally {
        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        genBtn.disabled = false;
    }
}

// ─── Cloud-backup UI ──────────────────────────────────────────────────────────

// The cloud-backup UI (showConsentToast + the overflow-menu sync controls:
// enableCloudBackup/copyBackupLink/confirmDeleteCloudData/closeOverflowMenuIfOpen/
// updateSyncMenu, plus the window.ExplorerSyncUI export and the
// explorer-sync-state-change listener) lives in cloud-backup-ui.js.
// resetMarkVisitedBtn stays here — it resets the result panel, not sync state.

function resetMarkVisitedBtn() {
    const btn = document.getElementById('markVisitedBtn');
    btn.classList.remove('marked');
    btn.disabled = false;
    btn.textContent = 'Mark as visited';
    document.getElementById('favoriteBtn').classList.remove('active');
    document.getElementById('elevationContainer').classList.remove('active');
}

// ─── Elevation profile ───────────────────────────────────────────────────────
// fetchElevations + renderElevationChart (Open-Meteo sampling + the hand-built
// SVG chart) live in elevation.js (loaded before app.js). renderElevationChart
// takes the chart color as a param — callers pass getRouteColor(). Used here as
// globals.

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

    const straightDistance = calculateDistance(startLat, startLng, destLat, destLng);
    const { totalWalkKm, totalDuration } =
        computeRouteTotals(outbound, ret, straightDistance, tripMode);
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
// Returns the built session (also stored in the module-global currentSession).
function displayRoute({ startLat, startLng, destLat, destLng, outbound, ret,
                        locationInput, destName, tripMode, straightMax = 0, straightMin = 0 }) {
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

    currentSession = {
        startLat, startLng, startLabel: locationInput,
        destLat, destLng, destName: destName || null,
        tripMode: tripMode || 'round',
        poiCategory: document.getElementById('locationTypeSelect')?.value || null,
        distance: totalWalkKm,
        ...routeSessionFields(outbound, ret),
    };

    updateFavoriteBtn();
    return currentSession;
}

// ─── Resolve start location ──────────────────────────────────────────────────

async function resolveStart() {
    const locationInput = document.getElementById('location').value.trim();
    if (!locationInput) throw new Error('Please enter a starting location.');
    const locationData = parseLocation(locationInput);
    let startLat, startLng;
    if (locationData.isAddress) {
        const coords = await geocodeAddress(locationData.address);
        startLat = coords.lat; startLng = coords.lng;
    } else {
        startLat = locationData.lat; startLng = locationData.lng;
    }
    if (!inFinland(startLat, startLng)) {
        throw new Error('Wander only routes within Finland — pick a starting location inside the country.');
    }
    return { startLat, startLng, locationInput };
}

// ─── Destination resolution ──────────────────────────────────────────────────
// The pipeline — resolveCandidatePool / screenCandidatePool / findBestLoop /
// isBetterLoop / buildRouteForDestination, plus pickMostNovelDestination,
// randomCandidatePool/randomPoolResult and RANDOM_POOL_SIZE/MAX_RETRY_ATTEMPTS —
// lives in destination-resolve.js (loaded before app.js). It reads no DOM:
// generateDestination below reads winterMode/smartRouting and passes them in.

// ─── Main: generate random destination ───────────────────────────────────────

async function generateDestination() {
    const minKm = parseFloat(document.getElementById('minDistance').value) || 0;
    const maxKm = parseFloat(document.getElementById('maxDistance').value);

    if (isNaN(maxKm) || maxKm <= 0) { showError('Please enter a valid maximum distance greater than 0.'); return; }
    if (minKm < 0) { showError('Minimum distance cannot be negative.'); return; }
    if (minKm >= maxKm) { showError('Minimum distance must be less than maximum distance.'); return; }

    document.getElementById('notification').classList.remove('active');
    currentSession = null;
    resetMarkVisitedBtn();

    await withLoading(async (onProgress) => {
        try {
            const { startLat, startLng, locationInput } = await resolveStart();
            clearMap();

            const existingDests = getAllExistingDestinations();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            const rawLocationType = document.getElementById('locationTypeSelect').value;
            // Map the dropdown value to a routing strategy. Known values pass
            // through; anything else is a specific POI key and routes as 'poi'.
            // 'any' is listed explicitly so it stays visible: it resolves to a
            // fully random point anywhere, not to roads or POIs.
            const routingStrategy = ['roads', 'any_poi', 'any'].includes(rawLocationType) ? rawLocationType : 'poi';

            // Straight-line scaling: round trip ≈ budget / 2.6, one-way ≈ budget / 1.3
            const scale = tripMode === 'one-way' ? 1.3 : 2.6;
            const straightMin = minKm / scale;
            const straightMax = maxKm / scale;

            // Mode toggles read once here, at the UI layer, and passed down so
            // the destination-resolve pipeline stays DOM-free.
            const winterMode = document.getElementById('winterMode').checked;
            const smartRouting = document.getElementById('smartRouting').checked;

            // Resolve a candidate pool, then screen it for water-reachability.
            const resolved = await resolveCandidatePool(startLat, startLng, {
                routingStrategy, rawLocationType, straightMin, straightMax, existingDests, onProgress, winterMode });
            const screened = await screenCandidatePool(startLat, startLng, {
                candidatePool: resolved.candidatePool, dest: resolved.dest, destName: resolved.destName,
                existingDests, onProgress });
            const { candidatePool, waterLocked } = screened;

            // Build route (the spread is read from the DOM here, at the UI layer,
            // and passed down). Smart round-trips may substitute a lower-overlap
            // destination, so read dest/destName back from the build result.
            const spread = getSpreadParams();
            const built = await buildRouteForDestination(startLat, startLng, {
                candidatePool, dest: screened.dest, destName: screened.destName,
                existingDests, maxKm, tripMode, spread, smartRouting, winterMode, onProgress });
            const { dest, destName, outbound: outboundRoute, return: returnRoute, junctions, overlap } = built;

            const session = displayRoute({
                startLat, startLng, destLat: dest.lat, destLng: dest.lng,
                outbound: outboundRoute, ret: returnRoute,
                locationInput, destName, tripMode, straightMax, straightMin,
            });
            session.junctions = junctions;
            saveToHistory(session);

            if (waterLocked) {
                showWarning('This area is mostly water — try a different start or larger radius.');
            } else if (overlap !== null && overlap >= OVERLAP_BAD_THRESHOLD) {
                showWarning('This area has limited routing options — the loop overlaps significantly.');
            }
        } catch (error) {
            showError(error.message || 'An error occurred. Please try again.');
        }
    });
}

// ─── Surprise me ─────────────────────────────────────────────────────────────

function surpriseMe() {
    // Random POI type (skip 'any' and 'roads', pick from actual POIs + any_poi)
    const choices = ['any_poi', ...POI_TYPES.map(p => p.key)];
    const pick = choices[Math.floor(Math.random() * choices.length)];
    document.getElementById('locationTypeSelect').value = pick;

    // Random distance: 1-8km range with random min/max
    const min = +(Math.random() * 3).toFixed(1);          // 0–3 km
    const max = +(min + 1 + Math.random() * 5).toFixed(1); // min+1 to min+6 km
    document.getElementById('minDistance').value = min;
    document.getElementById('maxDistance').value = max;

    // Random spread
    document.getElementById('spreadSlider').value = Math.round(Math.random() * 100);

    saveSettings();
    generateDestination();
}

// ─── Pick destination mode ───────────────────────────────────────────────────

// Shared 'clear → build → display → stash junctions' body for the two flows that
// route to a known destination: pick-on-map and shared-link restore. Both clear
// the map, build a route for the chosen trip mode (smart-routing read from the
// DOM, never for one-way), render it, and stash the junction pool on the new
// session. Callers differ only in where start/label/destName/tripMode come from
// and which progress message precedes the build:
//   loadingMessage   emitted via onProgress before the build (unconditional)
//   buildingMessage  forwarded to buildRouteForMode (shown for non-smart builds)
async function buildAndDisplay(startLat, startLng, destLat, destLng, {
    tripMode, locationInput, destName, onProgress,
    loadingMessage = null, buildingMessage = null,
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
    });
    session.junctions = r.junctions;
    saveToHistory(session);
}

// Map-click handler installed while "pick on map" mode is active: resolve the
// start, build a route to the clicked point, and render it. Hoisted to module
// scope (was an inline closure in togglePickMode) so exitPickMode can detach it
// by reference with map.off('click', handlePickClick).
async function handlePickClick(e) {
    exitPickMode();
    const destLat = e.latlng.lat;
    const destLng = e.latlng.lng;
    currentSession = null;
    resetMarkVisitedBtn();

    await withLoading(async (onProgress) => {
        try {
            const { startLat, startLng, locationInput } = await resolveStart();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            await buildAndDisplay(startLat, startLng, destLat, destLng, {
                tripMode, locationInput, destName: null, onProgress,
                buildingMessage: 'Building route…',
            });
        } catch (error) {
            showError(error.message || 'An error occurred. Please try again.');
        }
    });
}

function togglePickMode() {
    const btn = document.getElementById('pickDestBtn');
    if (pickMode) {
        exitPickMode();
        return;
    }

    // Validate that we have a start location first
    const locationInput = document.getElementById('location').value.trim();
    if (!locationInput) {
        showError('Please enter a starting location first.');
        return;
    }

    pickMode = true;
    btn.classList.add('active');
    btn.textContent = 'Cancel';
    map.getContainer().style.cursor = 'crosshair';
    showSuccess('Click anywhere on the map to set your destination');

    map.on('click', handlePickClick);
}

function exitPickMode() {
    pickMode = false;
    const btn = document.getElementById('pickDestBtn');
    btn.classList.remove('active');
    btn.textContent = 'Pick on map';
    map.getContainer().style.cursor = '';
    map.off('click', handlePickClick);
}

// ─── Mark as Visited ─────────────────────────────────────────────────────────

function markAsVisited() {
    if (!currentSession) return;
    const btn = document.getElementById('markVisitedBtn');

    // Undo: remove visit if already marked
    if (currentSession.visitId) {
        const undoneId = currentSession.visitId;
        const visits = getVisits().filter(v => v.id !== undoneId);
        syncedDelete(VISITS_KEY, visits, 'visits', String(undoneId));
        currentSession.visitId = null;
        btn.classList.remove('marked');
        btn.textContent = 'Mark as visited';
        updateVisitedCounter();
        renderVisitedLayer();
        return;
    }

    const visit = snapshotSession(currentSession, {
        poiCategory: currentSession.poiCategory || null,
    });

    const visits = getVisits();
    visits.push(visit);
    syncedPut(VISITS_KEY, visits, 'visits', visit.id, visit);
    maybeRequestConsent();
    currentSession.visitId = visit.id;

    btn.classList.add('marked');
    btn.textContent = 'Visited! (undo)';

    updateVisitedCounter();
    renderVisitedLayer();
}

// ─── Visited layer ────────────────────────────────────────────────────────────
// renderVisitedLayer (the visited-routes overlay) lives in map-view.js; the
// visibility toggle below is app.js UI and owns visitedLayerVisible.

function toggleVisitedLayer() {
    const btn = document.getElementById('toggleVisitedBtn');
    if (visitedLayerVisible) {
        map.removeLayer(visitedLayerGroup);
        visitedLayerVisible = false;
        btn.textContent = 'Show visited routes';
    } else {
        visitedLayerGroup.addTo(map);
        visitedLayerVisible = true;
        btn.textContent = 'Hide visited routes';
    }
}

// ─── Visited counter ──────────────────────────────────────────────────────────

function updateVisitedCounter() {
    const count = getVisits().length;
    document.getElementById('visitedCount').textContent = `${count} visited`;

    const exploredEl = document.getElementById('exploredCount');
    if (count > 0) {
        const places = count === 1 ? 'place' : 'places';
        exploredEl.textContent = `${count} ${places} explored`;
        exploredEl.style.display = 'block';
    } else {
        exploredEl.style.display = 'none';
    }
}

// ─── List-item factory (history + favorites) ─────────────────────────────────

// buildListItem — the shared history/favorites row skeleton — lives in list-item.js.

// ─── Favorites ───────────────────────────────────────────────────────────────
// FAVORITES_KEY + getFavorites live in storage.js. The favorites CRUD
// (sameFavoriteDest/toggleFavorite/updateFavoriteBtn/deleteFavorite/
// renderFavoritesSection) lives in favorites.js; called from displayRoute (the
// star button) and the Init section as globals.

// ─── Export / Import ──────────────────────────────────────────────────────────

// exportVisits/importVisits (the visits JSON backup file I/O) live in visits-io.js.

// ─── URL sharing ─────────────────────────────────────────────────────────────

function encodeRouteHash() {
    if (!currentSession) return;
    const { startLat, startLng, destLat, destLng, tripMode, destName } = currentSession;
    const params = new URLSearchParams({
        s: `${startLat.toFixed(6)},${startLng.toFixed(6)}`,
        d: `${destLat.toFixed(6)},${destLng.toFixed(6)}`,
        m: tripMode
    });
    if (destName) params.set('n', destName);
    return '#' + params.toString();
}

function copyRouteLink() {
    const hash = encodeRouteHash();
    if (!hash) return;
    const url = location.origin + location.pathname + hash;
    navigator.clipboard.writeText(url).then(
        () => showSuccess('Link copied to clipboard.'),
        () => showError('Failed to copy link.')
    );
}

async function restoreFromHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;

    // Only hash PARSING is guarded: a malformed shared link should silently
    // no-op. Routing/display failures below are NOT swallowed — they surface
    // via showError so a broken shared link is visible to the user.
    let parsed;
    try {
        const params = new URLSearchParams(hash);
        const s = params.get('s');
        const d = params.get('d');
        const m = params.get('m') || 'round';
        const n = params.get('n') || null;
        if (!s || !d) return;

        const [startLat, startLng] = s.split(',').map(Number);
        const [destLat, destLng] = d.split(',').map(Number);
        if ([startLat, startLng, destLat, destLng].some(isNaN)) return;
        parsed = { s, m, n, startLat, startLng, destLat, destLng };
    } catch {
        return;
    }

    const { s, m, n, startLat, startLng, destLat, destLng } = parsed;

    // Set UI state
    document.getElementById('location').value = s;
    if (m === 'one-way') document.getElementById('oneWay').checked = true;
    else document.getElementById('roundTrip').checked = true;

    try {
        await withLoading(async (onProgress) => {
            await buildAndDisplay(startLat, startLng, destLat, destLng, {
                tripMode: m, locationInput: s, destName: n, onProgress,
                loadingMessage: 'Loading shared route…',
            });
        });
        // Clear hash after a successful restore so it doesn't re-trigger.
        history.replaceState(null, '', location.pathname);
    } catch (error) {
        showError(error.message || 'Could not load the shared route.');
    }
}

// ─── Route file export ───────────────────────────────────────────────────────
// GPX + Garmin FIT export (exportGPX, openFITModal, closeFITModal,
// confirmFITExport) plus mergeRouteCoords + triggerDownload live in export.js
// (loaded before app.js); called from index.html onclick handlers as globals.
// The Escape-to-close wiring for the FIT + preferences modals stays here with
// the other top-level listeners.

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('fitModal').classList.contains('active')) {
        closeFITModal();
    }
    if (e.key === 'Escape' && document.getElementById('prefsModal').classList.contains('active')) {
        closePreferencesModal();
    }
});

// ─── Preferences modal ───────────────────────────────────────────────────────

function openPreferencesModal() {
    renderRouteColorSwatches();
    document.getElementById('prefsModal').classList.add('active');
}

function closePreferencesModal() {
    document.getElementById('prefsModal').classList.remove('active');
}

function renderRouteColorSwatches() {
    const grid = document.getElementById('routeColorSwatches');
    if (!grid) return;
    const active = getRouteColor();
    grid.replaceChildren();
    for (const c of ROUTE_COLORS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'swatch' + (c.hex === active ? ' active' : '');
        btn.style.background = c.hex;
        btn.title = c.name;
        btn.setAttribute('aria-label', `Route color: ${c.name}`);
        btn.onclick = () => {
            setRouteColor(c.hex);
            applyRouteColor();
            renderRouteColorSwatches();
        };
        grid.appendChild(btn);
    }
}

// applyRouteColor (recolor live map layers without re-running OSRM) lives in
// map-view.js; called from renderRouteColorSwatches above as a global.

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.getElementById('location').addEventListener('keypress', e => {
    if (e.key === 'Enter') generateDestination();
});
document.getElementById('minDistance').addEventListener('keypress', e => {
    if (e.key === 'Enter') generateDestination();
});
document.getElementById('maxDistance').addEventListener('keypress', e => {
    if (e.key === 'Enter') generateDestination();
});

// Global Ctrl+Enter shortcut
document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generateDestination();
    }
});

// ─── Spread slider: auto-regenerate on change ───────────────────────────────

let spreadDebounce = null;

// Re-route the current session's start/dest with the new spread value.
// Only re-fetches routes, does NOT pick a new destination.
async function rerouteWithCurrentSpread() {
    if (!currentSession) return;
    const { startLat, startLng, destLat, destLng } = currentSession;
    resetMarkVisitedBtn();

    try {
        await withLoading(async (onProgress) => {
            onProgress('Adjusting route…');
            // Keep markers and circles, only clear route lines
            clearRouteLines();

            const { tripMode } = currentSession;
            let junctions = currentSession.junctions || null;
            const smartRouting = tripMode !== 'one-way' && document.getElementById('smartRouting').checked;
            const r = await buildRouteForMode(startLat, startLng, destLat, destLng, {
                tripMode,
                smartRouting,
                winterMode: smartRouting && document.getElementById('winterMode').checked,
                maxKm: parseFloat(document.getElementById('maxDistance').value),
                onProgress,
                cachedJunctions: junctions,
                buildingMessage: null,
                spread: getSpreadParams(),
            });
            const outbound = r.outbound;
            const ret = r.return;
            if (tripMode !== 'one-way') junctions = r.junctions;

            // Redraw routes, refit, badges, directions link, elevation — the same
            // render tail displayRoute uses. No straight-line fallback: keep the
            // previous view in place if a spread change yields no route.
            const { totalWalkKm } = renderRouteTail(
                startLat, startLng, destLat, destLng, outbound, ret, tripMode, getRouteColor(),
                { fallbackStraight: false });

            currentSession = {
                ...currentSession,
                distance: totalWalkKm,
                ...routeSessionFields(outbound, ret),
                junctions,
            };
        });
    } catch (error) {
        showError(error.message || 'Failed to adjust route.');
    }
}

document.getElementById('spreadSlider').addEventListener('input', () => {
    // Only auto-reroute if there's an active route to adjust
    if (!currentSession) return;
    clearTimeout(spreadDebounce);
    spreadDebounce = setTimeout(rerouteWithCurrentSpread, 400);
});

function adjustSpread(delta) {
    const slider = document.getElementById('spreadSlider');
    const newVal = Math.max(0, Math.min(100, parseInt(slider.value, 10) + delta));
    slider.value = newVal;
    if (!currentSession) return;
    clearTimeout(spreadDebounce);
    spreadDebounce = setTimeout(rerouteWithCurrentSpread, 200);
}

// ─── Number input stepper ─────────────────────────────────────────────────────

function stepNumInput(id, delta) {
    const input = document.getElementById(id);
    const min = parseFloat(input.min);
    const max = parseFloat(input.max);
    let val = (parseFloat(input.value) || 0) + delta;
    if (!isNaN(min)) val = Math.max(min, val);
    if (!isNaN(max)) val = Math.min(max, val);
    input.value = val;
}

// ─── Overflow menu ────────────────────────────────────────────────────────────

function toggleOverflowMenu() {
    document.getElementById('overflowMenu').classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('overflowMenu');
    const btn = document.getElementById('overflowBtn');
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
        menu.classList.remove('open');
    }
});

// ─── History ─────────────────────────────────────────────────────────────────
// HISTORY_KEY + getHistory live in storage.js. The history CRUD
// (saveToHistory/deleteHistoryEntry/restoreResult/renderHistorySection/
// toggleHistoryExpanded + HISTORY_MAX/HISTORY_VISIBLE) lives in history.js.

// ─── Init ─────────────────────────────────────────────────────────────────────

// Populate location type select
(function () {
    const sel = document.getElementById('locationTypeSelect');
    sel.add(new Option('location (anywhere)', 'any'));
    sel.add(new Option('road', 'roads'));
    sel.add(new Option('any POI', 'any_poi'));
    for (const cat of POI_CATEGORIES) {
        const group = document.createElement('optgroup');
        group.label = cat.group;
        for (const poi of cat.pois) {
            group.appendChild(new Option(poi.label, poi.key));
        }
        sel.appendChild(group);
    }
})();

// Update distance label when trip mode changes
document.querySelectorAll('input[name="tripMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        const isOneWay = document.getElementById('oneWay').checked;
        document.getElementById('distanceLabel').textContent =
            isOneWay ? 'One-way distance (km)' : 'Round-trip distance (km)';
    });
});

// Re-render every localStorage-backed view. Fired on explorer-sync-state-change
// so a cloud sync that lands AFTER the initial paint — the own-device merge or
// adopting a backup link, both of which rewrite localStorage once init's GET
// resolves — becomes visible immediately instead of waiting for a manual reload.
// (init's synchronous render calls below still paint pre-sync local data first.)
function refreshDataViews() {
    renderVisitedLayer();
    updateVisitedCounter();
    renderFavoritesSection();
    renderHistorySection();
    renderSavedLocations();
}
window.addEventListener('explorer-sync-state-change', refreshDataViews);

restoreSettings();
initSettingsListeners();
renderSavedLocations();
updateSaveLocationBtn();
ExplorerSync.init().finally(updateSyncMenu);
updateSyncMenu();
renderVisitedLayer();
updateVisitedCounter();
renderFavoritesSection();
renderHistorySection();
restoreFromHash();

// Update star button when location input changes
document.getElementById('location').addEventListener('input', updateSaveLocationBtn);
