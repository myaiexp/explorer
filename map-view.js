// Leaflet map view layer — map init, the mutable Leaflet state, marker/route/
// circle drawing, the visited-routes overlay, and route-color persistence. Owns
// all mutable map state (markers, destMarker, circle, innerCircle, routeLines)
// so no other module reassigns it; app.js drives the map through the exported
// helpers. Reads getVisits (storage.js) and visitRenderParts (visit-shape.js) at
// call time. Loaded after Leaflet + storage.js + visit-shape.js, before app.js.

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

// Visited layer group (added visible; toggle visibility lives in app.js).
const visitedLayerGroup = L.layerGroup().addTo(map);

// ─── Mutable map state ───────────────────────────────────────────────────────

let markers = [];
let destMarker = null;  // ref to the destination pin so we can recolor on the fly
let circle = null;
let innerCircle = null;
let routeLines = [];  // all polylines for the loop

// ─── HTML escaping (popup content) ───────────────────────────────────────────

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

// ─── Marker icons ─────────────────────────────────────────────────────────────

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

// ─── Route polylines ──────────────────────────────────────────────────────────

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

// ─── Markers + radius circles ────────────────────────────────────────────────

// Add the "you are here" start dot with an escaped label popup; returns the marker.
function addStartMarker(lat, lng, label) {
    const m = L.marker([lat, lng], { icon: createHereDotIcon() })
        .addTo(map).bindPopup(`<b>Start</b><br>${escapeHtml(label)}`);
    markers.push(m);
    return m;
}

// Add the destination pin in the given color; kept as destMarker for live recolor.
function addDestMarker(lat, lng, color) {
    destMarker = L.marker([lat, lng], { icon: createPinIcon(color) })
        .addTo(map).bindPopup('<b>Destination</b><br>Turnaround point');
    markers.push(destMarker);
    return destMarker;
}

// Draw the outer (max) and inner (min) straight-radius circles when > 0.
function addRadiusCircles(lat, lng, straightMax, straightMin) {
    if (straightMax > 0) {
        circle = L.circle([lat, lng], {
            color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.08,
            radius: straightMax * 1000
        }).addTo(map);
    }
    if (straightMin > 0) {
        innerCircle = L.circle([lat, lng], {
            color: '#3b82f6', fillColor: 'transparent', fillOpacity: 0,
            weight: 1.5, opacity: 0.4, dashArray: '6, 4',
            radius: straightMin * 1000
        }).addTo(map);
    }
}

// ─── Clearing ─────────────────────────────────────────────────────────────────

function clearMap() {
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    destMarker = null;
    if (circle)      { map.removeLayer(circle);      circle = null; }
    if (innerCircle) { map.removeLayer(innerCircle); innerCircle = null; }
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
}

// Remove only the route polylines, keeping markers + circles — the spread
// reroute redraws routes over an unchanged start/dest/radius view.
function clearRouteLines() {
    routeLines.forEach(l => map.removeLayer(l));
    routeLines = [];
}

// ─── Visited layer ────────────────────────────────────────────────────────────

// Draw one visit's overlay pieces from the drawable parts visit-shape.js vetted.
function drawVisitParts(parts, color) {
    for (const coords of [parts.routeCoords, parts.returnRouteCoords]) {
        if (coords) {
            L.polyline(coords, { color, weight: 2, opacity: 0.4 }).addTo(visitedLayerGroup);
        }
    }

    // Start: hollow ring (matches "you are here" semantic but compact for overlay)
    L.circleMarker(parts.start, {
        radius: 4, color: '#3b82f6', fillColor: '#fff', fillOpacity: 1, weight: 2
    })
    .bindPopup(`<b>${escapeHtml(parts.startLabel)}</b><br>${parts.dateText}`)
    .addTo(visitedLayerGroup);

    // Destination: filled in route color (matches the active route's pin)
    L.circleMarker(parts.dest, {
        radius: 5, color, fillColor: color, fillOpacity: 0.85, weight: 1
    })
    .bindPopup(`${parts.distanceText}<br>${parts.dateText}`)
    .addTo(visitedLayerGroup);
}

function renderVisitedLayer() {
    visitedLayerGroup.clearLayers();
    const color = getRouteColor();
    let skipped = 0;
    for (const visit of getVisits()) {
        // Ask what is drawable rather than dereferencing fields: a stored row can
        // predate import validation, or have been merged down from an older cloud
        // backup. This loop is reached from app.js's top level, so an unguarded
        // throw on one bad row aborted the rest of init — on every page load, with
        // no in-app way to recover short of clearing localStorage by hand.
        const parts = visitRenderParts(visit);
        if (!parts) { skipped++; continue; }
        drawVisitParts(parts, color);
    }
    // Leave a trace: the overlay is silently short a walk, and the row is still in
    // storage, so the symptom would otherwise surface far from its cause.
    if (skipped > 0) {
        console.warn(`renderVisitedLayer: skipped ${skipped} unusable visit row(s)`);
    }
}

// ─── Route color application ──────────────────────────────────────────────────

// Apply the current routeColor to all live map layers without re-running OSRM.
function applyRouteColor() {
    const color = getRouteColor();
    routeLines.forEach(l => l.setStyle({ color }));
    if (destMarker) destMarker.setIcon(createPinIcon(color));
    renderVisitedLayer();
}

// ─── globalThis exports ───────────────────────────────────────────────────────
// map + visitedLayerGroup are consts read (never reassigned) by app.js; the
// mutable arrays/refs stay module-private and are driven via the helpers below.
globalThis.map = map;
globalThis.visitedLayerGroup = visitedLayerGroup;
globalThis.escapeHtml = escapeHtml;
globalThis.ROUTE_COLORS = ROUTE_COLORS;
globalThis.getRouteColor = getRouteColor;
globalThis.setRouteColor = setRouteColor;
globalThis.createPinIcon = createPinIcon;
globalThis.createHereDotIcon = createHereDotIcon;
globalThis.drawRouteGlow = drawRouteGlow;
globalThis.drawRoutePair = drawRoutePair;
globalThis.addStartMarker = addStartMarker;
globalThis.addDestMarker = addDestMarker;
globalThis.addRadiusCircles = addRadiusCircles;
globalThis.clearMap = clearMap;
globalThis.clearRouteLines = clearRouteLines;
globalThis.renderVisitedLayer = renderVisitedLayer;
globalThis.applyRouteColor = applyRouteColor;
