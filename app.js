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

// Flat lookup for POI definitions
const POI_TYPES = POI_CATEGORIES.flatMap(c => c.pois);

// ─── Map init ────────────────────────────────────────────────────────────────

const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors'
});

const satelliteLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    maxZoom: 19
});

const map = L.map('map').setView([64.5, 26.0], 5);
osmLayer.addTo(map);

L.control.layers({ 'OpenStreetMap': osmLayer, 'Satellite': satelliteLayer }).addTo(map);

// Visited layer group (toggleable)
const visitedLayerGroup = L.layerGroup().addTo(map);
let visitedLayerVisible = true;

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

// ─── Route color palette (colorblind-safe, Wong/Tol-derived) ──────────────────

const ROUTE_COLORS = [
    { name: 'Coral',   hex: '#E66100' },
    { name: 'Sky',     hex: '#56B4E9' },
    { name: 'Teal',    hex: '#009E73' },
    { name: 'Magenta', hex: '#CC79A7' },
    { name: 'Gold',    hex: '#F0E442' }
];
const DEFAULT_ROUTE_COLOR = ROUTE_COLORS[0].hex;
const ROUTE_COLOR_KEY = 'walk_route_color';

function getRouteColor() {
    const stored = localStorage.getItem(ROUTE_COLOR_KEY);
    if (stored && ROUTE_COLORS.some(c => c.hex === stored)) return stored;
    return DEFAULT_ROUTE_COLOR;
}

function setRouteColor(hex) {
    localStorage.setItem(ROUTE_COLOR_KEY, hex);
}

// ─── Mutable map state ────────────────────────────────────────────────────────

let markers = [];
let destMarker = null;  // ref to the destination pin so we can recolor on the fly
let circle = null;
let innerCircle = null;
let routeLines = [];  // all polylines for the loop

// Current in-progress destination (reset on each generation)
let currentSession = null;

// Map-click mode for "pick destination" feature
let pickMode = false;

// ─── Sync helpers ────────────────────────────────────────────────────────────

// ExplorerSync (sync.js) is loaded before app.js in index.html's fixed defer
// order, so it is always defined by the time any of these run — no typeof guard.
function maybeRequestConsent() {
    if (ExplorerSync.getState().state === 'anonymous') {
        ExplorerSync.requestConsent();
    }
}

// Persist a synced collection and mirror the change to the cloud outbox in one
// step. writeStoredArray (storage.js) owns the localStorage write; these keep
// the persist-and-mirror invariant in one place so a new call site can't save
// locally while forgetting to replicate (the bug class fixed in #2065). Every
// mutation of the four synced collections (visits, savedLocations, favorites,
// history) goes through one of these — except importVisits' batch put, which
// writes once and mirrors each row in a loop.
function syncedPut(key, arr, section, id, data) {
    writeStoredArray(key, arr);
    ExplorerSync.mutate(section, 'put', id, data);
}

function syncedDelete(key, arr, section, id) {
    writeStoredArray(key, arr);
    ExplorerSync.mutate(section, 'delete', id);
}

// ─── localStorage ─────────────────────────────────────────────────────────────
// readStoredArray + the array accessors (getVisits, getSavedLocations,
// getFavorites, getHistory) and their storage keys (VISITS_KEY,
// SAVED_LOCATIONS_KEY, FAVORITES_KEY, HISTORY_KEY) live in storage.js (loaded
// before app.js); used here as globals.

const SETTINGS_KEY = 'walk_settings';

// ─── Settings persistence ────────────────────────────────────────────────────

// Declarative spec for the persisted preferences, so save/restore/listen all
// iterate one list instead of enumerating the same eight fields three times.
// prop is the element property to read/write; skipEmpty fields (free-text-ish
// inputs) are only restored when non-empty so a blank saved value never clobbers
// a default. The tripMode radio pair and the distance-label sync stay explicit
// in restoreSettings — they don't fit the one-element/one-prop shape.
const SETTINGS_FIELDS = [
    { key: 'location',     id: 'location',           prop: 'value',   skipEmpty: true },
    { key: 'minDistance',  id: 'minDistance',        prop: 'value' },
    { key: 'maxDistance',  id: 'maxDistance',        prop: 'value' },
    { key: 'poiType',      id: 'locationTypeSelect', prop: 'value',   skipEmpty: true },
    { key: 'spread',       id: 'spreadSlider',       prop: 'value' },
    { key: 'winterMode',   id: 'winterMode',         prop: 'checked' },
    { key: 'smartRouting', id: 'smartRouting',       prop: 'checked' },
];

