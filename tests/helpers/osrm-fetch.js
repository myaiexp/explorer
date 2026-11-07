// OSRM response fixtures — GeoJSON route bodies and URL-echoing fetch handlers.
/**
 * Shared by every OSRM suite. They all mirror
 * the same two facts about the OSRM wire format, and those facts must change in
 * one place or one suite starts asserting against a fiction:
 *
 * - URL layout: the coordinate path follows `/foot/` and ends at `?`
 *   (`…/route/v1/foot/24,60;24.1,60.1?overview=full…`), `lng,lat` per pair.
 * - Body shape: `{ routes: [{ geometry: { coordinates: [[lng,lat]…] }, … }] }`
 *   for route, `{ waypoints: [{ location: [lng,lat] }] }` for nearest.
 *
 * The two fetch installers key on different things and are named for it:
 * installOsrmKindFetch here (URL path kind, shared by osrm.test.js and
 * the loop-builder suites) and osrm-fallback.test.js's local
 * installOsrmBackendFetch (self-hosted vs public base).
 */
import { vi } from 'vitest';
import { jsonResponse } from './fetch-stub.js';

export function routeBody(coordsLngLat, { duration = 60, distance = 1000, legs } = {}) {
    return {
        routes: [{
            geometry: { coordinates: coordsLngLat },
            duration,
            distance,
            legs,
        }],
    };
}

function coordPath(url) {
    return String(url).split('/foot/')[1].split('?')[0];
}

/** The `lng,lat;lng,lat…` path of a route URL, as `{lat, lng}` points. */
export function parseRouteWaypoints(url) {
    return coordPath(url).split(';').map((pair) => {
        const [lng, lat] = pair.split(',').map(Number);
        return { lat, lng };
    });
}

/** Nearest reply that snaps the query point onto itself. */
export function echoNearest(url) {
    const [lng, lat] = coordPath(url).split(',').map(Number);
    return jsonResponse({ waypoints: [{ location: [lng, lat] }] });
}

/** Route reply whose geometry is the requested waypoints, straight-lined. */
export function echoRoute(url) {
    const wps = parseRouteWaypoints(url);
    return jsonResponse(routeBody(wps.map((p) => [p.lng, p.lat])));
}

// Keyed on the endpoint KIND in the URL path (/table/, /nearest/, /route/,
// /junctions) — `overrides` replaces the default handler per kind. It never
// tells the self-hosted and public backends apart; osrm-fallback.test.js's
// installOsrmBackendFetch keys on the backend base instead. Installed via
// vi.stubGlobal, so the suite's afterEach calls vi.unstubAllGlobals().
export function installOsrmKindFetch(overrides = {}) {
    const handlers = {
        table: () => jsonResponse({ code: 'Ok', destinations: [{ distance: 0 }], distances: [[0]] }),
        nearest: echoNearest,
        route: echoRoute,
        junctions: () => jsonResponse({ junctions: [] }),
        ...overrides,
    };
    const fetch = vi.fn(async (url) => {
        const u = String(url);
        const kind = u.includes('/table/') ? 'table'
            : u.includes('/nearest/') ? 'nearest'
            : u.includes('/route/') ? 'route'
            : u.includes('/junctions') ? 'junctions'
            : null;
        if (!kind) throw new Error(`unexpected fetch: ${u}`);
        return handlers[kind](u);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
}
