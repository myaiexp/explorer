// Finland bbox helpers for routing endpoint selection.
// Loaded before app.js.

const FINLAND_BBOX = { minLng: 19.0, maxLng: 32.0, minLat: 59.0, maxLat: 71.0 };

// Loose bbox covering Finnish territory + Åland. Generous on edges so border
// routes (Tornio, Utsjoki) stay on self-hosted; OSM data coverage is the real
// filter — out-of-data queries fall back automatically.
function inFinland(lat, lng) {
    return lat >= FINLAND_BBOX.minLat && lat <= FINLAND_BBOX.maxLat
        && lng >= FINLAND_BBOX.minLng && lng <= FINLAND_BBOX.maxLng;
}

// Browser script tags hoist top-level function declarations to window
// automatically. Explicit globalThis assignment makes the helpers loadable
// from non-script consumers (e.g. vm.runInThisContext in tests).
globalThis.FINLAND_BBOX = FINLAND_BBOX;
globalThis.inFinland = inFinland;
