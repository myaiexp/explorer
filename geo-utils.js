// Shared geographic math — canonical Haversine great-circle distance.
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

globalThis.haversineKm = haversineKm;
globalThis.haversineM = haversineM;