function saveSettings() {
    const settings = {
        tripMode: document.querySelector('input[name="tripMode"]:checked').value,
    };
    for (const f of SETTINGS_FIELDS) {
        settings[f.key] = document.getElementById(f.id)[f.prop];
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function restoreSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (!settings) return;
        for (const f of SETTINGS_FIELDS) {
            const val = settings[f.key];
            if (val == null) continue;
            if (f.skipEmpty && !val) continue;
            document.getElementById(f.id)[f.prop] = val;
        }
        // Trip mode is a radio pair (two elements, one stored value) — special-cased.
        if (settings.tripMode === 'round' || settings.tripMode === 'one-way') {
            document.getElementById(settings.tripMode === 'one-way' ? 'oneWay' : 'roundTrip').checked = true;
        }
        // Sync distance label with restored trip mode
        const isOneWay = document.getElementById('oneWay').checked;
        document.getElementById('distanceLabel').textContent =
            isOneWay ? 'One-way distance (km)' : 'Round-trip distance (km)';
    } catch {}
}

// Auto-save on input changes
function initSettingsListeners() {
    for (const f of SETTINGS_FIELDS) {
        document.getElementById(f.id).addEventListener('change', saveSettings);
    }
    document.querySelectorAll('input[name="tripMode"]').forEach(r => r.addEventListener('change', saveSettings));
}

// ─── Saved locations ─────────────────────────────────────────────────────────
// SAVED_LOCATIONS_KEY + getSavedLocations live in storage.js; used here as globals.

function toggleSaveLocation() {
    const input = document.getElementById('location').value.trim();
    if (!input) { showError('Enter a location first.'); return; }
    const saved = getSavedLocations();
    const existing = saved.findIndex(s => s.value === input);
    if (existing >= 0) {
        const removed = saved[existing];
        saved.splice(existing, 1);
        syncedDelete(SAVED_LOCATIONS_KEY, saved, 'savedLocations', removed.id || String(removed.value));
        showSuccess('Location removed from saved.');
    } else {
        const label = prompt('Name for this location:', input);
        if (label === null) return;
        const newLoc = { id: crypto.randomUUID(), label: label || input, value: input };
        saved.push(newLoc);
        syncedPut(SAVED_LOCATIONS_KEY, saved, 'savedLocations', newLoc.id, newLoc);
        maybeRequestConsent();
        showSuccess('Location saved.');
    }
    renderSavedLocations();
    updateSaveLocationBtn();
}

function selectSavedLocation(value) {
    document.getElementById('location').value = value;
    updateSaveLocationBtn();
    saveSettings();
}

function deleteSavedLocation(index, event) {
    event.stopPropagation();
    const saved = getSavedLocations();
    const removed = saved[index];
    saved.splice(index, 1);
    syncedDelete(SAVED_LOCATIONS_KEY, saved, 'savedLocations', removed.id || String(removed.value));
    renderSavedLocations();
    updateSaveLocationBtn();
}

function renderSavedLocations() {
    const container = document.getElementById('savedLocations');
    const saved = getSavedLocations();
    container.replaceChildren();
    for (let i = 0; i < saved.length; i++) {
        const item = document.createElement('div');
        item.className = 'saved-location-item';
        item.addEventListener('click', () => selectSavedLocation(saved[i].value));

        const label = document.createElement('span');
        label.className = 'saved-location-label';
        label.textContent = saved[i].label;
        item.appendChild(label);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'history-delete';
        del.title = 'Remove';
        del.textContent = '\u00d7';
        del.addEventListener('click', (e) => deleteSavedLocation(i, e));
        item.appendChild(del);

        container.appendChild(item);
    }
}

