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

function getVisits() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
        return [];
    }
}

// ─── Map helpers ─────────────────────────────────────────────────────────────

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
    btn.textContent = '⏳ Getting location…';
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            document.getElementById('location').value =
                `${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}`;
            btn.disabled = false;
            btn.textContent = '📍 Use My Location';
        },
        (err) => {
            showError('Could not get your location: ' + err.message);
            btn.disabled = false;
            btn.textContent = '📍 Use My Location';
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

function getAllExistingRoutePoints() {
    const visits = getVisits();
    const points = [];
    for (const visit of visits) {
        for (const key of ['routeCoords', 'returnRouteCoords']) {
            const coords = visit[key];
            if (!coords) continue;
            const step = Math.max(1, Math.floor(coords.length / 15));
            for (let i = 0; i < coords.length; i += step) points.push(coords[i]);
        }
    }
    return points;
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

function scoreRouteOverlap(routeCoords, existingPoints) {
    if (!existingPoints || existingPoints.length === 0) return 0;
    const THRESHOLD = 0.03;
    const step = Math.max(1, Math.floor(routeCoords.length / 50));
    const sample = routeCoords.filter((_, i) => i % step === 0);
    let overlapping = 0;
    for (const [lat, lng] of sample) {
        for (const [eLat, eLng] of existingPoints) {
            if (calculateDistance(lat, lng, eLat, eLng) < THRESHOLD) { overlapping++; break; }
        }
    }
    return overlapping / sample.length;
}

// ─── Roads (Overpass) ────────────────────────────────────────────────────────

async function fetchRoadsInRadius(centerLat, centerLng, maxKm) {
    const latOffset = maxKm / 111;
    const lngOffset = maxKm / (111 * Math.cos(centerLat * Math.PI / 180));
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"motorway|motorway_link|trunk|trunk_link"](${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset});
        out geom;
    `;
    const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
    });
    if (!response.ok) throw new Error('Failed to fetch roads. Please try again.');
    const data = await response.json();
    const roads = [];
    for (const el of data.elements) {
        if (el.type === 'way' && el.geometry) {
            for (const pt of el.geometry) {
                if (calculateDistance(centerLat, centerLng, pt.lat, pt.lon) <= maxKm) {
                    roads.push(el); break;
                }
            }
        }
    }
    return roads;
}

function getRandomPointOnRoadWithRange(roads, centerLat, centerLng, minKm, maxKm, existingDests) {
    if (!roads || roads.length === 0) return null;
    const eligible = [];
    for (const road of roads) {
        if (!road.geometry) continue;
        for (const pt of road.geometry) {
            const dist = calculateDistance(centerLat, centerLng, pt.lat, pt.lon);
            if (dist >= minKm && dist <= maxKm) eligible.push({ lat: pt.lat, lng: pt.lon });
        }
    }
    if (eligible.length === 0) return null;
    if (!existingDests || existingDests.length === 0) {
        return eligible[Math.floor(Math.random() * eligible.length)];
    }
    const SAMPLE = 200;
    let pool = eligible;
    if (eligible.length > SAMPLE) {
        const step = Math.floor(eligible.length / SAMPLE);
        pool = eligible.filter((_, i) => i % step === 0);
    }
    const scored = pool.map(pt => {
        const minDist = existingDests.reduce((min, [eLat, eLng]) =>
            Math.min(min, calculateDistance(pt.lat, pt.lng, eLat, eLng)), Infinity);
        return { ...pt, minDist };
    });
    scored.sort((a, b) => b.minDist - a.minDist);
    const topN = Math.max(1, Math.ceil(scored.length * 0.3));
    const top = scored.slice(0, topN);
    return top[Math.floor(Math.random() * top.length)];
}

// ─── OSRM routing ─────────────────────────────────────────────────────────────

const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance} or null.
async function fetchRouteThrough(waypoints) {
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

async function buildLoop(startLat, startLng, destLat, destLng, existingPoints) {
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

    // Chirality 1: outbound right, return left
    const outbound1 = await fetchRouteThrough([A, ...viasRight, B]);
    const return1   = await fetchRouteThrough([B, ...viasLeftReturn, A]);

    if (!existingPoints || existingPoints.length === 0) {
        return { outbound: outbound1, return: return1 };
    }

    // Chirality 2: outbound left, return right
    const viasLeftOutbound = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
    const viasRightReturn = viaTs.slice().reverse().map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));

    const outbound2 = await fetchRouteThrough([A, ...viasLeftOutbound, B]);
    const return2   = await fetchRouteThrough([B, ...viasRightReturn,  A]);

    const score1 = (outbound1 ? scoreRouteOverlap(outbound1.coords, existingPoints) : 1) +
                   (return1   ? scoreRouteOverlap(return1.coords,   existingPoints) : 1);
    const score2 = (outbound2 ? scoreRouteOverlap(outbound2.coords, existingPoints) : 1) +
                   (return2   ? scoreRouteOverlap(return2.coords,   existingPoints) : 1);

    if (score2 < score1 && outbound2 && return2) {
        return { outbound: outbound2, return: return2 };
    }
    return { outbound: outbound1, return: return1 };
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
    el.style.color = '#065f46';
    el.style.background = '#d1fae5';
    el.classList.add('active');
    setTimeout(() => {
        el.classList.remove('active');
        el.style.color = '';
        el.style.background = '';
    }, 4000);
}

function resetMarkVisitedBtn() {
    const btn = document.getElementById('markVisitedBtn');
    btn.classList.remove('marked');
    btn.disabled = false;
    btn.textContent = '✓ Mark as Visited';
}

// ─── Display route results on map ────────────────────────────────────────────

function displayRoute(startLat, startLng, destLat, destLng, straightMax, straightMin,
                      outboundRoute, returnRoute, locationInput) {
    // Markers
    const startMarker = L.marker([startLat, startLng])
        .addTo(map).bindPopup('<b>Start</b><br>' + locationInput);
    markers.push(startMarker);

    const destMarker = L.marker([destLat, destLng])
        .addTo(map).bindPopup('<b>Destination</b><br>Turnaround point');
    markers.push(destMarker);

    // Radius circles
    if (straightMax > 0) {
        circle = L.circle([startLat, startLng], {
            color: '#667eea', fillColor: '#667eea', fillOpacity: 0.08,
            radius: straightMax * 1000
        }).addTo(map);
    }
    if (straightMin > 0) {
        innerCircle = L.circle([startLat, startLng], {
            color: '#667eea', fillColor: 'transparent', fillOpacity: 0,
            weight: 1.5, opacity: 0.4, dashArray: '6, 4',
            radius: straightMin * 1000
        }).addTo(map);
    }

    // Route polylines — single continuous green line
    const allCoords = [];
    if (outboundRoute) {
        const line = L.polyline(outboundRoute.coords, {
            color: '#10b981', weight: 3, opacity: 0.85
        }).addTo(map);
        routeLines.push(line);
        allCoords.push(...outboundRoute.coords);
    }
    if (returnRoute) {
        const line = L.polyline(returnRoute.coords, {
            color: '#10b981', weight: 3, opacity: 0.85
        }).addTo(map);
        routeLines.push(line);
        allCoords.push(...returnRoute.coords);
    }

    // Fallback: dashed straight line if no routes at all
    if (!outboundRoute && !returnRoute) {
        const line = L.polyline([[startLat, startLng], [destLat, destLng]], {
            color: '#764ba2', weight: 3, opacity: 0.7, dashArray: '10, 10'
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

    document.getElementById('destCoords').textContent =
        `${destLat.toFixed(6)}, ${destLng.toFixed(6)}`;
    document.getElementById('distanceBadge').textContent =
        `📏 ${totalWalkKm.toFixed(1)} km round trip`;

    const walkBadgeEl = document.getElementById('walkBadge');
    if (totalDuration > 0) {
        walkBadgeEl.textContent = `🚶 ~${Math.round(totalDuration / 60)} min`;
        walkBadgeEl.style.display = 'inline-block';
    } else {
        walkBadgeEl.style.display = 'none';
    }

    document.getElementById('mapsLink').href =
        `https://www.google.com/maps/search/?api=1&query=${destLat},${destLng}`;
    document.getElementById('streetViewLink').href =
        `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${destLat},${destLng}`;

    document.getElementById('resultPanel').classList.add('active');

    currentSession = {
        startLat, startLng, startLabel: locationInput,
        destLat, destLng,
        distance: totalWalkKm,
        routeCoords:         outboundRoute ? outboundRoute.coords   : null,
        routeDuration:       outboundRoute ? outboundRoute.duration  : null,
        returnRouteCoords:   returnRoute   ? returnRoute.coords      : null,
        returnRouteDuration: returnRoute   ? returnRoute.duration    : null
    };
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
        const existingPoints = getAllExistingRoutePoints();

        const locationType = document.querySelector('input[name="locationType"]:checked').value;

        // Distance inputs are round-trip walking distance.
        // Empirically, straight-line ≈ budget / 2.6 produces loops close to the target.
        const straightMin = minKm / 2.6;
        const straightMax = maxKm / 2.6;
        let dest;

        if (locationType === 'roads') {
            loadingEl.querySelector('p').textContent = 'Searching for roads in the area…';
            const roads = await fetchRoadsInRadius(startLat, startLng, straightMax);
            if (roads.length === 0) throw new Error('No roads found within the radius. Try increasing the distance.');
            dest = getRandomPointOnRoadWithRange(roads, startLat, startLng, straightMin, straightMax, existingDests);
            if (!dest) throw new Error('Could not find a road point in range. Try adjusting min/max distance.');
        } else {
            const candidates = Array.from({ length: 5 }, () =>
                generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
            dest = pickMostNovelDestination(candidates, existingDests);
        }

        // Build oval loop
        loadingEl.querySelector('p').textContent = 'Building round-trip loop…';
        const loop = await buildLoop(startLat, startLng, dest.lat, dest.lng, existingPoints);

        displayRoute(startLat, startLng, dest.lat, dest.lng,
                     straightMax, straightMin, loop.outbound, loop.return, locationInput);

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
    btn.textContent = '✕ Cancel';
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
            const existingPoints = getAllExistingRoutePoints();

            loadingEl.querySelector('p').textContent = 'Building round-trip loop…';
            const loop = await buildLoop(startLat, startLng, destLat, destLng, existingPoints);
            displayRoute(startLat, startLng, destLat, destLng, 0, 0,
                         loop.outbound, loop.return, locInput);
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
    btn.textContent = '📌 Pick destination on map';
    map.getContainer().style.cursor = '';
    if (pickHandler) {
        map.off('click', pickHandler);
        pickHandler = null;
    }
}

// ─── Mark as Visited ─────────────────────────────────────────────────────────

function markAsVisited() {
    if (!currentSession) return;

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

    const btn = document.getElementById('markVisitedBtn');
    btn.classList.add('marked');
    btn.disabled = true;
    btn.textContent = '✅ Visited!';

    updateVisitedCounter();
    renderVisitedLayer();
}

// ─── Visited layer ────────────────────────────────────────────────────────────

function renderVisitedLayer() {
    visitedLayerGroup.clearLayers();
    for (const visit of getVisits()) {
        if (visit.routeCoords?.length > 0) {
            L.polyline(visit.routeCoords, {
                color: '#10b981', weight: 2, opacity: 0.45
            }).addTo(visitedLayerGroup);
        }
        if (visit.returnRouteCoords?.length > 0) {
            L.polyline(visit.returnRouteCoords, {
                color: '#10b981', weight: 2, opacity: 0.45
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
        btn.classList.remove('active');
    } else {
        visitedLayerGroup.addTo(map);
        visitedLayerVisible = true;
        btn.classList.add('active');
    }
}

// ─── Visited counter ──────────────────────────────────────────────────────────

function updateVisitedCounter() {
    const count = getVisits().length;
    const places = count === 1 ? 'place' : 'places';
    document.getElementById('visitedCount').textContent = `${count} ${places} visited`;

    const exploredEl = document.getElementById('exploredCount');
    if (count > 0) {
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

        const existingPoints = getAllExistingRoutePoints();
        const loop = await buildLoop(startLat, startLng, destLat, destLng, existingPoints);

        // Redraw routes
        const allCoords = [];
        if (loop.outbound) {
            const line = L.polyline(loop.outbound.coords, {
                color: '#10b981', weight: 3, opacity: 0.85
            }).addTo(map);
            routeLines.push(line);
            allCoords.push(...loop.outbound.coords);
        }
        if (loop.return) {
            const line = L.polyline(loop.return.coords, {
                color: '#10b981', weight: 3, opacity: 0.85
            }).addTo(map);
            routeLines.push(line);
            allCoords.push(...loop.return.coords);
        }
        if (allCoords.length > 0) {
            map.fitBounds(L.latLngBounds(allCoords).pad(0.15));
        }

        // Update badges
        const straightDist = calculateDistance(startLat, startLng, destLat, destLng);
        const outDist = loop.outbound ? loop.outbound.distance / 1000 : straightDist;
        const retDist = loop.return   ? loop.return.distance   / 1000 : straightDist;
        const totalWalkKm = outDist + retDist;
        const totalDuration = (loop.outbound?.duration || 0) + (loop.return?.duration || 0);

        document.getElementById('distanceBadge').textContent =
            `📏 ${totalWalkKm.toFixed(1)} km round trip`;
        const walkBadgeEl = document.getElementById('walkBadge');
        if (totalDuration > 0) {
            walkBadgeEl.textContent = `🚶 ~${Math.round(totalDuration / 60)} min`;
            walkBadgeEl.style.display = 'inline-block';
        } else {
            walkBadgeEl.style.display = 'none';
        }

        // Update session
        currentSession = {
            ...currentSession,
            distance: totalWalkKm,
            routeCoords:         loop.outbound ? loop.outbound.coords   : null,
            routeDuration:       loop.outbound ? loop.outbound.duration  : null,
            returnRouteCoords:   loop.return   ? loop.return.coords      : null,
            returnRouteDuration: loop.return   ? loop.return.duration    : null
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

// ─── Init ─────────────────────────────────────────────────────────────────────

renderVisitedLayer();
updateVisitedCounter();
