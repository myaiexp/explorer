// Pure session/route data-shaping helpers — no DOM, no network. Map OSRM route
// results into the badge totals and the currentSession route fields, and stamp a
// currentSession into a persisted row (visit / favorite / history). Extracted
// from app.js so the field lists and one-way distance rules live in one place
// (and are testable in isolation). Loaded before app.js; used there as globals.

// UNITS — this file is the metres→kilometres boundary. An OSRM route object's
// `distance` is METRES (osrm.js maps it straight off the OSRM response); every
// session/persisted field below is KILOMETRES. Identifiers carry a Km/M suffix
// wherever the name is ours to choose; the un-suffixed `distance` /
// `routeDistance` / `returnRouteDistance` are fixed by the DB columns
// (server/src/schema.ts) and stay as-is. route-restore.js converts back.

// Per-leg + total walking distance/duration from an outbound/return route pair.
// A missing leg falls back to the straight-line distance — EXCEPT a one-way
// trip's (absent) return leg, which contributes 0 (there is no return). This is
// the correct rule; displayRoute previously inlined a copy that omitted the
// one-way guard and so double-counted one-way distances.
function computeRouteTotals(outbound, ret, straightKm, tripMode) {
    const outKm = outbound ? outbound.distance / 1000 : straightKm;
    const retKm = ret ? ret.distance / 1000 : (tripMode === 'one-way' ? 0 : straightKm);
    const totalWalkKm = outKm + retKm;
    const totalDuration = (outbound?.duration || 0) + (ret?.duration || 0);
    return { outKm, retKm, totalWalkKm, totalDuration };
}

// The eight route fields on currentSession, mapped from an outbound/return
// route pair. Shared by displayRoute and rerouteWithCurrentSpread so adding a
// route field (e.g. steps) is a one-line change in one place.
function routeSessionFields(outbound, ret) {
    return {
        routeCoords:         outbound ? outbound.coords         : null,
        routeDistance:       outbound ? outbound.distance / 1000 : null,
        routeDuration:       outbound ? outbound.duration        : null,
        routeSteps:          outbound ? outbound.steps           : null,
        returnRouteCoords:   ret      ? ret.coords               : null,
        returnRouteDistance: ret      ? ret.distance / 1000      : null,
        returnRouteDuration: ret      ? ret.duration             : null,
        returnRouteSteps:    ret      ? ret.steps                : null,
    };
}

// Stamp a currentSession into a persisted row: a fresh id + date plus the shared
// trip fields (with the same || null / ?? null normalization the three call
// sites used). Callers spread their extras on top — e.g. { poiCategory } for a
// visit. Route steps are intentionally omitted (only the live session needs
// them, for FIT export).
function snapshotSession(session, extra = {}) {
    return {
        id: crypto.randomUUID(),
        date: new Date().toISOString(),
        startLat:            session.startLat,
        startLng:            session.startLng,
        startLabel:          session.startLabel,
        destLat:             session.destLat,
        destLng:             session.destLng,
        destName:            session.destName || null,
        tripMode:            session.tripMode,
        distance:            session.distance,
        routeCoords:         session.routeCoords         || null,
        routeDistance:       session.routeDistance       ?? null,
        routeDuration:       session.routeDuration       || null,
        returnRouteCoords:   session.returnRouteCoords   || null,
        returnRouteDistance: session.returnRouteDistance ?? null,
        returnRouteDuration: session.returnRouteDuration || null,
        ...extra,
    };
}

globalThis.computeRouteTotals = computeRouteTotals;
globalThis.routeSessionFields = routeSessionFields;
globalThis.snapshotSession = snapshotSession;
