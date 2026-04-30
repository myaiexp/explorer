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

const STORAGE_KEY = 'walk_visits';
const SETTINGS_KEY = 'walk_settings';

function getVisits() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}

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

const SAVED_LOCATIONS_KEY = 'walk_saved_locations';

function getSavedLocations() {
    try { return JSON.parse(localStorage.getItem(SAVED_LOCATIONS_KEY) || '[]'); } catch { return []; }
}

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

// ─── Random point generation ──────────────────────────────────────────────────

function generateRandomPointAnnulus(centerLat, centerLng, minKm, maxKm) {
    const minDeg = minKm / 111;
    const maxDeg = maxKm / 111;
    const r = Math.sqrt(Math.random() * (maxDeg ** 2 - minDeg ** 2) + minDeg ** 2);
    const theta = Math.random() * 2 * Math.PI;
    const latOffset = r * Math.cos(theta);
    const lngOffset = r * Math.sin(theta) / Math.cos(centerLat * Math.PI / 180);
    return { lat: centerLat + latOffset, lng: centerLng + lngOffset };
}

// ─── Distance & geometry ─────────────────────────────────────────────────────

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingRad(lat1, lng1, lat2, lng2) {
    const toRad = Math.PI / 180;
    const dLng = (lng2 - lng1) * toRad;
    const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
              Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
    return Math.atan2(y, x);
}

// Point at fraction t along A→B, offset perpendicular by a sin-envelope.
// Peaks at t=0.5 (midpoint), zero at t=0 and t=1 (endpoints).
function envelopeOffsetPoint(aLat, aLng, bLat, bLng, t, maxOffsetKm, side) {
    const lat0 = aLat + t * (bLat - aLat);
    const lng0 = aLng + t * (bLng - aLng);
    const brng = bearingRad(aLat, aLng, bLat, bLng);
    const perpBrng = brng + side * (Math.PI / 2);
    const envelope = Math.sin(Math.PI * t) * maxOffsetKm / 111;
    const lat = lat0 + envelope * Math.cos(perpBrng);
    const lng = lng0 + envelope * Math.sin(perpBrng) / Math.cos(lat0 * Math.PI / 180);
    return { lat, lng };
}

// ─── Novelty helpers ──────────────────────────────────────────────────────────

function getAllExistingDestinations() {
    return getVisits().map(v => [v.destLat, v.destLng]);
}

function pickMostNovelDestination(candidates, existingDests) {
    if (!existingDests || existingDests.length === 0) {
        return candidates[Math.floor(Math.random() * candidates.length)];
    }
    const scored = candidates.map(c => {
        const minDist = existingDests.reduce((min, [eLat, eLng]) =>
            Math.min(min, calculateDistance(c.lat, c.lng, eLat, eLng)), Infinity);
        return { ...c, minDist };
    });
    scored.sort((a, b) => b.minDist - a.minDist);
    const pool = scored.slice(0, Math.max(1, Math.ceil(scored.length / 2)));
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Overpass helpers ────────────────────────────────────────────────────────

async function queryOverpass(query, onProgress) {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            // Check status endpoint for actual wait time
            try {
                const status = await fetch('https://overpass-api.de/api/status').then(r => r.text());
                const match = status.match(/Slot available after: .+, in (\d+) seconds/);
                const waitSec = match ? Math.min(parseInt(match[1]) + 2, 60) : 15;
                if (onProgress) onProgress(`POI search is busy, retrying in ${waitSec}s…`);
                await sleep(waitSec * 1000);
            } catch {
                await sleep(15000);
            }
        }
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query)
        });
        if (response.ok) return response.json();
        if (response.status === 429 || response.status === 504) continue;
        throw new Error('Failed to fetch POI data. Please try again.');
    }
    throw new Error('POI search is busy. Please wait a moment and try again.');
}

// ─── POIs (Overpass) ─────────────────────────────────────────────────────────

