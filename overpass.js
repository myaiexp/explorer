// Overpass querying — raw interpreter calls plus POI / road fetchers. No DOM.
// Loaded after net.js (for fetchWithTimeout) and geometry.js (for
// calculateDistance) and before app.js; the fetchers take all inputs as params
// and return plain {lat,lng[,name]} arrays.

// Client-side timeouts. The interpreter query embeds its own server-side
// [timeout:N]; give the client a comfortable margin over that. The status probe
// is a tiny GET, so a short ceiling is plenty.
const OVERPASS_QUERY_TIMEOUT_MS  = 30000;
const OVERPASS_STATUS_TIMEOUT_MS = 5000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function queryOverpass(query, onProgress) {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            // Check status endpoint for actual wait time
            try {
                const status = await fetchWithTimeout('https://overpass-api.de/api/status', {}, OVERPASS_STATUS_TIMEOUT_MS).then(r => r.text());
                const match = status.match(/Slot available after: .+, in (\d+) seconds/);
                const waitSec = match ? Math.min(parseInt(match[1]) + 2, 60) : 15;
                if (onProgress) onProgress(`POI search is busy, retrying in ${waitSec}s…`);
                await sleep(waitSec * 1000);
            } catch {
                await sleep(15000);
            }
        }
        let response;
        try {
            response = await fetchWithTimeout('https://overpass-api.de/api/interpreter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'data=' + encodeURIComponent(query)
            }, OVERPASS_QUERY_TIMEOUT_MS);
        } catch {
            // Timeout / AbortError / network — retry like the junctions-cache twin
            // (it retries any non-4xx). HTTP 429/504 continue below; other HTTP
            // statuses fail immediately. An uncaught throw used to skip the rest
            // of the budget and surface as "empty Overpass → random fallback".
            continue;
        }
        if (response.ok) return response.json();
        if (response.status === 429 || response.status === 504) continue;
        throw new Error('Failed to fetch POI data. Please try again.');
    }
    throw new Error('POI search is busy. Please wait a moment and try again.');
}

async function fetchPOIsInRadius(centerLat, centerLng, minKm, maxKm, filter, onProgress) {
    const bbox = bboxAround(centerLat, centerLng, maxKm);
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

// TWIN: junctions-cache/src/overpass.ts carries the same HIGHWAY_EXCLUDE presets
// and the same status-parse + retry loop (see queryOverpass below). The two are
// deliberately independent — separate deployables (that ships to shelly, this
// serves as a raw static asset), so there is no build step to share a constant
// through. The exclude strings MUST stay byte-identical or the server-cached
// junctions stop matching what a direct frontend Overpass call would compute.
// tests/overpass-exclude-parity.test.js fails RED if these two copies drift.
const HIGHWAY_EXCLUDE_DEFAULT = 'motorway|motorway_link|trunk|trunk_link|service|steps';
const HIGHWAY_EXCLUDE_WINTER  = 'motorway|motorway_link|trunk|trunk_link|service|steps|path|track|footway|bridleway|cycleway|pedestrian';

async function fetchRoadsInRadius(centerLat, centerLng, minKm, maxKm, onProgress, winterMode = false) {
    const exclude = winterMode ? HIGHWAY_EXCLUDE_WINTER : HIGHWAY_EXCLUDE_DEFAULT;
    const bbox = bboxAround(centerLat, centerLng, maxKm);
    const query = `
        [out:json][timeout:15];
        way["highway"]["highway"!~"${exclude}"](${bbox});
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

// Explicit globalThis exports so the helpers load from non-script consumers
// (vm.runInThisContext in tests) as well as the browser's window.
globalThis.sleep = sleep;
globalThis.queryOverpass = queryOverpass;
globalThis.fetchPOIsInRadius = fetchPOIsInRadius;
globalThis.HIGHWAY_EXCLUDE_DEFAULT = HIGHWAY_EXCLUDE_DEFAULT;
globalThis.HIGHWAY_EXCLUDE_WINTER = HIGHWAY_EXCLUDE_WINTER;
globalThis.fetchRoadsInRadius = fetchRoadsInRadius;
