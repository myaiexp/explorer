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

// ─── Mutable map state ────────────────────────────────────────────────────────

let markers = [];
let circle = null;
let innerCircle = null;
let routeLines = [];  // all polylines for the loop

// Current in-progress destination (reset on each generation)
let currentSession = null;

// Map-click mode for "pick destination" feature
let pickMode = false;
let pickHandler = null;

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
        requestDelay: requestDelay
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
        if (settings.requestDelay != null) {
            requestDelay = settings.requestDelay;
            document.getElementById('delaySlider').value = requestDelay;
            document.getElementById('delayValue').textContent = requestDelay + 'ms';
        }
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
    document.getElementById('delaySlider').addEventListener('change', saveSettings);
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
        saved.splice(existing, 1);
        localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
        showSuccess('Location removed from saved.');
    } else {
        const label = prompt('Name for this location:', input);
        if (label === null) return;
        saved.push({ label: label || input, value: input });
        localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
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
    saved.splice(index, 1);
    localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
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

function clearMap() {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
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

// ─── Road-side classification & via matching ─────────────────────────────────

// Cross-product sign: which side of line A→B does point P fall on?
// Returns 1 (left), -1 (right), or 0 (on line)
function classifyPointSide(aLat, aLng, bLat, bLng, pLat, pLng) {
    const cross = (bLng - aLng) * (pLat - aLat) - (bLat - aLat) * (pLng - aLng);
    if (cross > 0) return 1;
    if (cross < 0) return -1;
    return 0;
}

// Split road points into left/right arrays relative to start→dest line
function classifyRoads(roads, startLat, startLng, destLat, destLng) {
    const left = [], right = [];
    for (const road of roads) {
        const side = classifyPointSide(startLat, startLng, destLat, destLng, road.lat, road.lng);
        if (side > 0) left.push(road);
        else if (side < 0) right.push(road);
        // on-line points are dropped (ambiguous)
    }
    return { left, right };
}

// From roads on one side, pick the 3 closest to the geometric ideal via positions.
// geometricVias = array of {lat, lng} (the envelope-offset targets).
// Returns 3 {lat, lng} from roads, or geometric fallback if insufficient roads.
function selectRoadVias(roads, geometricVias) {
    if (roads.length < 3) return geometricVias;
    const candidates = [...roads];
    const picked = [];
    for (const gv of geometricVias) {
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < candidates.length; i++) {
            const d = calculateDistance(gv.lat, gv.lng, candidates[i].lat, candidates[i].lng);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        picked.push(candidates[bestIdx]);
        candidates.splice(bestIdx, 1); // don't reuse
    }
    return picked;
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
                if (onProgress) onProgress(`OpenStreetMap is busy, retrying in ${waitSec}s…`);
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
        throw new Error('Failed to fetch data from OpenStreetMap. Please try again.');
    }
    throw new Error('OpenStreetMap is busy. Please wait a moment and try again.');
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

async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm, onProgress) {
    const latOffset = maxKm / 111;
    const lngOffset = maxKm / (111 * Math.cos(centerLat * Math.PI / 180));
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link|service|steps"](${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset});
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

// Fetch roads in the corridor between start and dest, expanded by offsetKm on each side.
// Returns array of {lat, lng} road center points.
async function fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm, onProgress) {
    const cosLat = Math.cos(((startLat + destLat) / 2) * Math.PI / 180);
    const latPad = offsetKm / 111;
    const lngPad = offsetKm / (111 * cosLat);
    const minLat = Math.min(startLat, destLat) - latPad;
    const maxLat = Math.max(startLat, destLat) + latPad;
    const minLng = Math.min(startLng, destLng) - lngPad;
    const maxLng = Math.max(startLng, destLng) + lngPad;
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link|service|steps"](${minLat},${minLng},${maxLat},${maxLng});
        out center;
    `;
    const data = await queryOverpass(query, onProgress);
    const points = [];
    for (const el of data.elements) {
        if (el.type === 'way' && el.center) {
            points.push({ lat: el.center.lat, lng: el.center.lon });
        }
    }
    return points;
}

// ─── OSRM routing ─────────────────────────────────────────────────────────────

const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';

let requestDelay = 300;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function adjustRequestDelay(delta) {
    requestDelay = Math.max(0, Math.min(2000, requestDelay + delta));
    document.getElementById('delayValue').textContent = requestDelay + 'ms';
}

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance, steps} or null.
async function fetchRouteThrough(waypoints) {
    await sleep(requestDelay);
    try {
        const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
        const url = `${OSRM_BASE}/${coordStr}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.routes || data.routes.length === 0) return null;
        const r = data.routes[0];
        // Flatten steps from all legs
        const steps = r.legs ? r.legs.flatMap(leg => leg.steps || []) : null;
        return {
            coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
            duration: r.duration,
            distance: r.distance,
            steps: steps
        };
    } catch { return null; }
}