function updateSaveLocationBtn() {
    const btn = document.getElementById('saveLocationBtn');
    const input = document.getElementById('location').value.trim();
    const saved = getSavedLocations();
    const isSaved = saved.some(s => s.value === input);
    btn.style.color = isSaved ? '#fbbf24' : '';
    btn.querySelector('svg').setAttribute('fill', isSaved ? '#fbbf24' : 'none');
}

// ─── Map helpers ─────────────────────────────────────────────────────────────

function createPinIcon(color) {
    return L.divIcon({
        className: '',
        html: `<svg width="24" height="36" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 0C5.373 0 0 5.373 0 12c0 9 12 24 12 24s12-15 12-24C24 5.373 18.627 0 12 0z" fill="${color}"/>
            <circle cx="12" cy="12" r="5" fill="white" fill-opacity="0.9"/>
        </svg>`,
        iconSize: [24, 36],
        iconAnchor: [12, 36],
        popupAnchor: [0, -38]
    });
}

// "You are here" dot — universal current-location convention. Shape carries
// the meaning, so we can keep the color fixed regardless of route color.
function createHereDotIcon() {
    return L.divIcon({
        className: 'user-here-dot',
        html: `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="10" fill="#3b82f6" fill-opacity="0.18"/>
            <circle cx="11" cy="11" r="6" fill="#3b82f6" stroke="white" stroke-width="2.5"/>
        </svg>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12]
    });
}

// Strava-style glow polyline: thick low-opacity halo + crisp top stroke.
// Pushes both layers into routeLines so clearMap() removes them together.
function drawRouteGlow(coords, color, { dashed = false } = {}) {
    const halo = L.polyline(coords, {
        color, weight: 10, opacity: 0.22,
        lineCap: 'round', lineJoin: 'round'
    }).addTo(map);
    routeLines.push(halo);
    const top = L.polyline(coords, {
        color, weight: 3.5, opacity: 0.95,
        lineCap: 'round', lineJoin: 'round',
        dashArray: dashed ? '10, 10' : null
    }).addTo(map);
    routeLines.push(top);
    return top;
}

// Draw the outbound + return legs in the shared glow style and return the
// combined coord list (empty if neither leg exists). Callers own fitBounds and
// any no-route fallback, which differ between first render and spread reroute.
function drawRoutePair(outbound, ret, color) {
    const allCoords = [];
    if (outbound) {
        drawRouteGlow(outbound.coords, color);
        allCoords.push(...outbound.coords);
    }
    if (ret) {
        drawRouteGlow(ret.coords, color);
        allCoords.push(...ret.coords);
    }
    return allCoords;
}

function clearMap() {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    destMarker = null;
    if (circle)      { map.removeLayer(circle);      circle = null; }
    if (innerCircle) { map.removeLayer(innerCircle); innerCircle = null; }
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
}

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
    const response = await fetch(
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

function getAllExistingDestinations() {
    return getVisits().map(v => [v.destLat, v.destLng]);
}

// Single-pick novelty selection: delegate to rankByNovelty (novelty.js), which
// owns the min-distance scoring + most-novel-half selection. rankByNovelty
// shuffles the top half internally, so [0] is a uniformly random pick from the
// most-novel half (or from all candidates when there's no history). Returns
// undefined on an empty pool — same as the previous implementation.
function pickMostNovelDestination(candidates, existingDests) {
    return rankByNovelty(candidates, existingDests)[0];
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

function showConsentToast() {
    return new Promise((resolve) => {
        if (document.getElementById('cloudConsentToast')) {
            resolve('declined');
            return;
        }

        const toast = document.createElement('div');
        toast.className = 'toast-consent';
        toast.id = 'cloudConsentToast';

        const msg = document.createElement('div');
        msg.className = 'toast-consent-message';
        msg.textContent =
            'Wander can save your visits, saved locations, and favorites ' +
            'to a database on mase.fi so they survive clearing your browser.';
        toast.appendChild(msg);

        const buttons = document.createElement('div');
        buttons.className = 'toast-consent-buttons';

        const declineBtn = document.createElement('button');
        declineBtn.type = 'button';
        declineBtn.textContent = 'Decline';

        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'primary';
        acceptBtn.textContent = 'Accept';

        let settled = false;
        const settle = (choice) => {
            if (settled) return;
            settled = true;
            clearTimeout(autoTimer);
            toast.remove();
            resolve(choice);
        };

        declineBtn.addEventListener('click', () => {
            ExplorerSync.decline();
            settle('declined');
        });
        acceptBtn.addEventListener('click', () => {
            acceptBtn.disabled = true;
            declineBtn.disabled = true;
            acceptBtn.textContent = 'Saving…';
            ExplorerSync.accept().then(() => {
                showSuccess('Cloud backup enabled.');
                settle('accepted');
            }).catch((err) => {
                console.warn('Cloud backup enable failed', err);
                showError('Could not enable cloud backup. Try again later.');
                settle('declined');
            });
        });

        buttons.appendChild(declineBtn);
        buttons.appendChild(acceptBtn);
        toast.appendChild(buttons);
        document.body.appendChild(toast);

        const autoTimer = setTimeout(() => {
            if (!settled) {
                ExplorerSync.decline();
                settle('declined');
            }
        }, 30000);
    });
}

window.ExplorerSyncUI = { showConsentToast };

function enableCloudBackup() {
    closeOverflowMenuIfOpen();
    ExplorerSync.requestConsent();
}

function copyBackupLink() {
    closeOverflowMenuIfOpen();
    const link = ExplorerSync.getState().link;
    if (!link) { showError('No backup link available.'); return; }
    navigator.clipboard.writeText(link).then(
        () => showSuccess('Backup link copied — open it on any device to restore your data.'),
        () => showError('Failed to copy link.')
    );
}

function confirmDeleteCloudData() {
    closeOverflowMenuIfOpen();
    if (!confirm('Delete your cloud data permanently? Your local data will be kept.')) return;
    ExplorerSync.deleteAccount().then(() => {
        showSuccess('Cloud data deleted.');
    }).catch((err) => {
        console.warn('Delete cloud data failed', err);
        showError('Could not delete cloud data. Try again later.');
    });
}

function closeOverflowMenuIfOpen() {
    const menu = document.getElementById('overflowMenu');
    if (menu) menu.classList.remove('open');
}

function updateSyncMenu() {
    const s = ExplorerSync.getState();
    const status = document.getElementById('syncStatus');
    const usernameEl = document.getElementById('syncUsername');
    const enableBtn = document.getElementById('enableCloudBackupBtn');
    const copyLinkBtn = document.getElementById('copyBackupLinkBtn');
    const deleteBtn = document.getElementById('deleteCloudDataBtn');
    if (s.state === 'accepted') {
        status.style.display = '';
        usernameEl.textContent = s.username || '';
        enableBtn.style.display = 'none';
        copyLinkBtn.style.display = '';
        deleteBtn.style.display = '';
    } else {
        status.style.display = 'none';
        usernameEl.textContent = '';
        enableBtn.style.display = '';
        copyLinkBtn.style.display = 'none';
        deleteBtn.style.display = 'none';
    }
}

window.addEventListener('explorer-sync-state-change', updateSyncMenu);

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

    // Markers
    const startMarker = L.marker([startLat, startLng], { icon: createHereDotIcon() })
        .addTo(map).bindPopup(`<b>Start</b><br>${escapeHtml(locationInput)}`);
    markers.push(startMarker);

    destMarker = L.marker([destLat, destLng], { icon: createPinIcon(routeColor) })
        .addTo(map).bindPopup('<b>Destination</b><br>Turnaround point');
    markers.push(destMarker);

    // Radius circles
    if (straightMax > 0) {
        circle = L.circle([startLat, startLng], {
            color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08,
            radius: straightMax * 1000
        }).addTo(map);
    }
    if (straightMin > 0) {
        innerCircle = L.circle([startLat, startLng], {
            color: '#3b82f6', fillColor: 'transparent', fillOpacity: 0,
            weight: 1.5, opacity: 0.4, dashArray: '6, 4',
            radius: straightMin * 1000
        }).addTo(map);
    }

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

// A pool of fully random points in the annulus — the fallback when Overpass
// fails or returns nothing, and the pool for 'any' (random-point-anywhere).
function randomCandidatePool(startLat, startLng, straightMin, straightMax) {
    return Array.from({ length: RANDOM_POOL_SIZE }, () =>
        generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
}

// The random-annulus resolution shape: pool + initial novelty pick, no name.
// Used both as the Overpass fallback and for the 'any' strategy.
function randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests) {
    const candidatePool = randomCandidatePool(startLat, startLng, straightMin, straightMax);
    return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
}

// Resolve the destination candidate pool for the chosen locationType. POI/road
// strategies hit Overpass and fall back to a random annulus pool; 'any' goes
// straight to a random pool. Two distinct fallbacks with accurate progress
// messages: a genuine fetch failure (only the fetch call is in the try) vs. a
// successful-but-empty response. Errors from capPool/pickMostNovelDestination
// are NOT caught here — they surface to generateDestination's handler instead of
// being silently masked as "Overpass unavailable". Returns the full pool plus an
// initial novelty pick: { candidatePool, dest, destName }.
async function resolveCandidatePool(locationType, locationTypeVal, startLat, startLng, straightMin, straightMax, onProgress, existingDests) {
    if (locationType === 'roads') {
        onProgress('Searching for roads in the area…');
        let roads;
        try {
            const winterMode = document.getElementById('winterMode').checked;
            roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress, winterMode);
        } catch {
            onProgress('Overpass unavailable, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        if (roads.length === 0) {
            onProgress('No roads found nearby, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        const candidatePool = capPool(roads);
        return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
    }
    if (locationType === 'any_poi' || locationType === 'poi') {
        const filters = locationType === 'any_poi'
            ? POI_TYPES.map(p => p.filter)
            : [POI_TYPES.find(p => p.key === locationTypeVal)?.filter].filter(Boolean);
        const label = locationType === 'any_poi'
            ? 'any POI'
            : POI_TYPES.find(p => p.key === locationTypeVal)?.label || 'places';
        onProgress(`Searching for ${label}…`);
        let pois;
        try {
            pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax, filters.length === 1 ? filters[0] : filters, onProgress);
        } catch {
            onProgress('Overpass unavailable, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        if (pois.length === 0) {
            onProgress('No matching places found nearby, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        const candidatePool = capPool(pois);
        const dest = pickMostNovelDestination(candidatePool, existingDests);
        return { candidatePool, dest, destName: dest.name };
    }
    // locationType === 'any': a fully random point anywhere in the annulus.
    return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
}

// Screen the candidate pool for water-reachability before route building.
// Survivors replace the pool and get a fresh novelty pick; if none survive, the
// best-rejected candidate is used and waterLocked is flagged. On screening
// failure (or no screened result) the unscreened pool/dest/destName pass through
// unchanged. Returns { candidatePool, dest, destName, waterLocked }.
async function screenCandidatePool(startLat, startLng, candidatePool, dest, destName, existingDests, onProgress) {
    try {
        onProgress('Checking reachability…');
        const screened = await screenCandidates(
            { lat: startLat, lng: startLng },
            candidatePool,
            { tableFn: screeningTableFn }
        );
        if (screened.survivors.length > 0) {
            const pool = screened.survivors;
            const pick = pickMostNovelDestination(pool, existingDests);
            return { candidatePool: pool, dest: pick, destName: pick.name || destName, waterLocked: false };
        }
        if (screened.bestRejected) {
            return {
                candidatePool: [screened.bestRejected],
                dest: screened.bestRejected,
                destName: screened.bestRejected.name || destName,
                waterLocked: true,
            };
        }
    } catch (err) {
        console.warn('Screening failed, falling back to unscreened pool:', err);
    }
    return { candidatePool, dest, destName, waterLocked: false };
}

// Smart-routing retry loop: rank the pool by novelty and build a junction loop
// for each candidate (reusing the corridor junction pool across attempts),
// keeping the lowest-overlap result. Stops early once a loop beats the overlap
// threshold. Returns the best { dest, destName, outbound, return, overlap,
// junctions } seen, or null if nothing was built.
async function findBestLoop(startLat, startLng, candidatePool, dest, existingDests, maxKm, winterMode, spread, onProgress) {
    const ranked = candidatePool ? rankByNovelty(candidatePool, existingDests) : [dest];
    const retryBudget = Math.min(MAX_RETRY_ATTEMPTS, ranked.length || 1);

    let cachedJunctions = null;
    let bestSeen = null;

    for (let i = 0; i < retryBudget; i++) {
        const tryDest = ranked[i];
        if (!tryDest) break;

        onProgress(retryBudget > 1
            ? `Building route… (attempt ${i + 1}/${retryBudget})`
            : 'Building route…');
        const result = await buildJunctionLoop(startLat, startLng,
            tryDest.lat, tryDest.lng, maxKm, onProgress, cachedJunctions, winterMode, spread);
        if (cachedJunctions === null) cachedJunctions = result.junctions;

        const candidate = {
            dest: tryDest,
            destName: tryDest.name || null,
            outbound: result.outbound,
            return: result.return,
            overlap: result.overlap,
            junctions: result.junctions,
        };
        if (!bestSeen
            || (candidate.overlap !== null
                && (bestSeen.overlap === null || candidate.overlap < bestSeen.overlap))) {
            bestSeen = candidate;
        }

        if (candidate.overlap !== null && candidate.overlap < OVERLAP_BAD_THRESHOLD) break;
    }
    return bestSeen;
}

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
            const locationTypeVal = document.getElementById('locationTypeSelect').value;
            // Map the dropdown value to a routing strategy. Every case is listed
            // explicitly so 'any' is visible: it resolves to a fully random point
            // anywhere, not to roads or POIs.
            const locationType =
                locationTypeVal === 'roads' ? 'roads'
                : locationTypeVal === 'any_poi' ? 'any_poi'
                : locationTypeVal === 'any' ? 'any'
                : 'poi';

            // Straight-line scaling: round trip ≈ budget / 2.6, one-way ≈ budget / 1.3
            const scale = tripMode === 'one-way' ? 1.3 : 2.6;
            const straightMin = minKm / scale;
            const straightMax = maxKm / scale;

            // Resolve a candidate pool, then screen it for water-reachability.
            const resolved = await resolveCandidatePool(
                locationType, locationTypeVal, startLat, startLng, straightMin, straightMax, onProgress, existingDests);
            const screened = await screenCandidatePool(
                startLat, startLng, resolved.candidatePool, resolved.dest, resolved.destName, existingDests, onProgress);
            let { candidatePool, dest, destName } = screened;
            const waterLocked = screened.waterLocked;

            // Build route. Smart round-trips run the novelty-retry loop; one-way
            // and plain loops dispatch straight through buildRouteForMode. The
            // spread is read from the DOM here (UI layer) and passed down.
            const spread = getSpreadParams();
            let outboundRoute, returnRoute, junctions = null, overlap = null;
            if (tripMode !== 'one-way' && document.getElementById('smartRouting').checked) {
                const winterMode = document.getElementById('winterMode').checked;
                const best = await findBestLoop(
                    startLat, startLng, candidatePool, dest, existingDests, maxKm, winterMode, spread, onProgress);
                if (best) {
                    dest = best.dest;
                    destName = best.destName;
                    outboundRoute = best.outbound;
                    returnRoute = best.return;
                    junctions = best.junctions;
                    overlap = best.overlap;
                }
            } else {
                const r = await buildRouteForMode(startLat, startLng, dest.lat, dest.lng, {
                    tripMode, smartRouting: false, winterMode: false, onProgress,
                    buildingMessage: 'Building route…', spread,
                });
                outboundRoute = r.outbound;
                returnRoute = r.return;
            }

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

function renderVisitedLayer() {
    visitedLayerGroup.clearLayers();
    const color = getRouteColor();
    for (const visit of getVisits()) {
        if (visit.routeCoords?.length > 0) {
            L.polyline(visit.routeCoords, {
                color, weight: 2, opacity: 0.4
            }).addTo(visitedLayerGroup);
        }
        if (visit.returnRouteCoords?.length > 0) {
            L.polyline(visit.returnRouteCoords, {
                color, weight: 2, opacity: 0.4
            }).addTo(visitedLayerGroup);
        }
        // Start: hollow ring (matches "you are here" semantic but compact for overlay)
        L.circleMarker([visit.startLat, visit.startLng], {
            radius: 4, color: '#3b82f6', fillColor: '#fff', fillOpacity: 1, weight: 2
        })
        .bindPopup(`<b>${escapeHtml(visit.startLabel)}</b><br>${new Date(visit.date).toLocaleDateString()}`)
        .addTo(visitedLayerGroup);

        // Destination: filled in route color (matches the active route's pin)
        L.circleMarker([visit.destLat, visit.destLng], {
            radius: 5, color, fillColor: color, fillOpacity: 0.85, weight: 1
        })
        .bindPopup(`${visit.distance.toFixed(1)} km<br>${new Date(visit.date).toLocaleDateString()}`)
        .addTo(visitedLayerGroup);
    }
}

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

// Build the shared .history-item skeleton used by both the history and the
// favorites lists: a name line, a meta line, and a × delete button. Callers
// supply the label/meta text plus the select and delete click handlers.
function buildListItem(label, meta, onSelect, onDelete) {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.addEventListener('click', onSelect);

    const nameEl = document.createElement('div');
    nameEl.className = 'history-item-name';
    nameEl.textContent = label;
    item.appendChild(nameEl);

    const metaEl = document.createElement('div');
    metaEl.className = 'history-item-meta';
    metaEl.textContent = meta;
    item.appendChild(metaEl);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-delete';
    del.title = 'Remove';
    del.textContent = '×';
    del.addEventListener('click', onDelete);
    item.appendChild(del);

    return item;
}

// ─── Favorites ───────────────────────────────────────────────────────────────
// FAVORITES_KEY + getFavorites live in storage.js; used here as globals.

// Favorite-identity predicate: does this favorite point at the same destination
// as `dest` (a session or another favorite)? Matched by dest coords at 6-decimal
// precision. Sole owner of the match rule so the star button and the favorites
// list can never disagree — change the precision (or match by id) here once.
function sameFavoriteDest(fav, dest) {
    return fav.destLat.toFixed(6) === dest.destLat.toFixed(6) &&
           fav.destLng.toFixed(6) === dest.destLng.toFixed(6);
}

function toggleFavorite() {
    if (!currentSession) return;
    const btn = document.getElementById('favoriteBtn');
    const favs = getFavorites();

    const idx = favs.findIndex(f => sameFavoriteDest(f, currentSession));

    if (idx >= 0) {
        const removed = favs[idx];
        favs.splice(idx, 1);
        btn.classList.remove('active');
        syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id));
    } else {
        const newFav = snapshotSession(currentSession);
        favs.unshift(newFav);
        btn.classList.add('active');
        syncedPut(FAVORITES_KEY, favs, 'favorites', newFav.id, newFav);
        maybeRequestConsent();
    }
    renderFavoritesSection();
}

function updateFavoriteBtn() {
    const btn = document.getElementById('favoriteBtn');
    if (!currentSession) { btn.classList.remove('active'); return; }
    const isFav = getFavorites().some(f => sameFavoriteDest(f, currentSession));
    btn.classList.toggle('active', isFav);
}

function deleteFavorite(index, event) {
    event.stopPropagation();
    const favs = getFavorites();
    const removed = favs[index];
    favs.splice(index, 1);
    syncedDelete(FAVORITES_KEY, favs, 'favorites', String(removed.id));
    renderFavoritesSection();
    updateFavoriteBtn();
}

function renderFavoritesSection() {
    const favs = getFavorites();
    const section = document.getElementById('favoritesSection');
    const list = document.getElementById('favoritesList');

    if (favs.length === 0) {
        section.classList.remove('visible');
        return;
    }

    section.classList.add('visible');
    list.replaceChildren();
    favs.forEach((entry, i) => {
        const label = entry.destName ||
            `${entry.destLat.toFixed(4)}, ${entry.destLng.toFixed(4)}`;
        const dist = entry.distance ? `${entry.distance.toFixed(1)} km` : '';
        const item = buildListItem(label, dist,
            () => { restoreResult(getFavorites()[i]); updateFavoriteBtn(); },
            (e) => deleteFavorite(i, e));
        list.appendChild(item);
    });
}

// ─── Export / Import ──────────────────────────────────────────────────────────

function exportVisits() {
    const visits = getVisits();
    if (visits.length === 0) { showError('No visits to export yet.'); return; }
    const date = new Date().toISOString().split('T')[0];
    const blob = new Blob([JSON.stringify(visits, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `walks-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importVisits(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error('Invalid format');
            const existing = getVisits();
            const existingIds = new Set(existing.map(v => v.id));
            const newEntries = imported.filter(v => !existingIds.has(v.id));
            // Give every imported entry a stable id, then mirror each to the
            // cloud outbox exactly as markAsVisited does. Without this, imported
            // visits live only in localStorage and silently never replicate to
            // the cloud backup when sync is active.
            for (const v of newEntries) {
                if (!v.id) v.id = crypto.randomUUID();
            }
            writeStoredArray(VISITS_KEY, [...existing, ...newEntries]);
            for (const v of newEntries) {
                ExplorerSync.mutate('visits', 'put', v.id, v);
            }
            maybeRequestConsent();
            showSuccess(`Added ${newEntries.length} new ${newEntries.length === 1 ? 'visit' : 'visits'}.`);
            updateVisitedCounter();
            renderVisitedLayer();
        } catch {
            showError('Failed to import: invalid JSON file.');
        }
        event.target.value = '';
    };
    reader.readAsText(file);
}

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

// Apply the current routeColor to all live map layers without re-running OSRM.
function applyRouteColor() {
    const color = getRouteColor();
    routeLines.forEach(l => l.setStyle({ color }));
    if (destMarker) destMarker.setIcon(createPinIcon(color));
    renderVisitedLayer();
}

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
            routeLines.forEach(l => map.removeLayer(l));
            routeLines = [];

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
// HISTORY_KEY + getHistory live in storage.js; used here as globals.

const HISTORY_MAX = 20;
const HISTORY_VISIBLE = 3;
let historyExpanded = false;

function saveToHistory(session) {
    const entry = snapshotSession(session);
    const history = getHistory();
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    syncedPut(HISTORY_KEY, history, 'history', entry.id, entry);
    maybeRequestConsent();
    renderHistorySection();
}

function deleteHistoryEntry(index) {
    const history = getHistory();
    const removed = history[index];
    history.splice(index, 1);
    syncedDelete(HISTORY_KEY, history, 'history', String(removed.id));
    renderHistorySection();
}

function restoreResult(entry) {
    clearMap();
    // Prefer the real per-leg distances when the entry has them. Legacy entries
    // (saved before per-leg distances existed, or pulled from the cloud where
    // only the total is stored) fall back to assigning the whole total to the
    // outbound leg — numerically correct for the displayed total, which is all
    // displayRoute renders.
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
    });
}

