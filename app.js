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

// ─── POIs (Overpass) ─────────────────────────────────────────────────────────

async function fetchPOIsInRadius(centerLat, centerLng, minKm, maxKm, filter) {
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
    const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
    });
    if (!response.ok) throw new Error('Failed to fetch places. Please try again.');
    const data = await response.json();
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

async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm) {
    const latOffset = maxKm / 111;
    const lngOffset = maxKm / (111 * Math.cos(centerLat * Math.PI / 180));
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link|service|steps"](${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset});
        out center;
    `;
    const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
    });
    if (!response.ok) throw new Error('Failed to fetch roads. Please try again.');
    const data = await response.json();
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

const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';

let requestDelay = 300;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function adjustRequestDelay(delta) {
    requestDelay = Math.max(0, Math.min(2000, requestDelay + delta));
    document.getElementById('delayValue').textContent = requestDelay + 'ms';
}

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance} or null.
async function fetchRouteThrough(waypoints) {
    await sleep(requestDelay);
    try {
        const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
        const url = `${OSRM_BASE}/${coordStr}?overview=full&geometries=geojson`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.routes || data.routes.length === 0) return null;
        const r = data.routes[0];
        return {
            coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
            duration: r.duration,
            distance: r.distance
        };
    } catch { return null; }
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

    const outbound = await fetchRouteThrough([A, ...viasRight, B]);
    const ret      = await fetchRouteThrough([B, ...viasLeftReturn, A]);
    return { outbound, return: ret };
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
}

// ─── Display route results on map ────────────────────────────────────────────

function displayRoute(startLat, startLng, destLat, destLng, straightMax, straightMin,
                      outboundRoute, returnRoute, locationInput, destName, tripMode) {
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
        `https://www.google.com/maps/dir/?api=1&origin=${startLat},${startLng}&destination=${destLat},${destLng}&travelmode=walking`;
    document.getElementById('mapsLink').href =
        `https://www.google.com/maps/search/?api=1&query=${destLat},${destLng}`;
    document.getElementById('streetViewLink').href =
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${destLat},${destLng}`;

    document.getElementById('resultPanel').classList.add('active');

    currentSession = {
        startLat, startLng, startLabel: locationInput,
        destLat, destLng, destName: destName || null,
        tripMode: tripMode || 'round',
        distance: totalWalkKm,
        routeCoords:         outboundRoute ? outboundRoute.coords   : null,
        routeDuration:       outboundRoute ? outboundRoute.duration  : null,
        returnRouteCoords:   returnRoute   ? returnRoute.coords      : null,
        returnRouteDuration: returnRoute   ? returnRoute.duration    : null
    };

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

        if (locationType === 'roads') {
            loadingEl.querySelector('p').textContent = 'Searching for roads in the area…';
            const roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax);
            if (roads.length === 0) throw new Error('No roads found in this range. Try adjusting the distance.');
            dest = pickMostNovelDestination(roads, existingDests);
        } else if (locationType === 'any_poi') {
            loadingEl.querySelector('p').textContent = 'Searching for any POI…';
            const allFilters = POI_TYPES.map(p => p.filter);
            const pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax, allFilters);
            if (pois.length === 0) throw new Error('No POIs found in this range. Try a larger distance.');
            dest = pickMostNovelDestination(pois, existingDests);
            destName = dest.name;
        } else if (locationType === 'poi') {
            const poiDef = POI_TYPES.find(p => p.key === locationTypeVal);
            if (!poiDef) throw new Error('Please select a place type.');
            loadingEl.querySelector('p').textContent = `Searching for ${poiDef.label}s…`;
            const pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax, poiDef.filter);
            if (pois.length === 0) throw new Error(`No ${poiDef.label} found in this range. Try a larger distance.`);
            dest = pickMostNovelDestination(pois, existingDests);
            destName = dest.name;
        } else {
            const candidates = Array.from({ length: 5 }, () =>
                generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
            dest = pickMostNovelDestination(candidates, existingDests);
        }

        // Build route
        let outboundRoute, returnRoute;
        if (tripMode === 'one-way') {
            loadingEl.querySelector('p').textContent = 'Building route…';
            outboundRoute = await buildOneWay(startLat, startLng, dest.lat, dest.lng);
            returnRoute = null;
        } else {
            loadingEl.querySelector('p').textContent = 'Building round-trip loop…';
            const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }

        displayRoute(startLat, startLng, dest.lat, dest.lng,
                     straightMax, straightMin, outboundRoute, returnRoute, locationInput, destName, tripMode);

    } catch (error) {
        showError(error.message || 'An error occurred. Please try again.');
    } finally {
        loadingEl.classList.remove('active');
        loadingEl.querySelector('p').textContent = 'Finding your random destination…';
        btn.disabled = false;
    }
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
            let outboundRoute, returnRoute;
            if (tripMode === 'one-way') {
                loadingEl.querySelector('p').textContent = 'Building route…';
                outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
                returnRoute = null;
            } else {
                loadingEl.querySelector('p').textContent = 'Building round-trip loop…';
                const loop = await buildLoop(startLat, startLng, destLat, destLng);
                outboundRoute = loop.outbound;
                returnRoute = loop.return;
            }
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         outboundRoute, returnRoute, locInput, null, tripMode);
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
        let outboundRoute, returnRoute;
        if (m === 'one-way') {
            outboundRoute = await buildOneWay(startLat, startLng, destLat, destLng);
            returnRoute = null;
        } else {
            const loop = await buildLoop(startLat, startLng, destLat, destLng);
            outboundRoute = loop.outbound;
            returnRoute = loop.return;
        }
        displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                     outboundRoute, returnRoute, s, n, m);

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
        let outbound, ret;
        if (tripMode === 'one-way') {
            outbound = await buildOneWay(startLat, startLng, destLat, destLng);
            ret = null;
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

        // Update session
        currentSession = {
            ...currentSession,
            distance: totalWalkKm,
            routeCoords:         outbound ? outbound.coords   : null,
            routeDuration:       outbound ? outbound.duration  : null,
            returnRouteCoords:   ret      ? ret.coords         : null,
            returnRouteDuration: ret      ? ret.duration       : null
        };
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
renderHistorySection();
restoreFromHash();

// Update star button when location input changes
document.getElementById('location').addEventListener('input', updateSaveLocationBtn);