async function fetchPOIsInRadius(centerLat, centerLng, minKm, maxKm, filter, onProgress) {
    const latOffset = maxKm / 111;
    const lngOffset = maxKm / (111 * Math.cos(centerLat * Math.PI / 180));
    const bbox = `${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset}`;
    const filters = Array.isArray(filter) ? filter : [filter];
    const unionBody = filters.map(f => `node${f}(${bbox});\nway${f}(${bbox});`).join('\n');
    const query = `
        [out:json][timeout:20];
        (
          ${unionBody}
        );
        out center tags;
    `;
    const data = await queryOverpass(query, onProgress);
    const pois = [];
    for (const el of data.elements) {
        let lat, lng;
        if (el.type === 'node') {
            lat = el.lat; lng = el.lon;
        } else if (el.type === 'way' && el.center) {
            lat = el.center.lat; lng = el.center.lon;
        } else {
            continue;
        }
        const dist = calculateDistance(centerLat, centerLng, lat, lng);
        if (dist >= minKm && dist <= maxKm) {
            pois.push({ lat, lng, name: el.tags?.name || null });
        }
    }
    return pois;
}

// ─── Roads (Overpass) ────────────────────────────────────────────────────────

const HIGHWAY_EXCLUDE_DEFAULT = 'motorway|motorway_link|trunk|trunk_link|service|steps';
const HIGHWAY_EXCLUDE_WINTER  = 'motorway|motorway_link|trunk|trunk_link|service|steps|path|track|footway|bridleway|cycleway|pedestrian';