// Count u-turns in a route's step data.
// Returns number of steps where maneuver modifier === "uturn".
function countUTurns(steps) {
    if (!steps) return 0;
    return steps.filter(s => s.maneuver && s.maneuver.modifier === 'uturn').length;
}

// Fetch up to `count` nearest road snap points from OSRM nearest service.
// Returns array of {lat, lng} sorted by distance, or empty array on failure.
async function fetchNearestRoadSnaps(lat, lng, count = 5) {
    await sleep(requestDelay);
    try {
        const nearestBase = OSRM_BASE.replace('/route/', '/nearest/');
        const url = `${nearestBase}/${lng},${lat}?number=${count}`;
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = await res.json();
        if (!data.waypoints) return [];
        return data.waypoints.map(wp => ({ lat: wp.location[1], lng: wp.location[0] }));
    } catch { return []; }
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

// Snap a geometric via to the nearest road point within maxKm.
// Returns the snapped point, or the original if snapping fails or is too far.
async function snapToRoad(via, maxKm = 0.5) {
    try {
        const nearestBase = OSRM_BASE.replace('/route/', '/nearest/');
        const res = await fetch(`${nearestBase}/${via.lng},${via.lat}?number=1`);
        if (!res.ok) return via;
        const data = await res.json();
        if (!data.waypoints || !data.waypoints.length) return via;
        const snap = { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
        const dist = calculateDistance(via.lat, via.lng, snap.lat, snap.lng);
        return dist <= maxKm ? snap : via;
    } catch { return via; }
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

// Build a round-trip loop using road-sourced vias with u-turn mitigation.
// onProgress(message) callback updates loading text.
// cachedRoads: optional previously-fetched roads (for spread slider re-routes).
// Returns { outbound, return, outboundVias, returnVias, roads }
async function buildSmartLoop(startLat, startLng, destLat, destLng, onProgress, cachedRoads = null) {
    const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
    const { offsetMult, viaTs } = getSpreadParams();
    const offsetKm = Math.max(0.1, straightDist * offsetMult);
    const A = { lat: startLat, lng: startLng };
    const B = { lat: destLat,  lng: destLng };

    // 1. Compute geometric via targets (same as buildLoop)
    const geoViasRight = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const geoViasLeft = viaTs.slice().reverse().map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));

    // 2. Fetch roads in corridor
    let roads = cachedRoads;
    if (!roads) {
        try {
            onProgress('Searching for roads…');
            roads = await fetchRoadsInCorridor(startLat, startLng, destLat, destLng, offsetKm, onProgress);
        } catch {
            // Fall back to geometric vias on road fetch failure
            onProgress('Building round-trip loop…');
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            return { outbound: loop.outbound, return: loop.return, outboundVias: geoViasRight, returnVias: geoViasLeft, roads: null };
        }
    }

    // 3. Classify roads into left/right
    const { left, right } = classifyRoads(roads, startLat, startLng, destLat, destLng);

    // 4. Match to road vias (right for outbound, left for return)
    let outboundVias = selectRoadVias(right, geoViasRight);
    let returnVias   = selectRoadVias(left,  geoViasLeft);

    // 5. Build outbound route: A → rightVias → B
    onProgress('Building outbound route…');
    let outbound = await fetchRouteThrough([A, ...outboundVias, B]);

    // 6. Build return route: B → leftVias → A
    onProgress('Building return route…');
    let ret = await fetchRouteThrough([B, ...returnVias, A]);

    // If either route failed, fall back to geometric
    if (!outbound || !ret) {
        const loop = await buildLoop(startLat, startLng, destLat, destLng);
        return { outbound: loop.outbound, return: loop.return, outboundVias: geoViasRight, returnVias: geoViasLeft, roads };
    }

    // 7. Count u-turns and attempt mitigation (up to 2 rounds)
    let outUTurns = countUTurns(outbound.steps);
    let retUTurns = countUTurns(ret.steps);

    for (let round = 0; round < 2 && (outUTurns + retUTurns) > 0; round++) {
        onProgress('Optimizing route…');

        // Try fixing outbound u-turns
        if (outUTurns > 0 && outbound.steps) {
            const uturnSteps = outbound.steps.filter(s => s.maneuver && s.maneuver.modifier === 'uturn');
            for (const utStep of uturnSteps) {
                const loc = utStep.maneuver.location; // [lng, lat]
                const uLat = loc[1], uLng = loc[0];

                // Find which via is closest to the u-turn
                let closestIdx = -1, closestDist = Infinity;
                for (let i = 0; i < outboundVias.length; i++) {
                    const d = calculateDistance(uLat, uLng, outboundVias[i].lat, outboundVias[i].lng);
                    if (d < closestDist) { closestDist = d; closestIdx = i; }
                }
                if (closestIdx < 0) continue;

                // Get alternative snaps
                const snaps = await fetchNearestRoadSnaps(outboundVias[closestIdx].lat, outboundVias[closestIdx].lng, 5);
                if (snaps.length === 0) continue;

                // Try each snap, keep the one with fewer u-turns
                for (const snap of snaps) {
                    const testVias = [...outboundVias];
                    testVias[closestIdx] = snap;
                    const testRoute = await fetchRouteThrough([A, ...testVias, B]);
                    if (testRoute && countUTurns(testRoute.steps) < outUTurns) {
                        outboundVias = testVias;
                        outbound = testRoute;
                        outUTurns = countUTurns(testRoute.steps);
                        break;
                    }
                }
            }
        }

        // Try fixing return u-turns
        if (retUTurns > 0 && ret.steps) {
            const uturnSteps = ret.steps.filter(s => s.maneuver && s.maneuver.modifier === 'uturn');
            for (const utStep of uturnSteps) {
                const loc = utStep.maneuver.location;
                const uLat = loc[1], uLng = loc[0];

                let closestIdx = -1, closestDist = Infinity;
                for (let i = 0; i < returnVias.length; i++) {
                    const d = calculateDistance(uLat, uLng, returnVias[i].lat, returnVias[i].lng);
                    if (d < closestDist) { closestDist = d; closestIdx = i; }
                }
                if (closestIdx < 0) continue;

                const snaps = await fetchNearestRoadSnaps(returnVias[closestIdx].lat, returnVias[closestIdx].lng, 5);
                if (snaps.length === 0) continue;

                for (const snap of snaps) {
                    const testVias = [...returnVias];
                    testVias[closestIdx] = snap;
                    const testRoute = await fetchRouteThrough([B, ...testVias, A]);
                    if (testRoute && countUTurns(testRoute.steps) < retUTurns) {
                        returnVias = testVias;
                        ret = testRoute;
                        retUTurns = countUTurns(testRoute.steps);
                        break;
                    }
                }
            }
        }
    }

    return { outbound, return: ret, outboundVias, returnVias, roads };
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
    const stop1 = document.createElementNS(NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', '#3b82f6');
    stop1.setAttribute('stop-opacity', '0.4');
    const stop2 = document.createElementNS(NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', '#3b82f6');
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
    line.setAttribute('stroke', '#3b82f6');
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
                      outboundVias, returnVias, cachedRoads) {
    // Markers
    const startMarker = L.marker([startLat, startLng], { icon: createPinIcon('#3b82f6') })
        .addTo(map).bindPopup('<b>Start</b><br>' + locationInput);
    markers.push(startMarker);

    const destMarker = L.marker([destLat, destLng], { icon: createPinIcon('#f59e0b') })
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

    // Route polylines — blue outbound, amber return
    const allCoords = [];
    if (outboundRoute) {
        const line = L.polyline(outboundRoute.coords, {
            color: '#3b82f6', weight: 3, opacity: 0.85
        }).addTo(map);
        routeLines.push(line);
        allCoords.push(...outboundRoute.coords);
    }
    if (returnRoute) {
        const line = L.polyline(returnRoute.coords, {
            color: '#f59e0b', weight: 3, opacity: 0.85
        }).addTo(map);
        routeLines.push(line);
        allCoords.push(...returnRoute.coords);
    }

    // Fallback: dashed straight line if no routes at all
    if (!outboundRoute && !returnRoute) {
        const line = L.polyline([[startLat, startLng], [destLat, destLng]], {
            color: '#3b82f6', weight: 3, opacity: 0.7, dashArray: '10, 10'
        }).addTo(map);
        routeLines.push(line);
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
        nameEl.innerHTML = `<a href="${mapsUrl}" target="_blank">${destName}</a>`;
        nameEl.style.display = 'block';
    } else {
        nameEl.innerHTML = '';
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
        distance: totalWalkKm,
        routeCoords:         outboundRoute ? outboundRoute.coords   : null,
        routeDuration:       outboundRoute ? outboundRoute.duration  : null,
        returnRouteCoords:   returnRoute   ? returnRoute.coords      : null,
        returnRouteDuration: returnRoute   ? returnRoute.duration    : null,
        outboundVias:        outboundVias  || null,
        returnVias:          returnVias    || null,
        cachedRoads:         cachedRoads   || null
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

        if (locationType === 'roads') {
            onProgress('Searching for roads in the area…');
            try {
                const roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress);
                if (roads.length === 0) throw new Error('empty');
                dest = pickMostNovelDestination(roads, existingDests);
            } catch {
                onProgress('Overpass unavailable, using random point…');
                const candidates = Array.from({ length: 5 }, () =>
                    generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
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
                dest = pickMostNovelDestination(pois, existingDests);
                destName = dest.name;
            } catch {
                onProgress('Overpass unavailable, using random point…');
                const candidates = Array.from({ length: 5 }, () =>
                    generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
                dest = pickMostNovelDestination(candidates, existingDests);
                usedFallback = true;
            }
        } else {
            const candidates = Array.from({ length: 5 }, () =>
                generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
            dest = pickMostNovelDestination(candidates, existingDests);
        }

        // Build route
        let outboundRoute, returnRoute, smartLoopData = null;
        const useSmartRouting = document.getElementById('smartRouting').checked;
        if (tripMode === 'one-way') {
            onProgress('Building route…');
            outboundRoute = await buildOneWay(startLat, startLng, dest.lat, dest.lng);
            returnRoute = null;
        } else if (useSmartRouting) {
            const loop = await buildSmartLoop(startLat, startLng, dest.lat, dest.lng, onProgress);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
            smartLoopData = loop;
        } else {
            onProgress('Building route…');
            const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }

        displayRoute(startLat, startLng, dest.lat, dest.lng,
                     straightMax, straightMin, outboundRoute, returnRoute, locationInput, destName, tripMode,
                     smartLoopData?.outboundVias, smartLoopData?.returnVias, smartLoopData?.roads);

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
            let outboundRoute, returnRoute, smartLoopData = null;
            const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
            const useSmartRouting = document.getElementById('smartRouting').checked;
            if (tripMode === 'one-way') {
                onProgress('Building route…');
                outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
                returnRoute = null;
            } else if (useSmartRouting) {
                const loop = await buildSmartLoop(startLat, startLng, destLat, destLng, onProgress);
                outboundRoute = loop.outbound;
                returnRoute = loop.return;
                smartLoopData = loop;
            } else {
                onProgress('Building route…');
                const loop = await buildLoop(startLat, startLng, destLat, destLng);
                outboundRoute = loop.outbound;
                returnRoute = loop.return;
            }
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         outboundRoute, returnRoute, locInput, null, tripMode,
                         smartLoopData?.outboundVias, smartLoopData?.returnVias, smartLoopData?.roads);
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
        const visits = getVisits().filter(v => v.id !== currentSession.visitId);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
        currentSession.visitId = null;
        btn.classList.remove('marked');
        btn.textContent = 'Mark as visited';
        updateVisitedCounter();
        renderVisitedLayer();
        return;
    }

    const visit = {
        id: Date.now(),
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
        returnRouteDuration: currentSession.returnRouteDuration || null
    };

    const visits = getVisits();
    visits.push(visit);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
    currentSession.visitId = visit.id;

    btn.classList.add('marked');
    btn.textContent = 'Visited! (undo)';

    updateVisitedCounter();
    renderVisitedLayer();
}

// ─── Visited layer ────────────────────────────────────────────────────────────

function renderVisitedLayer() {
    visitedLayerGroup.clearLayers();
    for (const visit of getVisits()) {
        if (visit.routeCoords?.length > 0) {
            L.polyline(visit.routeCoords, {
                color: '#3b82f6', weight: 2, opacity: 0.35
            }).addTo(visitedLayerGroup);
        }
        if (visit.returnRouteCoords?.length > 0) {
            L.polyline(visit.returnRouteCoords, {
                color: '#f59e0b', weight: 2, opacity: 0.35
            }).addTo(visitedLayerGroup);
        }
        L.circleMarker([visit.startLat, visit.startLng], {
            radius: 5, color: '#7c3aed', fillColor: '#7c3aed', fillOpacity: 0.8, weight: 1
        })
        .bindPopup(`<b>${visit.startLabel}</b><br>${new Date(visit.date).toLocaleDateString()}`)
        .addTo(visitedLayerGroup);

        L.circleMarker([visit.destLat, visit.destLng], {
            radius: 5, color: '#0d9488', fillColor: '#0d9488', fillOpacity: 0.8, weight: 1
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
        favs.splice(idx, 1);
        btn.classList.remove('active');
    } else {
        favs.unshift({
            id: Date.now(),
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
        });
        btn.classList.add('active');
    }

    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
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
    favs.splice(index, 1);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
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
        let outboundRoute, returnRoute, smartLoopData = null;
        const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
        const useSmartRouting = document.getElementById('smartRouting').checked;
        if (m === 'one-way') {
            outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
            returnRoute = null;
        } else if (useSmartRouting) {
            const loop = await buildSmartLoop(startLat, startLng, destLat, destLng, onProgress);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
            smartLoopData = loop;
        } else {
            onProgress('Loading shared route…');
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }
        displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                     outboundRoute, returnRoute, s, n, m,
                     smartLoopData?.outboundVias, smartLoopData?.returnVias, smartLoopData?.roads);

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
    const allCoords = [
        ...(routeCoords || []),
        ...(returnRouteCoords || [])
    ];
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

    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-').toLowerCase() || 'route'}.gpx`;
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
        let outbound, ret, smartLoopData = null;
        const onProgress = msg => loadingEl.querySelector('p').textContent = msg;
        const useSmartRouting = document.getElementById('smartRouting').checked;
        if (tripMode === 'one-way') {
            outbound = await buildOneWay(startLat, startLng, destLat, destLng);
            ret = null;
        } else if (useSmartRouting) {
            const loop = await buildSmartLoop(startLat, startLng, destLat, destLng, onProgress, currentSession.cachedRoads || null);
            outbound = loop.outbound;
            ret = loop.return;
            smartLoopData = loop;
        } else {
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            outbound = loop.outbound;
            ret = loop.return;
        }

        // Redraw routes
        const allCoords = [];
        if (outbound) {
            const line = L.polyline(outbound.coords, {
                color: '#3b82f6', weight: 3, opacity: 0.85
            }).addTo(map);
            routeLines.push(line);
            allCoords.push(...outbound.coords);
        }
        if (ret) {
            const line = L.polyline(ret.coords, {
                color: '#f59e0b', weight: 3, opacity: 0.85
            }).addTo(map);
            routeLines.push(line);
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

        // Update directions link with new vias
        const newOutVias = smartLoopData?.outboundVias || null;
        const newRetVias = smartLoopData?.returnVias || null;
        document.getElementById('directionsLink').href =
            buildDirectionsUrl(startLat, startLng, destLat, destLng, tripMode, newOutVias, newRetVias);

        // Update session
        currentSession = {
            ...currentSession,
            distance: totalWalkKm,
            routeCoords:         outbound ? outbound.coords   : null,
            routeDuration:       outbound ? outbound.duration  : null,
            returnRouteCoords:   ret      ? ret.coords         : null,
            returnRouteDuration: ret      ? ret.duration       : null,
            outboundVias:        newOutVias,
            returnVias:          newRetVias,
            cachedRoads:         smartLoopData?.roads || currentSession.cachedRoads || null
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
        id: Date.now(),
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
    renderHistorySection();
}

function deleteHistoryEntry(index) {
    const history = getHistory();
    history.splice(index, 1);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
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
renderVisitedLayer();
updateVisitedCounter();
renderFavoritesSection();
renderHistorySection();
restoreFromHash();

// Update star button when location input changes
document.getElementById('location').addEventListener('input', updateSaveLocationBtn);
