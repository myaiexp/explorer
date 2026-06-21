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
let pickHandler = null;

// ─── Sync helpers ────────────────────────────────────────────────────────────

function maybeRequestConsent() {
    if (typeof ExplorerSync !== 'undefined' && ExplorerSync.getState().state === 'anonymous') {
        ExplorerSync.requestConsent();
    }
}

// ─── localStorage ─────────────────────────────────────────────────────────────
// readStoredArray + the array accessors (getVisits, getSavedLocations,
// getFavorites, getHistory) and their storage keys (STORAGE_KEY,
// SAVED_LOCATIONS_KEY, FAVORITES_KEY, HISTORY_KEY) live in storage.js (loaded
// before app.js); used here as globals.

const SETTINGS_KEY = 'walk_settings';

// ─── Settings persistence ────────────────────────────────────────────────────

function saveSettings() {
    const settings = {
        location: document.getElementById('location').value,
        tripMode: document.querySelector('input[name="tripMode"]:checked').value,
        minDistance: document.getElementById('minDistance').value,
        maxDistance: document.getElementById('maxDistance').value,
        poiType: document.getElementById('locationTypeSelect').value,
        spread: document.getElementById('spreadSlider').value,
        winterMode: document.getElementById('winterMode').checked,
        smartRouting: document.getElementById('smartRouting').checked,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function restoreSettings() {
    try {
        const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
        if (!settings) return;
        if (settings.location) document.getElementById('location').value = settings.location;
        if (settings.tripMode === 'round' || settings.tripMode === 'one-way') {
            document.getElementById(settings.tripMode === 'one-way' ? 'oneWay' : 'roundTrip').checked = true;
        }
        if (settings.minDistance != null) document.getElementById('minDistance').value = settings.minDistance;
        if (settings.maxDistance != null) document.getElementById('maxDistance').value = settings.maxDistance;
        if (settings.poiType) document.getElementById('locationTypeSelect').value = settings.poiType;
        if (settings.spread != null) document.getElementById('spreadSlider').value = settings.spread;
        if (settings.winterMode != null) document.getElementById('winterMode').checked = settings.winterMode;
        if (settings.smartRouting != null) document.getElementById('smartRouting').checked = settings.smartRouting;
        // Sync distance label with restored trip mode
        const isOneWay = document.getElementById('oneWay').checked;
        document.getElementById('distanceLabel').textContent =
            isOneWay ? 'One-way distance (km)' : 'Round-trip distance (km)';
    } catch {}
}

// Auto-save on input changes
function initSettingsListeners() {
    document.getElementById('location').addEventListener('change', saveSettings);
    document.querySelectorAll('input[name="tripMode"]').forEach(r => r.addEventListener('change', saveSettings));
    document.getElementById('minDistance').addEventListener('change', saveSettings);
    document.getElementById('maxDistance').addEventListener('change', saveSettings);
    document.getElementById('locationTypeSelect').addEventListener('change', saveSettings);
    document.getElementById('spreadSlider').addEventListener('change', saveSettings);
    document.getElementById('winterMode').addEventListener('change', saveSettings);
    document.getElementById('smartRouting').addEventListener('change', saveSettings);
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
        localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
        ExplorerSync.mutate('savedLocations', 'delete', removed.id || String(removed.value));
        showSuccess('Location removed from saved.');
    } else {
        const label = prompt('Name for this location:', input);
        if (label === null) return;
        const newLoc = { id: crypto.randomUUID(), label: label || input, value: input };
        saved.push(newLoc);
        localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
        ExplorerSync.mutate('savedLocations', 'put', newLoc.id, newLoc);
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
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
    ExplorerSync.mutate('savedLocations', 'delete', removed.id || String(removed.value));
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
// Callers keep their own error handling (showError) inside fn.
async function withLoading(fn) {
    const loadingEl = document.getElementById('loading');
    const genBtn = document.getElementById('generateBtn');
    loadingEl.classList.add('active');
    genBtn.disabled = true;
    try {
        return await fn();
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
    if (typeof ExplorerSync === 'undefined') return;
    closeOverflowMenuIfOpen();
    ExplorerSync.requestConsent();
}

function copyBackupLink() {
    closeOverflowMenuIfOpen();
    if (typeof ExplorerSync === 'undefined') return;
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
    if (typeof ExplorerSync === 'undefined') return;
    const s = ExplorerSync.getState();
    const status = document.getElementById('syncStatus');
    const usernameEl = document.getElementById('syncUsername');
    const enableBtn = document.getElementById('enableCloudBackupBtn');
    const copyLinkBtn = document.getElementById('copyBackupLinkBtn');
    const deleteBtn = document.getElementById('deleteCloudDataBtn');
    if (!status || !enableBtn || !deleteBtn) return;
    if (s.state === 'accepted') {
        status.style.display = '';
        if (usernameEl) usernameEl.textContent = s.username || '';
        enableBtn.style.display = 'none';
        if (copyLinkBtn) copyLinkBtn.style.display = '';
        deleteBtn.style.display = '';
    } else {
        status.style.display = 'none';
        if (usernameEl) usernameEl.textContent = '';
        enableBtn.style.display = '';
        if (copyLinkBtn) copyLinkBtn.style.display = 'none';
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

async function fetchElevations(coords) {
    // Sample up to 100 points evenly along the route
    const maxPts = 100;
    const step = Math.max(1, Math.floor(coords.length / maxPts));
    const sampled = [];
    for (let i = 0; i < coords.length; i += step) sampled.push(coords[i]);
    if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
        sampled.push(coords[coords.length - 1]);
    }

    const lats = sampled.map(c => c[0].toFixed(4)).join(',');
    const lngs = sampled.map(c => c[1].toFixed(4)).join(',');
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.elevation || null;
}

function renderElevationChart(elevations) {
    const container = document.getElementById('elevationContainer');
    container.replaceChildren();
    if (!elevations || elevations.length < 2) {
        container.classList.remove('active');
        return;
    }

    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const range = max - min || 1;
    const w = 300;
    const h = 64;
    const pad = 1;

    const pts = elevations.map((e, i) => {
        const x = (i / (elevations.length - 1)) * w;
        const y = h - pad - ((e - min) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const linePath = pts.join(' L');
    const areaPath = `M0,${h} L${pts[0]} L${linePath} L${w},${h} Z`;

    let gain = 0, loss = 0;
    for (let i = 1; i < elevations.length; i++) {
        const diff = elevations[i] - elevations[i - 1];
        if (diff > 0) gain += diff;
        else loss -= diff;
    }

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'elevation-chart');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const defs = document.createElementNS(NS, 'defs');
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.setAttribute('id', 'elevGrad');
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const chartColor = getRouteColor();
    const stop1 = document.createElementNS(NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', chartColor);
    stop1.setAttribute('stop-opacity', '0.4');
    const stop2 = document.createElementNS(NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', chartColor);
    stop2.setAttribute('stop-opacity', '0.05');
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);
    svg.appendChild(defs);

    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'url(#elevGrad)');
    svg.appendChild(area);

    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', chartColor);
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(line);

    container.appendChild(svg);

    const stats = document.createElement('div');
    stats.className = 'elevation-stats';
    const rangeStat = document.createElement('span');
    rangeStat.textContent = `${Math.round(min)}–${Math.round(max)} m`;
    const gainStat = document.createElement('span');
    gainStat.textContent = `↑ ${Math.round(gain)} m`;
    const lossStat = document.createElement('span');
    lossStat.textContent = `↓ ${Math.round(loss)} m`;
    stats.appendChild(rangeStat);
    stats.appendChild(gainStat);
    stats.appendChild(lossStat);
    container.appendChild(stats);

    container.classList.add('active');
}

// ─── Google Maps directions URL ──────────────────────────────────────────────

function buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode) {
    const base = 'https://www.google.com/maps/dir/?api=1&travelmode=walking';
    if (tripMode === 'one-way') {
        return `${base}&origin=${startLat},${startLng}&destination=${destLat},${destLng}`;
    }

    // Round-trip: synthesize the loop's via points geometrically so the Google
    // Maps link traces the same oval the in-app route does.
    const { offsetMult, viaTs } = getSpreadParams();
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const outVias = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const retVias = viaTs.slice().reverse().map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    const waypoints = [
        ...outVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`),
        `${destLat.toFixed(6)},${destLng.toFixed(6)}`,
        ...retVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)
    ].join('|');

    return `${base}&origin=${startLat},${startLng}&destination=${startLat},${startLng}&waypoints=${waypoints}`;
}

// ─── Display route results on map ────────────────────────────────────────────

function displayRoute(startLat, startLng, destLat, destLng, straightMax, straightMin,
                      outboundRoute, returnRoute, locationInput, destName, tripMode) {
    // Markers
    const routeColor = getRouteColor();
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

    // Route polylines — single color, glow style. Outbound + return read as
    // one continuous walk; direction is conveyed by the start dot vs dest pin.
    const allCoords = [];
    if (outboundRoute) {
        drawRouteGlow(outboundRoute.coords, routeColor);
        allCoords.push(...outboundRoute.coords);
    }
    if (returnRoute) {
        drawRouteGlow(returnRoute.coords, routeColor);
        allCoords.push(...returnRoute.coords);
    }

    // Fallback: dashed straight line if no routes at all
    if (!outboundRoute && !returnRoute) {
        drawRouteGlow([[startLat, startLng], [destLat, destLng]], routeColor, { dashed: true });
        allCoords.push([startLat, startLng], [destLat, destLng]);
    }

    // Fit bounds to show the entire loop
    map.fitBounds(L.latLngBounds(allCoords).pad(0.15));

    // Result panel
    const straightDistance = calculateDistance(startLat, startLng, destLat, destLng);
    const outDist  = outboundRoute ? outboundRoute.distance / 1000 : straightDistance;
    const retDist  = returnRoute   ? returnRoute.distance   / 1000 : straightDistance;
    const totalWalkKm = outDist + retDist;
    const totalDuration = (outboundRoute?.duration || 0) + (returnRoute?.duration || 0);

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
    updateDurationBadges(totalWalkKm, totalDuration, tripMode);

    document.getElementById('directionsLink').href =
        buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode);
    document.getElementById('streetViewLink').href =
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${destLat},${destLng}`;

    document.getElementById('resultPanel').classList.add('active');

    // Fetch elevation profile (non-blocking)
    const allRouteCoords = [
        ...(outboundRoute ? outboundRoute.coords : []),
        ...(returnRoute ? returnRoute.coords : [])
    ];
    if (allRouteCoords.length > 0) {
        document.getElementById('elevationContainer').classList.remove('active');
        fetchElevations(allRouteCoords)
            .then(renderElevationChart)
            .catch(() => {});
    }

    currentSession = {
        startLat, startLng, startLabel: locationInput,
        destLat, destLng, destName: destName || null,
        tripMode: tripMode || 'round',
        poiCategory: document.getElementById('locationTypeSelect')?.value || null,
        distance: totalWalkKm,
        routeCoords:         outboundRoute ? outboundRoute.coords    : null,
        routeDistance:       outboundRoute ? outboundRoute.distance / 1000 : null,
        routeDuration:       outboundRoute ? outboundRoute.duration  : null,
        routeSteps:          outboundRoute ? outboundRoute.steps     : null,
        returnRouteCoords:   returnRoute   ? returnRoute.coords      : null,
        returnRouteDistance: returnRoute   ? returnRoute.distance / 1000 : null,
        returnRouteDuration: returnRoute   ? returnRoute.duration    : null,
        returnRouteSteps:    returnRoute   ? returnRoute.steps       : null,
    };

    updateFavoriteBtn();
    saveToHistory(currentSession);
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

// Resolve the destination candidate pool for the chosen locationType. POI/road
// strategies hit Overpass and fall back to a random annulus pool on failure or
// empty result; 'any' goes straight to a random pool. Returns the full pool plus
// an initial novelty pick: { candidatePool, dest, destName }.
async function resolveCandidatePool(locationType, locationTypeVal, startLat, startLng, straightMin, straightMax, onProgress, existingDests) {
    if (locationType === 'roads') {
        onProgress('Searching for roads in the area…');
        try {
            const winterMode = document.getElementById('winterMode').checked;
            const roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress, winterMode);
            if (roads.length === 0) throw new Error('empty');
            const candidatePool = capPool(roads);
            return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
        } catch {
            onProgress('Overpass unavailable, using random point…');
            const candidatePool = randomCandidatePool(startLat, startLng, straightMin, straightMax);
            return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
        }
    }
    if (locationType === 'any_poi' || locationType === 'poi') {
        const filters = locationType === 'any_poi'
            ? POI_TYPES.map(p => p.filter)
            : [POI_TYPES.find(p => p.key === locationTypeVal)?.filter].filter(Boolean);
        const label = locationType === 'any_poi'
            ? 'any POI'
            : POI_TYPES.find(p => p.key === locationTypeVal)?.label || 'places';
        onProgress(`Searching for ${label}…`);
        try {
            const pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax, filters.length === 1 ? filters[0] : filters, onProgress);
            if (pois.length === 0) throw new Error('empty');
            const candidatePool = capPool(pois);
            const dest = pickMostNovelDestination(candidatePool, existingDests);
            return { candidatePool, dest, destName: dest.name };
        } catch {
            onProgress('Overpass unavailable, using random point…');
            const candidatePool = randomCandidatePool(startLat, startLng, straightMin, straightMax);
            return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
        }
    }
    // locationType === 'any': a fully random point anywhere in the annulus.
    const candidatePool = randomCandidatePool(startLat, startLng, straightMin, straightMax);
    return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
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
    const loadingEl = document.getElementById('loading');
    const onProgress = msg => loadingEl.querySelector('p').textContent = msg;

    await withLoading(async () => {
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

            displayRoute(startLat, startLng, dest.lat, dest.lng,
                         straightMax, straightMin, outboundRoute, returnRoute, locationInput, destName, tripMode);
            if (currentSession) currentSession.junctions = junctions;

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

// Map-click handler installed while "pick on map" mode is active: resolve the
// start, build a route to the clicked point, and render it. Hoisted to module
// scope (was an inline closure in togglePickMode) so the two function scopes
// read independently. Stored in the module-level `pickHandler` so exitPickMode
// can detach it.
async function handlePickClick(e) {
    exitPickMode();
    const destLat = e.latlng.lat;
    const destLng = e.latlng.lng;
    currentSession = null;
    resetMarkVisitedBtn();
    const loadingEl = document.getElementById('loading');
    const onProgress = msg => loadingEl.querySelector('p').textContent = msg;

    await withLoading(async () => {
        try {
            const { startLat, startLng, locationInput: locInput } = await resolveStart();
            clearMap();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            const smartRouting = tripMode !== 'one-way' && document.getElementById('smartRouting').checked;
            const r = await buildRouteForMode(startLat, startLng, destLat, destLng, {
                tripMode,
                smartRouting,
                winterMode: smartRouting && document.getElementById('winterMode').checked,
                maxKm: parseFloat(document.getElementById('maxDistance').value),
                onProgress,
                cachedJunctions: null,
                buildingMessage: 'Building route…',
                spread: getSpreadParams(),
            });
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         r.outbound, r.return, locInput, null, tripMode);
            if (currentSession) currentSession.junctions = r.junctions;
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

    pickHandler = handlePickClick;
    map.on('click', pickHandler);
}

function exitPickMode() {
    pickMode = false;
    const btn = document.getElementById('pickDestBtn');
    btn.classList.remove('active');
    btn.textContent = 'Pick on map';
    map.getContainer().style.cursor = '';
    if (pickHandler) {
        map.off('click', pickHandler);
        pickHandler = null;
    }
}

// ─── Mark as Visited ─────────────────────────────────────────────────────────

function markAsVisited() {
    if (!currentSession) return;
    const btn = document.getElementById('markVisitedBtn');

    // Undo: remove visit if already marked
    if (currentSession.visitId) {
        const undoneId = currentSession.visitId;
        const visits = getVisits().filter(v => v.id !== undoneId);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
        ExplorerSync.mutate('visits', 'delete', String(undoneId));
        currentSession.visitId = null;
        btn.classList.remove('marked');
        btn.textContent = 'Mark as visited';
        updateVisitedCounter();
        renderVisitedLayer();
        return;
    }

    const visit = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        startLat:            currentSession.startLat,
        startLng:            currentSession.startLng,
        startLabel:          currentSession.startLabel,
        destLat:             currentSession.destLat,
        destLng:             currentSession.destLng,
        distance:            currentSession.distance,
        routeCoords:         currentSession.routeCoords         || null,
        routeDistance:       currentSession.routeDistance       ?? null,
        routeDuration:       currentSession.routeDuration       || null,
        returnRouteCoords:   currentSession.returnRouteCoords   || null,
        returnRouteDistance: currentSession.returnRouteDistance ?? null,
        returnRouteDuration: currentSession.returnRouteDuration || null,
        destName:            currentSession.destName            || null,
        poiCategory:         currentSession.poiCategory         || null,
        tripMode:            currentSession.tripMode,
    };

    const visits = getVisits();
    visits.push(visit);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
    ExplorerSync.mutate('visits', 'put', visit.id, visit);
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

function toggleFavorite() {
    if (!currentSession) return;
    const btn = document.getElementById('favoriteBtn');
    const favs = getFavorites();

    // Check if already favorited (match by dest coords)
    const idx = favs.findIndex(f =>
        f.destLat.toFixed(6) === currentSession.destLat.toFixed(6) &&
        f.destLng.toFixed(6) === currentSession.destLng.toFixed(6)
    );

    if (idx >= 0) {
        const removed = favs[idx];
        favs.splice(idx, 1);
        btn.classList.remove('active');
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
        ExplorerSync.mutate('favorites', 'delete', String(removed.id));
    } else {
        const newFav = {
            id: crypto.randomUUID(),
            date: new Date().toISOString(),
            startLat:            currentSession.startLat,
            startLng:            currentSession.startLng,
            startLabel:          currentSession.startLabel,
            destLat:             currentSession.destLat,
            destLng:             currentSession.destLng,
            destName:            currentSession.destName || null,
            tripMode:            currentSession.tripMode,
            distance:            currentSession.distance,
            routeCoords:         currentSession.routeCoords         || null,
            routeDistance:       currentSession.routeDistance       ?? null,
            routeDuration:       currentSession.routeDuration       || null,
            returnRouteCoords:   currentSession.returnRouteCoords   || null,
            returnRouteDistance: currentSession.returnRouteDistance ?? null,
            returnRouteDuration: currentSession.returnRouteDuration || null,
        };
        favs.unshift(newFav);
        btn.classList.add('active');
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
        ExplorerSync.mutate('favorites', 'put', newFav.id, newFav);
        maybeRequestConsent();
    }
    renderFavoritesSection();
}

function updateFavoriteBtn() {
    const btn = document.getElementById('favoriteBtn');
    if (!currentSession) { btn.classList.remove('active'); return; }
    const favs = getFavorites();
    const isFav = favs.some(f =>
        f.destLat.toFixed(6) === currentSession.destLat.toFixed(6) &&
        f.destLng.toFixed(6) === currentSession.destLng.toFixed(6)
    );
    btn.classList.toggle('active', isFav);
}

function deleteFavorite(index, event) {
    event.stopPropagation();
    const favs = getFavorites();
    const removed = favs[index];
    favs.splice(index, 1);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
    ExplorerSync.mutate('favorites', 'delete', String(removed.id));
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
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, ...newEntries]));
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

    const loadingEl = document.getElementById('loading');
    const onProgress = msg => loadingEl.querySelector('p').textContent = msg;

    try {
        await withLoading(async () => {
            clearMap();
            onProgress('Loading shared route…');
            const smartRouting = m !== 'one-way' && document.getElementById('smartRouting').checked;
            const r = await buildRouteForMode(startLat, startLng, destLat, destLng, {
                tripMode: m,
                smartRouting,
                winterMode: smartRouting && document.getElementById('winterMode').checked,
                maxKm: parseFloat(document.getElementById('maxDistance').value),
                onProgress,
                cachedJunctions: null,
                buildingMessage: null,
                spread: getSpreadParams(),
            });
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         r.outbound, r.return, s, n, m);
            if (currentSession) currentSession.junctions = r.junctions;
        });
        // Clear hash after a successful restore so it doesn't re-trigger.
        history.replaceState(null, '', location.pathname);
    } catch (error) {
        showError(error.message || 'Could not load the shared route.');
    }
}

// ─── GPX export ──────────────────────────────────────────────────────────────

function exportGPX() {
    if (!currentSession) return;
    const { destName, routeCoords, returnRouteCoords } = currentSession;
    const name = destName || 'Wander route';
    const allCoords = mergeRouteCoords(routeCoords, returnRouteCoords);
    if (allCoords.length === 0) { showError('No route data to export.'); return; }

    const trkpts = allCoords.map(([lat, lng]) =>
        `      <trkpt lat="${lat}" lon="${lng}"></trkpt>`
    ).join('\n');

    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wander"
     xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name.replace(/[<>&]/g, '')}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

    triggerDownload(gpx, name, 'gpx', 'application/gpx+xml');
}

// ─── Garmin FIT export ───────────────────────────────────────────────────────

function openFITModal() {
    if (!currentSession) { showError('Generate a route first.'); return; }
    if (typeof FitEncoder === 'undefined') { showError('FIT encoder not loaded.'); return; }
    document.getElementById('fitModal').classList.add('active');
}

function closeFITModal() {
    document.getElementById('fitModal').classList.remove('active');
}

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

async function confirmFITExport() {
    if (!currentSession) { showError('Generate a route first.'); return; }
    closeFITModal();

    const { destName, routeCoords, returnRouteCoords, routeSteps, returnRouteSteps } = currentSession;
    const coords = mergeRouteCoords(routeCoords, returnRouteCoords);
    if (coords.length < 2) { showError('No route data to export.'); return; }

    const steps = [...(routeSteps || []), ...(returnRouteSteps || [])];
    const coursePoints = FitEncoder.osrmStepsToCoursePoints(coords, steps);

    let elevations = null;
    try { elevations = await fetchElevations(coords); } catch { /* optional */ }

    const name = destName || 'Wander route';
    const bytes = FitEncoder.encodeCourse({ name, coords, coursePoints, elevations });
    triggerDownload(bytes, name, 'fit', 'application/vnd.ant.fit');
}

// Concatenate outbound + return route coords, dropping the duplicate destination
// point (last of outbound == first of return, within 1 m).
function mergeRouteCoords(out, ret) {
    const a = out || [];
    const b = ret || [];
    if (a.length === 0) return b.slice();
    if (b.length === 0) return a.slice();
    const [aLat, aLng] = a[a.length - 1];
    const [bLat, bLng] = b[0];
    const dup = Math.abs(aLat - bLat) < 1e-5 && Math.abs(aLng - bLng) < 1e-5;
    return dup ? a.concat(b.slice(1)) : a.concat(b);
}

function triggerDownload(data, name, ext, mime) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase() || 'route'}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
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
    const loadingEl = document.getElementById('loading');
    const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
    resetMarkVisitedBtn();

    try {
        await withLoading(async () => {
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

            // Redraw routes (glow style, single color)
            const retryColor = getRouteColor();
            const allCoords = [];
            if (outbound) {
                drawRouteGlow(outbound.coords, retryColor);
                allCoords.push(...outbound.coords);
            }
            if (ret) {
                drawRouteGlow(ret.coords, retryColor);
                allCoords.push(...ret.coords);
            }
            if (allCoords.length > 0) {
                map.fitBounds(L.latLngBounds(allCoords).pad(0.15));
            }

            // Update badges
            const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
            const outDist = outbound ? outbound.distance / 1000 : straightDist;
            const retDist = ret      ? ret.distance      / 1000 : (tripMode === 'one-way' ? 0 : straightDist);
            const totalWalkKm = outDist + retDist;
            const totalDuration = (outbound?.duration || 0) + (ret?.duration || 0);

            updateDurationBadges(totalWalkKm, totalDuration, tripMode);

            document.getElementById('directionsLink').href =
                buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode);

            // Update session
            currentSession = {
                ...currentSession,
                distance: totalWalkKm,
                routeCoords:         outbound ? outbound.coords    : null,
                routeDistance:       outbound ? outbound.distance / 1000 : null,
                routeDuration:       outbound ? outbound.duration  : null,
                routeSteps:          outbound ? outbound.steps     : null,
                returnRouteCoords:   ret      ? ret.coords         : null,
                returnRouteDistance: ret      ? ret.distance / 1000 : null,
                returnRouteDuration: ret      ? ret.duration       : null,
                returnRouteSteps:    ret      ? ret.steps          : null,
                junctions
            };

            // Re-fetch elevation for new route
            const rerouteCoords = [
                ...(outbound ? outbound.coords : []),
                ...(ret ? ret.coords : [])
            ];
            if (rerouteCoords.length > 0) {
                fetchElevations(rerouteCoords)
                    .then(renderElevationChart)
                    .catch(() => {});
            }
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
    const entry = {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        startLat:            session.startLat,
        startLng:            session.startLng,
        startLabel:          session.startLabel,
        destLat:             session.destLat,
        destLng:             session.destLng,
        destName:            session.destName || null,
        tripMode:            session.tripMode,
        distance:            session.distance,
        routeCoords:         session.routeCoords         || null,
        routeDistance:       session.routeDistance       ?? null,
        routeDuration:       session.routeDuration       || null,
        returnRouteCoords:   session.returnRouteCoords   || null,
        returnRouteDistance: session.returnRouteDistance ?? null,
        returnRouteDuration: session.returnRouteDuration || null,
    };
    const history = getHistory();
    history.unshift(entry);
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    ExplorerSync.mutate('history', 'put', entry.id, entry);
    maybeRequestConsent();
    renderHistorySection();
}

function deleteHistoryEntry(index) {
    const history = getHistory();
    const removed = history[index];
    history.splice(index, 1);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    ExplorerSync.mutate('history', 'delete', String(removed.id));
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
    displayRoute(
        entry.startLat, entry.startLng,
        entry.destLat, entry.destLng,
        0, 0, outbound, ret,
        entry.startLabel, entry.destName, entry.tripMode
    );
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
if (typeof ExplorerSync !== 'undefined') {
    ExplorerSync.init().finally(updateSyncMenu);
    updateSyncMenu();
}
renderVisitedLayer();
updateVisitedCounter();
renderFavoritesSection();
renderHistorySection();
restoreFromHash();

// Update star button when location input changes
document.getElementById('location').addEventListener('input', updateSaveLocationBtn);
