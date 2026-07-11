// Shared geographic math — Haversine distance + km→degree projection.
// Loaded first — before fit-encoder/loop-quality/screening/bbox/novelty/app,
// all of which read its globalThis-exposed helpers. Pure module, no DOM.

// Haversine great-circle distance in km between (lat1, lng1) and (lat2, lng2).
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same distance in meters, same separate-args shape. Delegates to haversineKm
// so the two stay byte-identical (km × 1000) — never re-derive the formula.
function haversineM(lat1, lng1, lat2, lng2) {
    return haversineKm(lat1, lng1, lat2, lng2) * 1000;
}

// km→degree projection (the small-angle "111 km per degree" approximation) —
// the single named owner of a formula that was previously copied across
// overpass.js, osrm.js, and geometry.js. Latitude spacing is ~constant; a fix
// or precision change to the projection now happens in one place.

// Kilometres → degrees of latitude.
function kmToDegLat(km) {
    return km / 111;
}

// Kilometres → degrees of longitude at `lat`. Longitude spacing shrinks by
// cos(lat), so the same km-offset spans more degrees nearer the poles.
function kmToDegLng(km, lat) {
    return km / (111 * Math.cos(lat * Math.PI / 180));
}

// Overpass bbox string "minLat,minLng,maxLat,maxLng" for a square-ish box of
// half-extent `km` centred on (centerLat, centerLng). Used by every symmetric
// radius fetch so the corner math has exactly one source.
function bboxAround(centerLat, centerLng, km) {
    const latOffset = kmToDegLat(km);
    const lngOffset = kmToDegLng(km, centerLat);
    return `${centerLat - latOffset},${centerLng - lngOffset},${centerLat + latOffset},${centerLng + lngOffset}`;
}

globalThis.haversineKm = haversineKm;
globalThis.haversineM = haversineM;
globalThis.kmToDegLat = kmToDegLat;
globalThis.kmToDegLng = kmToDegLng;
globalThis.bboxAround = bboxAround;
