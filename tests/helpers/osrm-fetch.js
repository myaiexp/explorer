// OSRM response fixtures — GeoJSON route bodies and URL-echoing fetch handlers.
/**
 * Shared by osrm.test.js and osrm-fallback.test.js (finding #9780). Both mirror
 * the same two facts about the OSRM wire format, and those facts must change in
 * one place or one suite starts asserting against a fiction:
 *
 * - URL layout: the coordinate path follows `/foot/` and ends at `?`
 *   (`…/route/v1/foot/24,60;24.1,60.1?overview=full…`), `lng,lat` per pair.
 * - Body shape: `{ routes: [{ geometry: { coordinates: [[lng,lat]…] }, … }] }`
 *   for route, `{ waypoints: [{ location: [lng,lat] }] }` for nearest.
 *
 * The fetch installers stay local to each suite: they key on different things
 * (URL path kind vs self-hosted/public base) and are named for it.
 */
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