async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm, onProgress, winterMode = false) {
    const latOffset = maxKm / 111;
    const lngOffset = maxKm / (111 * Math.cos(centerLat * Math.PI / 180));
    const exclude = winterMode ? HIGHWAY_EXCLUDE_WINTER : HIGHWAY_EXCLUDE_DEFAULT;
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"${exclude}"](${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset});
        out center;
    `;
    const data = await queryOverpass(query, onProgress);
    const points = [];
    for (const el of data.elements) {
        if (el.type === 'way' && el.center) {
            const dist = calculateDistance(centerLat, centerLng, el.center.lat, el.center.lon);
            if (dist >= minKm && dist <= maxKm) {
                points.push({ lat: el.center.lat, lng: el.center.lon });
            }
        }
    }
    return points;
}

// ─── OSRM routing ─────────────────────────────────────────────────────────────

// Self-hosted OSRM-foot for Finland.
const OSRM_FI_BASE    = 'https://mase.fi/api/osrm-fi/route/v1/foot';
const OSRM_FI_NEAREST = 'https://mase.fi/api/osrm-fi/nearest/v1/foot';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// Build a full oval loop: A → (right vias) → B → (left vias) → A
// Returns { outbound, return } where each is {coords, duration, distance} or null.
// Tries both chiralities (right-then-left vs left-then-right), picks least overlap.
// Read the spread slider (0-100) and return a continuous offset multiplier.
// Always uses 3 via points at fixed t positions for consistent loop shape.
// The slider only changes HOW FAR the vias are pushed sideways.
//   0% → offsetMult ~0.03 (nearly straight, barely any loop)
// 50% → offsetMult ~0.15 (gentle oval, default)
// 100% → offsetMult ~0.40 (wide exploratory loop)
function getSpreadParams() {
    const raw = parseInt(document.getElementById('spreadSlider').value, 10) || 50;
    const pct = raw / 100;
    // Quadratic curve: gentle changes near middle, steeper at extremes
    const offsetMult = 0.03 + pct * pct * 0.37;
    return { offsetMult, viaTs: [0.25, 0.5, 0.75] };
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

async function buildLoop(startLat, startLng, destLat, destLng) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const { offsetMult, viaTs } = getSpreadParams();
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const A = { lat: startLat, lng: startLng };
    const B = { lat: destLat,  lng: destLng };

    // Generate via points on each side using sin-envelope
    const viasRight = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const viasLeftReturn = viaTs.slice().reverse().map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    // Snap all 6 vias to nearest roads in parallel (threshold: half the offset distance)
    const snapRadius = Math.max(0.3, offsetKm * 0.5);
    const allVias = [...viasRight, ...viasLeftReturn];
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
async function fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode = false) {
    const minLat = Math.min(startLat, destLat);
    const maxLat = Math.max(startLat, destLat);
    const minLng = Math.min(startLng, destLng);
    const maxLng = Math.max(startLng, destLng);
    const midLat = (minLat + maxLat) / 2;
    const latPad = offsetKm / 111;
    const lngPad = offsetKm / (111 * Math.cos(midLat * Math.PI / 180));
    const bbox = `${minLat - latPad},${minLng - lngPad},${maxLat + latPad},${maxLng + lngPad}`;
    const exclude = winterMode ? 'winter' : 'default';
    const url = `/api/junctions/junctions?bbox=${encodeURIComponent(bbox)}&exclude=${exclude}`;
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
async function buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, cachedJunctions = null, winterMode = false) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const { offsetMult, viaTs } = getSpreadParams();
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const A = { lat: startLat, lng: startLng };
    const B = { lat: destLat,  lng: destLng };

    // Forward-order vias on each side. Reversal happens at call time on the
    // leg that needs it (return-direction leg).
    const viasRight = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const viasLeft = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    let junctions = cachedJunctions;
    if (!junctions) {
        try {
            onProgress('Searching for junctions…');
            junctions = await fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, onProgress, winterMode);
        } catch {
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            return { outbound: loop.outbound, return: loop.return, overlap: null, junctions: null };
        }
    }

    const snapRadius = Math.max(0.3, offsetKm * 0.5);
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
        const loop = await buildLoop(startLat, startLng, destLat, destLng);
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

function showError(message) {
    const el = document.getElementById('error');
    el.textContent = message;
    el.style.color = '';
    el.style.background = '';
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 5000);
}

function showSuccess(message) {
    const el = document.getElementById('error');
    el.textContent = message;
    el.style.color = '#86efac';
    el.style.background = 'rgba(34, 197, 94, 0.15)';
    el.style.borderColor = 'rgba(34, 197, 94, 0.3)';
    el.classList.add('active');
    setTimeout(() => {
        el.classList.remove('active');
        el.style.color = '';
        el.style.background = '';
        el.style.borderColor = '';
    }, 4000);
}

function showWarning(message) {
    const el = document.getElementById('error');
    el.textContent = message;
    el.style.color = '#fcd34d';
    el.style.background = 'rgba(245, 158, 11, 0.15)';
    el.style.borderColor = 'rgba(245, 158, 11, 0.3)';
    el.classList.add('active');
    setTimeout(() => {
        el.classList.remove('active');
        el.style.color = '';
        el.style.background = '';
        el.style.borderColor = '';
    }, 5000);
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
    const deleteBtn = document.getElementById('deleteCloudDataBtn');
    if (!status || !enableBtn || !deleteBtn) return;
    if (s.state === 'accepted') {
        status.style.display = '';
        if (usernameEl) usernameEl.textContent = s.username || '';
        enableBtn.style.display = 'none';
        deleteBtn.style.display = '';
    } else {
        status.style.display = 'none';
        if (usernameEl) usernameEl.textContent = '';
        enableBtn.style.display = '';
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

    // Build SVG path for filled area
    const pts = elevations.map((e, i) => {
        const x = (i / (elevations.length - 1)) * w;
        const y = h - pad - ((e - min) / range) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const linePath = pts.join(' L');
    const areaPath = `M0,${h} L${pts[0]} L${linePath} L${w},${h} Z`;

    // Gain/loss calculation
    let gain = 0, loss = 0;
    for (let i = 1; i < elevations.length; i++) {
        const diff = elevations[i] - elevations[i - 1];
        if (diff > 0) gain += diff;
        else loss -= diff;
    }

    // Build SVG via DOM
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

function buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode, outboundVias, returnVias) {
    const base = 'https://www.google.com/maps/dir/?api=1&travelmode=walking';
    if (tripMode === 'one-way') {
        return `${base}&origin=${startLat},${startLng}&destination=${destLat},${destLng}`;
    }

    // Use provided vias if available, otherwise fall back to geometric computation
    let outVias, retVias;
    if (outboundVias && returnVias) {
        outVias = outboundVias;
        retVias = returnVias;
    } else {
        const { offsetMult, viaTs } = getSpreadParams();
        const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
        const offsetKm = Math.max(0.1, straightDist * offsetMult);
        outVias = viaTs.map(t =>
            envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
        retVias = viaTs.slice().reverse().map(t =>
            envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
    }

    const waypoints = [
        ...outVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`),
        `${destLat.toFixed(6)},${destLng.toFixed(6)}`,
        ...retVias.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)
    ].join('|');

    return `${base}&origin=${startLat},${startLng}&destination=${startLat},${startLng}&waypoints=${waypoints}`;
}

