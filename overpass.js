// POI / road candidate pools, fetched from the server-side Overpass cache. No DOM.
// Loaded after net.js (for fetchWithTimeout) and before app.js; the fetchers
// take all inputs as params and return plain {lat,lng[,name]} arrays.
//
// Query assembly, the Overpass retry + status-slot loop, OSM element extraction
// and the annulus filter all used to live in this file. They now live in
// junctions-cache (src/overpass-pools.ts, src/lookups.ts, src/routes/pools.ts)
// behind POST /api/junctions/pois and POST /api/junctions/roads, so the browser
// receives a sampled pool of coordinates instead of the raw OSM elements: a
// 3.85 km road query was 5.2 MB / 14,043 elements over mobile data.
//
// The service takes catalog KEYS and preset NAMES, never Overpass filter
// strings — a client that could name a filter could inject a query against our
// own instance — which is why poi-types.js's `filter` values stay in the
// browser only to describe the dropdown.
//
// Start coordinates travel in the POST body, never the query string, so nginx
// access logs cannot persist a walker's home (#7559). Same rule as osrm.js's
// fetchCorridorJunctions.

// One request per pool now, not a 3-attempt client retry budget — the service
// owns the retries and the slot waiting. 60s matches the proxy_read_timeout in
// deploy/nginx-junctions.conf, which is the real ceiling on a cache miss that
// has to reach Overpass.
const POOL_TIMEOUT_MS = 60000;

// POST a pool request and hand back the raw candidate array.
//
// The reject-vs-empty distinction is load-bearing: resolveCandidatePool has
// separate branches (and separate progress messages) for "the lookup failed"
// and "the lookup found nothing". So every non-2xx — 400 bad body, 413 body too
// large, 502 upstream busy — throws, and a 200 resolves, even with an empty
// pool. A 200 whose body somehow carries no candidates array is read as an
// empty pool rather than an error: "nothing nearby, using a random point" is
// the better failure for a walker than no walk at all.
async function fetchCandidatePool(path, body) {
    const response = await fetchWithTimeout(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    }, POOL_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error('POI search is busy. Please try again.');
    }
    const data = await response.json();
    return Array.isArray(data.candidates) ? data.candidates : [];
}

// `types` is a catalog key, a list of keys, or the string 'all' (the "any POI"
// option — the server expands it to the whole catalog). A scalar key is wrapped
// here, which is why destination-resolve.js can pass poiType.key through as-is.
//
// `onProgress` no longer has anything to narrate — there is no client-side
// retry left — but stays in the positional shape every caller already passes.
async function fetchPOIsInRadius(startLat, startLng, minKm, maxKm, types, onProgress) { // eslint-disable-line no-unused-vars
    const selector = (types === 'all' || Array.isArray(types)) ? types : [types];
    const candidates = await fetchCandidatePool('/api/junctions/pois', {
        startLat, startLng, minKm, maxKm, types: selector,
    });
    // The wire OMITS `name` for an unnamed OSM element; this function's contract
    // has always been an explicit null (destination-resolve.js reads dest.name
    // straight into destName). Normalize rather than passing the array through.
    return candidates.map(c => ({ lat: c.lat, lng: c.lng, name: c.name || null }));
}

async function fetchRoadsInRadius(startLat, startLng, minKm, maxKm, onProgress, winterMode = false) { // eslint-disable-line no-unused-vars
    const candidates = await fetchCandidatePool('/api/junctions/roads', {
        startLat, startLng, minKm, maxKm,
        exclude: winterMode ? 'winter' : 'default',
    });
    return candidates.map(c => ({ lat: c.lat, lng: c.lng }));
}

// Explicit globalThis exports so the helpers load from non-script consumers
// (vm.runInThisContext in tests) as well as the browser's window.
globalThis.POOL_TIMEOUT_MS = POOL_TIMEOUT_MS;
globalThis.fetchCandidatePool = fetchCandidatePool;
globalThis.fetchPOIsInRadius = fetchPOIsInRadius;
globalThis.fetchRoadsInRadius = fetchRoadsInRadius;