function renderHistorySection() {
    const history = getHistory();
    const section = document.getElementById('historySection');
    const list = document.getElementById('historyList');
    const moreBtn = document.getElementById('historyMoreBtn');

    if (history.length === 0) {
        section.classList.remove('visible');
        return;
    }

    section.classList.add('visible');
    const shown = historyExpanded ? history : history.slice(0, HISTORY_VISIBLE);
    list.replaceChildren();
    shown.forEach((entry, i) => {
        const label = entry.destName ||
            `${entry.destLat.toFixed(4)}, ${entry.destLng.toFixed(4)}`;
        const date = new Date(entry.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const dist = entry.distance ? `${entry.distance.toFixed(1)} km` : '';
        const meta = [dist, date].filter(Boolean).join(' · ');

        const item = buildListItem(label, meta,
            () => restoreResult(getHistory()[i]),
            (e) => { e.stopPropagation(); deleteHistoryEntry(i); });
        list.appendChild(item);
    });

    const hidden = history.length - HISTORY_VISIBLE;
    if (history.length > HISTORY_VISIBLE) {
        moreBtn.style.display = 'block';
        moreBtn.textContent = historyExpanded ? 'Show less' : `Show ${hidden} more`;
    } else {
        moreBtn.style.display = 'none';
    }
}

function toggleHistoryExpanded() {
    historyExpanded = !historyExpanded;
    renderHistorySection();
}

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
