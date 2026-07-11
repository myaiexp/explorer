// Pure geometry helpers — distance, bearings, envelope vias, random points,
// spread-slider mapping. No DOM, no network. Loaded after geo-utils.js (for
// haversineKm + kmToDegLat) and before the overpass/osrm/app scripts that consume these.

// Haversine great-circle distance in km — canonical impl lives in geo-utils.js
// (shared with novelty.js); geo-utils.js loads before this file per index.html.
const calculateDistance = globalThis.haversineKm;

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
    const envelope = kmToDegLat(Math.sin(Math.PI * t) * maxOffsetKm);
    const lat = lat0 + envelope * Math.cos(perpBrng);
    const lng = lng0 + envelope * Math.sin(perpBrng) / Math.cos(lat0 * Math.PI / 180);
    return { lat, lng };
}

// A uniformly random point in the annulus [minKm, maxKm] around a center.
function generateRandomPointAnnulus(centerLat, centerLng, minKm, maxKm) {
    const minDeg = kmToDegLat(minKm);
    const maxDeg = kmToDegLat(maxKm);
    const r = Math.sqrt(Math.random() * (maxDeg ** 2 - minDeg ** 2) + minDeg ** 2);
    const theta = Math.random() * 2 * Math.PI;
    const latOffset = r * Math.cos(theta);
    const lngOffset = r * Math.sin(theta) / Math.cos(centerLat * Math.PI / 180);
    return { lat: centerLat + latOffset, lng: centerLng + lngOffset };
}

// Map a spread-slider value (0-100) to a continuous offset multiplier. Pure —
// no DOM — so the routing layer can be exercised in isolation. Always uses 3
// via points at fixed t positions for consistent loop shape; the slider only
// changes HOW FAR the vias are pushed sideways.
//   0% → offsetMult ~0.03 (nearly straight, barely any loop)
// 50% → offsetMult ~0.15 (gentle oval, default)
// 100% → offsetMult ~0.40 (wide exploratory loop)
function computeSpreadParams(sliderValue) {
    const raw = Number.isFinite(sliderValue) ? sliderValue : 50;
    const pct = raw / 100;
    // Quadratic curve: gentle changes near middle, steeper at extremes
    const offsetMult = 0.03 + pct * pct * 0.37;
    return { offsetMult, viaTs: [0.25, 0.5, 0.75] };
}

// Browser script tags hoist top-level function declarations to window; explicit
// globalThis assignment also makes these loadable from non-script consumers
// (e.g. vm.runInThisContext in tests).
globalThis.calculateDistance = calculateDistance;
globalThis.bearingRad = bearingRad;
globalThis.envelopeOffsetPoint = envelopeOffsetPoint;
globalThis.generateRandomPointAnnulus = generateRandomPointAnnulus;
globalThis.computeSpreadParams = computeSpreadParams;