// ─── Display route results on map ────────────────────────────────────────────

function displayRoute(startLat, startLng, destLat, destLng, straightMax, straightMin,
                      outboundRoute, returnRoute, locationInput, destName, tripMode,
                      outboundVias, returnVias) {
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
        buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode, outboundVias, returnVias);
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
        routeCoords:         outboundRoute ? outboundRoute.coords   : null,
        routeDuration:       outboundRoute ? outboundRoute.duration  : null,
        routeSteps:          outboundRoute ? outboundRoute.steps     : null,
        returnRouteCoords:   returnRoute   ? returnRoute.coords      : null,
        returnRouteDuration: returnRoute   ? returnRoute.duration    : null,
        returnRouteSteps:    returnRoute   ? returnRoute.steps       : null,
        outboundVias:        outboundVias  || null,
        returnVias:          returnVias    || null
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

// ─── Main: generate random destination ───────────────────────────────────────

async function generateDestination() {
    const minKm = parseFloat(document.getElementById('minDistance').value) || 0;
    const maxKm = parseFloat(document.getElementById('maxDistance').value);
    const loadingEl = document.getElementById('loading');
    const btn = document.getElementById('generateBtn');

    if (isNaN(maxKm) || maxKm <= 0) { showError('Please enter a valid maximum distance greater than 0.'); return; }
    if (minKm < 0) { showError('Minimum distance cannot be negative.'); return; }
    if (minKm >= maxKm) { showError('Minimum distance must be less than maximum distance.'); return; }

    loadingEl.classList.add('active');
    btn.disabled = true;
    document.getElementById('error').classList.remove('active');
    currentSession = null;
    resetMarkVisitedBtn();
    const onProgress = msg => loadingEl.querySelector('p').textContent = msg;

    try {
        const { startLat, startLng, locationInput } = await resolveStart();
        clearMap();

        const existingDests = getAllExistingDestinations();

        const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
        const locationTypeVal = document.getElementById('locationTypeSelect').value;
        const locationType = (locationTypeVal === 'any' || locationTypeVal === 'roads') ? locationTypeVal
            : locationTypeVal === 'any_poi' ? 'any_poi' : 'poi';

        // Straight-line scaling: round trip ≈ budget / 2.6, one-way ≈ budget / 1.3
        const scale = tripMode === 'one-way' ? 1.3 : 2.6;
        const straightMin = minKm / scale;
        const straightMax = maxKm / scale;
        let dest;
        let destName = null;
        let usedFallback = false;
        // Phase 2: capture the candidate pool that produced `dest` so the
        // smart-routing branch can re-rank it for retries without re-fetching.
        let candidatePool = null;

        if (locationType === 'roads') {
            onProgress('Searching for roads in the area…');
            try {
                const winterMode = document.getElementById('winterMode').checked;
                const roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress, winterMode);
                if (roads.length === 0) throw new Error('empty');
                candidatePool = roads;
                dest = pickMostNovelDestination(roads, existingDests);
            } catch {
                onProgress('Overpass unavailable, using random point…');
                const candidates = Array.from({ length: 5 }, () =>
                    generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
                candidatePool = candidates;
                dest = pickMostNovelDestination(candidates, existingDests);
                usedFallback = true;
            }
        } else if (locationType === 'any_poi' || locationType === 'poi') {
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
                candidatePool = pois;
                dest = pickMostNovelDestination(pois, existingDests);
                destName = dest.name;
            } catch {
                onProgress('Overpass unavailable, using random point…');
                const candidates = Array.from({ length: 5 }, () =>
                    generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
                candidatePool = candidates;
                dest = pickMostNovelDestination(candidates, existingDests);
                usedFallback = true;
            }
        } else {
            const candidates = Array.from({ length: 5 }, () =>
                generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
            candidatePool = candidates;
            dest = pickMostNovelDestination(candidates, existingDests);
        }

        // Build route
        let outboundRoute, returnRoute, junctions = null;
        let overlap = null;
        if (tripMode === 'one-way') {
            onProgress('Building route…');
            outboundRoute = await buildOneWay(startLat, startLng, dest.lat, dest.lng);
            returnRoute = null;
        } else if (document.getElementById('smartRouting').checked) {
            const winterMode = document.getElementById('winterMode').checked;
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
                    tryDest.lat, tryDest.lng, onProgress, cachedJunctions, winterMode);
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

            if (bestSeen) {
                dest = bestSeen.dest;
                destName = bestSeen.destName;
                outboundRoute = bestSeen.outbound;
                returnRoute = bestSeen.return;
                junctions = bestSeen.junctions;
                overlap = bestSeen.overlap;
            }
        } else {
            onProgress('Building route…');
            const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }

        displayRoute(startLat, startLng, dest.lat, dest.lng,
                     straightMax, straightMin, outboundRoute, returnRoute, locationInput, destName, tripMode,
                     null, null);
        if (currentSession) currentSession.junctions = junctions;

        if (overlap !== null && overlap >= OVERLAP_BAD_THRESHOLD) {
            showWarning('This area has limited routing options — the loop overlaps significantly.');
        }

    } catch (error) {
        showError(error.message || 'An error occurred. Please try again.');
    } finally {
        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        btn.disabled = false;
    }
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

    pickHandler = async function (e) {
        exitPickMode();
        const destLat = e.latlng.lat;
        const destLng = e.latlng.lng;

        const loadingEl = document.getElementById('loading');
        const genBtn = document.getElementById('generateBtn');
        loadingEl.classList.add('active');
        genBtn.disabled = true;
        currentSession = null;
        resetMarkVisitedBtn();

        try {
            const { startLat, startLng, locationInput: locInput } = await resolveStart();
            clearMap();
            const tripMode = document.querySelector('input[name="tripMode"]:checked').value;
            let outboundRoute, returnRoute, junctions = null;
            const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
            if (tripMode === 'one-way') {
                onProgress('Building route…');
                outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
                returnRoute = null;
            } else if (document.getElementById('smartRouting').checked) {
                const winterMode = document.getElementById('winterMode').checked;
                const result = await buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, null, winterMode);
                outboundRoute = result.outbound;
                returnRoute = result.return;
                junctions = result.junctions;
            } else {
                onProgress('Building route…');
                const loop = await buildLoop(startLat, startLng, destLat, destLng);
                outboundRoute = loop.outbound;
                returnRoute = loop.return;
            }
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         outboundRoute, returnRoute, locInput, null, tripMode,
                         null, null);
            if (currentSession) currentSession.junctions = junctions;
        } catch (error) {
            showError(error.message || 'An error occurred. Please try again.');
        } finally {
            loadingEl.classList.remove('active');
            loadingEl.querySelector('p').textContent = 'Finding your random destination…';
            genBtn.disabled = false;
        }
    };
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
        routeDuration:       currentSession.routeDuration       || null,
        returnRouteCoords:   currentSession.returnRouteCoords   || null,
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

