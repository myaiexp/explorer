// Pure session/route data-shaping helpers — no DOM, no network. Map OSRM route
// results into the badge totals and the currentSession route fields, and stamp a
// currentSession into a persisted row (visit / favorite / history). Extracted
// from app.js so the field lists and one-way distance rules live in one place
// (and are testable in isolation). Loaded before app.js.

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
//
// `estimated` reports whether that substitution happened, so a caller never has
// to re-derive it (idea #3807). It is true when any leg the trip mode expects is
// missing, and it says two things about the numbers: totalWalkKm is part
// crow-flies guess, and totalDuration counts ONLY the legs that routed — a round
// trip with a failed return under-reports the walk time by roughly half. Neither
// may be presented or persisted as measured.
function computeRouteTotals(outbound, ret, straightKm, tripMode) {
    const outKm = outbound ? outbound.distance / 1000 : straightKm;
    const retKm = ret ? ret.distance / 1000 : (tripMode === 'one-way' ? 0 : straightKm);
    const totalWalkKm = outKm + retKm;
    const totalDuration = (outbound?.duration || 0) + (ret?.duration || 0);
    const estimated = !outbound || (tripMode !== 'one-way' && !ret);
    return { outKm, retKm, totalWalkKm, totalDuration, estimated };
}

// Is this leg pair a walk that was actually routed, end to end? The one owner of
// the persist rule for history / favorites / the cloud backup: a round trip
// needs BOTH legs, a one-way only its outbound. Anything less has a fabricated
// distance inside its total (see computeRouteTotals), and the persisted row
// stores that as plain measured km with nothing marking it.
//
// Coords, not truthiness: a truthy leg with empty coords is a failed route in a
// route object's clothing (finding #7926) and drew nothing on the map either.
// computeRouteTotals deliberately stays on truthiness — restoreResult hands it a
// zero-distance, coord-less return stub to mean "measured, contributes nothing".
function isMeasuredWalk(outbound, ret, tripMode) {
    if (!outbound?.coords?.length) return false;
    if (tripMode !== 'one-way' && !ret?.coords?.length) return false;
    return true;
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
globalThis.isMeasuredWalk = isMeasuredWalk;
globalThis.routeSessionFields = routeSessionFields;
globalThis.snapshotSession = snapshotSession;