// ─── Favorites ───────────────────────────────────────────────────────────────

const FAVORITES_KEY = 'walk_favorites';

function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'); } catch { return []; }
}

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
            routeDuration:       currentSession.routeDuration       || null,
            returnRouteCoords:   currentSession.returnRouteCoords   || null,
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

        const item = document.createElement('div');
        item.className = 'history-item';
        item.addEventListener('click', () => {
            restoreResult(getFavorites()[i]);
            updateFavoriteBtn();
        });

        const nameEl = document.createElement('div');
        nameEl.className = 'history-item-name';
        nameEl.textContent = label;
        item.appendChild(nameEl);

        const metaEl = document.createElement('div');
        metaEl.className = 'history-item-meta';
        metaEl.textContent = dist;
        item.appendChild(metaEl);

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'history-delete';
        del.title = 'Remove';
        del.textContent = '\u00d7';
        del.addEventListener('click', (e) => deleteFavorite(i, e));
        item.appendChild(del);

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
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...existing, ...newEntries]));
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

        // Set UI state
        document.getElementById('location').value = s;
        if (m === 'one-way') document.getElementById('oneWay').checked = true;
        else document.getElementById('roundTrip').checked = true;

        const loadingEl = document.getElementById('loading');
        const genBtn = document.getElementById('generateBtn');
        loadingEl.classList.add('active');
        loadingEl.querySelector('p').textContent = 'Loading shared route…';
        genBtn.disabled = true;

        clearMap();
        let outboundRoute, returnRoute, junctions = null;
        const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
        onProgress('Loading shared route…');
        if (m === 'one-way') {
            outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
            returnRoute = null;
        } else if (document.getElementById('smartRouting').checked) {
            const winterMode = document.getElementById('winterMode').checked;
            const result = await buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, null, winterMode);
            outboundRoute = result.outbound;
            returnRoute = result.return;
            junctions = result.junctions;
        } else {
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }
        displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                     outboundRoute, returnRoute, s, n, m,
                     null, null);
        if (currentSession) currentSession.junctions = junctions;

        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        genBtn.disabled = false;

        // Clear hash after restoring so it doesn't re-trigger
        history.replaceState(null, '', location.pathname);
    } catch {}
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
    const { startLat, startLng, destLat, destLng, startLabel } = currentSession;
    const loadingEl = document.getElementById('loading');
    const genBtn = document.getElementById('generateBtn');

    loadingEl.classList.add('active');
    loadingEl.querySelector('p').textContent = 'Adjusting route…';
    genBtn.disabled = true;
    resetMarkVisitedBtn();

    try {
        // Keep markers and circles, only clear route lines
        routeLines.forEach(l => map.removeLayer(l));
        routeLines = [];

        const { tripMode } = currentSession;
        let outbound, ret, junctions = currentSession.junctions || null;
        const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
        if (tripMode === 'one-way') {
            outbound = await buildOneWay(startLat, startLng, destLat, destLng);
            ret = null;
        } else if (document.getElementById('smartRouting').checked) {
            const winterMode = document.getElementById('winterMode').checked;
            const result = await buildJunctionLoop(startLat, startLng, destLat, destLng, onProgress, junctions, winterMode);
            outbound = result.outbound;
            ret = result.return;
            junctions = result.junctions;
        } else {
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            outbound = loop.outbound;
            ret = loop.return;
            junctions = null;
        }

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
            buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode, null, null);

        // Update session
        currentSession = {
            ...currentSession,
            distance: totalWalkKm,
            routeCoords:         outbound ? outbound.coords   : null,
            routeDuration:       outbound ? outbound.duration  : null,
            routeSteps:          outbound ? outbound.steps     : null,
            returnRouteCoords:   ret      ? ret.coords         : null,
            returnRouteDuration: ret      ? ret.duration       : null,
            returnRouteSteps:    ret      ? ret.steps          : null,
            outboundVias:        null,
            returnVias:          null,
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
    } catch (error) {
        showError(error.message || 'Failed to adjust route.');
    } finally {
        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        genBtn.disabled = false;
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

const HISTORY_KEY = 'walk_history';
const HISTORY_MAX = 20;
const HISTORY_VISIBLE = 3;
let historyExpanded = false;

function getHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}

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
        routeDuration:       session.routeDuration       || null,
        returnRouteCoords:   session.returnRouteCoords   || null,
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
    const outbound = entry.routeCoords
        ? { coords: entry.routeCoords, distance: entry.distance * 1000, duration: entry.routeDuration || 0 }
        : null;
    const ret = entry.returnRouteCoords
        ? { coords: entry.returnRouteCoords, distance: 0, duration: entry.returnRouteDuration || 0 }
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

        const item = document.createElement('div');
        item.className = 'history-item';
        item.addEventListener('click', () => restoreResult(getHistory()[i]));

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
        del.textContent = '\u00d7';
        del.addEventListener('click', (e) => { e.stopPropagation(); deleteHistoryEntry(i); });
        item.appendChild(del);

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
