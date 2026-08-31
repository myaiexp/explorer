// OSRM routing + loop building — self-hosted OSRM-foot wrappers (route / nearest
// / table), road/junction snapping, and the envelope/junction loop builders.
// No DOM: callers pass a precomputed `spread`. Loaded after net.js (for
// fetchWithTimeout), geometry.js (for envelopeOffsetPoint),
// geo-utils.js (haversineKm / kmToDegLat) and loop-quality.js (loopOverlapFraction),
// before route-dispatch.js + app.js.

// Self-hosted OSRM-foot for Finland.
const OSRM_FI_BASE    = 'https://mase.fi/api/osrm-fi/route/v1/foot';
const OSRM_FI_NEAREST = 'https://mase.fi/api/osrm-fi/nearest/v1/foot';
const OSRM_FI_TABLE   = 'https://mase.fi/api/osrm-fi/table/v1/foot';

// Public fallback while shelly (self-hosted) is down. FOSSGIS's routing.openstreetmap.de
// is a free community service under a ~1 req/sec fair-use cap — every request
// here MUST go through throttlePublic below so the pacing can't be bypassed.
const OSRM_PUBLIC_BASE    = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const OSRM_PUBLIC_NEAREST = 'https://routing.openstreetmap.de/routed-foot/nearest/v1/foot';
const OSRM_PUBLIC_TABLE   = 'https://routing.openstreetmap.de/routed-foot/table/v1/foot';

// How long a self-hosted failure keeps us off shelly before we probe it again.
const SELF_HOSTED_RETRY_MS = 5 * 60 * 1000;
// Minimum spacing between consecutive requests to the public fallback.
const PUBLIC_MIN_GAP_MS = 1100;

// osrm.js has no sleep of its own (overpass.js's isn't in this file's
// SCRIPT_DEPS), so a tiny local one backs the public-fallback throttle.
// NOT named `sleep`: these are classic scripts sharing one global scope, and
// osrm.js loads after overpass.js — a second top-level `function sleep` would
// redefine the global and hand overpass.js's retry backoff this function
// instead of its own. Identical today, a silent bug the day either diverges.
function throttleSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ── Self-hosted-down latch + public-fallback throttle ──────────────────────
//
// Module-scoped mutable state. This is safe because withLoading (loading.js)
// is a one-build-at-a-time mutex: the entry points that can trigger a route
// build (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) all go
// through it, so at most one build — and therefore at most one chain of OSRM
// calls — is ever in flight. There is no concurrent build to race this state
// against.
let selfHostedDownUntil = 0;   // Date.now() ms; 0 means "not latched"
let publicQueue = Promise.resolve(); // serializes every public request
let lastPublicRequestAt = 0;

// True while we're skipping self-hosted OSRM entirely and going straight to
// the public fallback.
function isSelfHostedDown() {
    return Date.now() < selfHostedDownUntil;
}

// Latch self-hosted as down for SELF_HOSTED_RETRY_MS. Called whenever a
// self-hosted request throws (timeout/network) or resolves non-ok — never
// for a self-hosted 200 that simply has no route, which is a property of
// the destination, not the backend.
function markSelfHostedDown() {
    selfHostedDownUntil = Date.now() + SELF_HOSTED_RETRY_MS;
}

// Test seam: clears the latch and the throttle queue so tests don't leak
// module state into each other (osrm.js is loaded once per test file).
function resetOsrmFallbackState() {
    selfHostedDownUntil = 0;
    publicQueue = Promise.resolve();
    lastPublicRequestAt = 0;
}

// Run `fn` (a public-fallback fetch) after waiting for both (a) every
// previously-queued public request to finish and (b) at least
// PUBLIC_MIN_GAP_MS since the last one actually started. This is the only
// path any caller has to OSRM_PUBLIC_* — composing those URLs and fetching
// them directly instead would bypass the fair-use pacing.
function throttlePublic(fn) {
    const run = publicQueue.then(async () => {
        const wait = lastPublicRequestAt + PUBLIC_MIN_GAP_MS - Date.now();
        if (wait > 0) await throttleSleep(wait);
        lastPublicRequestAt = Date.now();
        return fn();
    });
    // Keep the queue alive even if this attempt rejects, so a later request
    // still waits its turn instead of the queue wedging on a rejected promise.
    publicQueue = run.then(() => {}, () => {});
    return run;
}

// Pure: turns a parsed OSRM /route response into our route shape, or null if
// there's no usable route. Never throws — a malformed-but-parseable body
// (missing routes/geometry) is a business outcome, not a fetch failure.
function parseRouteResponse(data) {
    if (!data.routes || data.routes.length === 0) return null;
    const r = data.routes[0];
    const coords = r.geometry && r.geometry.coordinates;
    // Missing or empty geometry is a failed route, not a 0-length walk (#7785 #7926).
    if (!Array.isArray(coords) || coords.length === 0) return null;
    const steps = r.legs ? r.legs.flatMap(leg => leg.steps || []) : null;
    // UNITS: `distance` is METRES and `duration` seconds, straight off OSRM.
    // Every route object this module returns keeps those units; session.js is
    // the boundary that converts distance to km for the session/persisted
    // fields, and route-restore.js converts back.
    return {
        coords: coords.map(([lng, lat]) => [lat, lng]),
        duration: r.duration,
        distance: r.distance,
        steps: steps
    };
}

// Public-fallback attempt for /route. Always throttled; returns null on any
// failure (network, non-ok, or no usable route) — there's nowhere further to
// fall back to.
async function tryOsrmPublic(suffix) {
    return throttlePublic(async () => {
        try {
            const res = await fetchWithTimeout(`${OSRM_PUBLIC_BASE}/${suffix}`);
            if (!res.ok) return null;
            const data = await res.json();
            return parseRouteResponse(data);
        } catch { return null; }
    });
}

// Internal: fetch + parse OSRM /route response. `suffix` is the path+query
// AFTER the /route/v1/foot/ base — this function (not the caller) decides
// which base to compose it onto, which is what makes the public fallback
// invisible to every caller. Returns the parsed route, or null.
async function tryOsrm(suffix) {
    if (!isSelfHostedDown()) {
        try {
            const res = await fetchWithTimeout(`${OSRM_FI_BASE}/${suffix}`);
            if (!res.ok) throw new Error(`osrm http ${res.status}`);
            const data = await res.json();
            return parseRouteResponse(data);
        } catch {
            // Self-hosted is unreachable or erroring — latch and retry the
            // exact same request on the public fallback. A 200 with no
            // usable route never reaches here (parseRouteResponse returns
            // null without throwing), so it doesn't latch.
            markSelfHostedDown();
            return tryOsrmPublic(suffix);
        }
    }
    return tryOsrmPublic(suffix);
}

// Route through an ordered list of {lat,lng} waypoints. Returns {coords, duration, distance, steps} or null.
async function fetchRouteThrough(waypoints) {
    const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
    const query = `${coordStr}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
    return tryOsrm(query);
}

// Pure: turns a parsed OSRM /nearest response into {lat,lng}, or null.
function parseNearestResponse(data) {
    if (!data.waypoints || !data.waypoints.length) return null;
    return { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
}

async function tryNearestPublic(suffix) {
    return throttlePublic(async () => {
        try {
            const res = await fetchWithTimeout(`${OSRM_PUBLIC_NEAREST}/${suffix}`);
            if (!res.ok) return null;
            const data = await res.json();
            return parseNearestResponse(data);
        } catch { return null; }
    });
}

// Internal: OSRM /nearest call. `suffix` is the path+query after
// /nearest/v1/foot/. Returns {lat, lng} or null on any failure.
async function tryNearest(suffix) {
    if (!isSelfHostedDown()) {
        try {
            const res = await fetchWithTimeout(`${OSRM_FI_NEAREST}/${suffix}`);
            if (!res.ok) throw new Error(`osrm nearest http ${res.status}`);
            const data = await res.json();
            return parseNearestResponse(data);
        } catch {
            markSelfHostedDown();
            return tryNearestPublic(suffix);
        }
    }
    return tryNearestPublic(suffix);
}

// Snap a geometric via to the nearest road point within snapRadius km.
// Returns the snapped point, or the original if snapping fails or is too far.
async function snapToRoad(via, snapRadius = 0.5) {
    const snapped = await tryNearest(`${via.lng},${via.lat}?number=1`);
    if (!snapped) return via;
    const dist = haversineKm(via.lat, via.lng, snapped.lat, snapped.lng);
    return dist <= snapRadius ? snapped : via;
}

// Adapter for screenCandidates' tableFn contract: one OSRM /table call
// returns snap distance + route distance for every candidate at once,
// replacing N parallel /nearest + N parallel /route calls.
//
// `destinations[i].distance` is OSRM's snap distance for input coord i;
// `distances[0][i]` is the route distance from source[0] to coord i.
// Both arrays include source[0] at index 0, so candidate i lives at i+1.
//
// Same self-hosted → public fallback as tryOsrm/tryNearest, but this one
// keeps throwing if the public attempt also fails: screenCandidates
// (screening.js) has no try/catch around its tableFn call — the catch lives
// one level up, in destination-resolve.js — so swallowing to null here would
// hide a total OSRM outage as "no candidates survived screening".
async function screeningTableFn(start, candidates) {
    if (candidates.length === 0) return [];
    const coords = [
        `${start.lng},${start.lat}`,
        ...candidates.map(c => `${c.lng},${c.lat}`)
    ].join(';');
    const suffix = `${coords}?sources=0&annotations=distance`;

    const attempt = async (base) => {
        const res = await fetchWithTimeout(`${base}/${suffix}`);
        if (!res.ok) throw new Error(`osrm table http ${res.status}`);
        const data = await res.json();
        if (data.code !== 'Ok') throw new Error(`osrm table ${data.code}`);
        const dests = data.destinations;
        const dists = data.distances && data.distances[0];
        if (!Array.isArray(dests) || !Array.isArray(dists)) {
            throw new Error('osrm table malformed');
        }
        return candidates.map((_, i) => {
            const d = dests[i + 1];
            const r = dists[i + 1];
            const snapM = d && typeof d.distance === 'number' ? d.distance : null;
            const routeM = typeof r === 'number' ? r : null;
            return { snapM, routeM };
        });
    };

    if (!isSelfHostedDown()) {
        try {
            return await attempt(OSRM_FI_TABLE);
        } catch {
            markSelfHostedDown();
            return throttlePublic(() => attempt(OSRM_PUBLIC_TABLE));
        }
    }
    return throttlePublic(() => attempt(OSRM_PUBLIC_TABLE));
}

// ── Loop envelope constants ────────────────────────────────────────────────
//
// The legacy pair. offsetKm is floored at 100 m while the snap radius is
// floored at 300 m — so for every trip under ~2.5 km at the default spread the
// snap radius is WIDER than the envelope, and a via meant to sit 150 m off-axis
// can be dragged 300 m to reach a junction, back across the A→B line. Measured
// on real Jämsä destinations (2026-08-31, live OSRM): 44–83% leg overlap at the
// bottom of the spread slider, with each leg detouring off-corridor to touch
// its via and returning — the dead-end spurs. Kept as the avoidBacktracking:false
// behaviour so the toggle has something to compare against.
const LEGACY_LOOP_OFFSET_KM = 0.1;
const LEGACY_SNAP_FLOOR_KM  = 0.3;

// The avoidBacktracking pair. MIN is ADDED to the spread-scaled offset rather
// than max()'d with it: a flat floor would swallow the bottom half of the
// slider (0% and 25% already produce byte-identical routes today), whereas
// adding keeps the slider live across its whole range with 300 m as the
// narrowest loop. 300 m is where the measured overlap collapses — it is roughly
// the block spacing, i.e. the width at which OSRM stops having to reuse the
// outbound streets for the return leg.
const MIN_LOOP_OFFSET_KM = 0.3;
// A snap may never move a via further than the envelope pushed it out, or the
// snap undoes the loop it was placed to create. Half the offset leaves room to
// reach a junction while keeping the via on its own side of the A→B line.
const SNAP_FRACTION_OF_OFFSET = 0.5;

// Shared geometry for the two loop builders. Derives the per-side offset, the
// A/B endpoints, the via t-positions, and the snap radius from start/dest + the
// spread params. `avoidBacktracking` selects between the two constant pairs
// above — it widens the envelope and ties the snap radius to it, instead of the
// legacy flat 300 m floor that could exceed the envelope entirely. Pure — no DOM.
function buildLoopSetup(startLat, startLng, destLat, destLng, spread, { avoidBacktracking = false } = {}) {
    const straightKm = haversineKm(startLat, startLng, destLat, destLng);
    // spread is required. Production always passes getSpreadParams(), which itself
    // defaults NaN/undefined slider values to the 50% params — so the graceful
    // fallback already lives at the source. A missing spread here is a caller bug:
    // destructure it directly so it throws loudly instead of silently substituting
    // a spread the user never picked.
    const { offsetMult, viaTs } = spread;
    const scaled = straightKm * offsetMult;
    const offsetKm = avoidBacktracking
        ? MIN_LOOP_OFFSET_KM + scaled
        : Math.max(LEGACY_LOOP_OFFSET_KM, scaled);
    return {
        offsetKm,
        viaTs,
        A: { lat: startLat, lng: startLng },
        B: { lat: destLat,  lng: destLng },
        snapRadius: avoidBacktracking
            ? offsetKm * SNAP_FRACTION_OF_OFFSET
            : Math.max(LEGACY_SNAP_FLOOR_KM, offsetKm * 0.5),
    };
}

// Pure loop envelope geometry — the single source for the sin-envelope via
// points, shared by both loop builders here and buildDirectionsUrl
// (which draws the Google Maps link along the same oval). Built on
// buildLoopSetup so the offset formula lives in exactly one place.
// rightVias/leftVias are in forward (A→B) t-order; a leg that walks a side back
// toward A reverses that side at the call site (self-documenting). Spreads the
// setup fields (A, B, snapRadius, offsetKm, viaTs) so callers don't re-derive
// them. `opts` carries avoidBacktracking straight through to buildLoopSetup —
// route-view.js's buildDirectionsUrl passes it too, so the Google Maps link
// traces the same oval the in-app route does. Pure — no DOM, no network.
function loopVias(startLat, startLng, destLat, destLng, spread, opts = {}) {
    const setup = buildLoopSetup(startLat, startLng, destLat, destLng, spread, opts);
    const { offsetKm, viaTs } = setup;
    const rightVias = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, -1));
    const leftVias = viaTs.map(t =>
        envelopeOffsetPoint(startLat, startLng, destLat, destLng, t, offsetKm, +1));
    return { rightVias, leftVias, ...setup };
}

// Build a full oval loop: A → (right vias) → B → (left vias) → A.
// Returns { outbound, return } where each is {coords, duration, distance} or null.
// Builds a single chirality (right-side out, left-side back); buildJunctionLoop
// is the variant that tries both chiralities and picks the lower-overlap one.
// `spread` is the precomputed { offsetMult, viaTs } from computeSpreadParams.
// `degraded` (Layer 2 of the shelly-down pipeline reduction, see osrm-fallback
// tests) skips the /nearest snap entirely and routes through the raw geometric
// vias as-is — while we're already paced onto the public fallback (Layer 1),
// cutting 6 nearest calls down to 0 is a pure work reduction; it never affects
// whether we're allowed to make a request, only how many we make.
async function buildLoop(startLat, startLng, destLat, destLng, spread, { degraded = false, avoidBacktracking = false } = {}) {
    const { rightVias, leftVias, A, B, snapRadius } =
        loopVias(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });

    // The return leg walks the left side back toward A, so reverse it up front —
    // both branches below need it in that order.
    const reversedLeft = leftVias.slice().reverse();

    let snappedRight, snappedLeft;
    if (degraded) {
        snappedRight = rightVias;
        snappedLeft = reversedLeft;
    } else {
        // Snap all 6 vias to nearest roads in parallel (threshold: half the
        // offset distance).
        const allVias = [...rightVias, ...reversedLeft];
        const snapped = await Promise.all(allVias.map(v => snapToRoad(v, snapRadius)));
        snappedRight = snapped.slice(0, 3);
        snappedLeft = snapped.slice(3);
    }

    const outbound = await fetchRouteThrough([A, ...snappedRight, B]);
    const ret      = await fetchRouteThrough([B, ...snappedLeft, A]);
    return { outbound, return: ret };
}

// Fetch OSM junctions in the start/dest corridor via the shelly cache
// (mase.fi/api/junctions). Start/radius go in the POST body — never the
// query string — so nginx access logs cannot persist home coords (#7559).
// maxKm is the caller's budget (passed in, never read from the DOM) so
// the cache key matches the radius the caller works in.
async function fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, maxKm, onProgress, winterMode = false) {
    const minLat = Math.min(startLat, destLat);
    const maxLat = Math.max(startLat, destLat);
    const minLng = Math.min(startLng, destLng);
    const maxLng = Math.max(startLng, destLng);
    const midLat = (minLat + maxLat) / 2;
    const latPad = kmToDegLat(offsetKm);
    const lngPad = kmToDegLng(offsetKm, midLat);
    const bbox = `${minLat - latPad},${minLng - lngPad},${maxLat + latPad},${maxLng + lngPad}`;
    const exclude = winterMode ? 'winter' : 'default';
    const body = { bbox, exclude };
    if (Number.isFinite(maxKm) && maxKm > 0) {
        body.startLat = startLat;
        body.startLng = startLng;
        body.maxKm = maxKm;
    }
    if (onProgress) onProgress('Searching for junctions…');
    const response = await fetchWithTimeout('/api/junctions/junctions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error('POI search is busy. Please try again.');
    }
    const data = await response.json();
    return data.junctions || [];
}

// Find the closest junction in the pool to `via` within snapRadius km.
// Returns the junction, or the original `via` if no junction is in range.
function snapToJunction(via, junctionPool, snapRadius) {
    if (!junctionPool || junctionPool.length === 0) return via;
    let best = null, bestDist = Infinity;
    for (const j of junctionPool) {
        const d = haversineKm(via.lat, via.lng, j.lat, j.lng);
        if (d < bestDist) { bestDist = d; best = j; }
    }
    return bestDist <= snapRadius ? best : via;
}

// Pick lower-overlap of two candidate (outbound, return) pairs. Falls back
// gracefully if one chirality fully failed. Used by buildJunctionLoop's
// both-chirality success path.
function pickBetterLoop(outA, retA, outB, retB) {
    const aOk = outA && retA;
    const bOk = outB && retB;
    if (aOk && bOk) {
        const ovA = loopOverlapFraction(outA.coords, retA.coords);
        const ovB = loopOverlapFraction(outB.coords, retB.coords);
        return ovA <= ovB
            ? { outbound: outA, return: retA, overlap: ovA }
            : { outbound: outB, return: retB, overlap: ovB };
    }
    if (aOk) {
        const ovA = loopOverlapFraction(outA.coords, retA.coords);
        return { outbound: outA, return: retA, overlap: ovA };
    }
    if (bOk) {
        const ovB = loopOverlapFraction(outB.coords, retB.coords);
        return { outbound: outB, return: retB, overlap: ovB };
    }
    return { outbound: null, return: null, overlap: null };
}

// Junction-snap variant of buildLoop: same envelope vias, same snap radius,
// but snaps each via to the closest OSM junction in a corridor pool instead
// of OSRM nearest-snap. Builds both chiralities in parallel and returns the
// lower-overlap one. Falls back to buildLoop on Overpass/OSRM failure.
// The four lat/lng leaders stay positional; the rest is a named-options object:
//   maxKm            the caller's max-distance budget — forwarded to
//                    fetchCorridorJunctions for the start-anchored cache key
//   onProgress       msg => void progress callback
//   cachedJunctions  a previously returned `junctions` pool to skip Overpass
//   winterMode       excludes winter-unmaintained ways from the junction fetch
//   spread           precomputed { offsetMult, viaTs } from computeSpreadParams
//   avoidBacktracking  widens the envelope and keeps the junction snap inside
//                    it (see the loop envelope constants). Forwarded to every
//                    loopVias/buildLoop call below — including BOTH fallbacks,
//                    or a failed junction fetch would silently hand the user the
//                    legacy geometry the toggle exists to replace.
async function buildJunctionLoop(startLat, startLng, destLat, destLng, {
    maxKm, onProgress = () => {}, cachedJunctions = null, winterMode = false, spread = undefined,
    avoidBacktracking = false,
} = {}) {
    // Forward-order vias on each side (loopVias owns the envelope geometry).
    // Reversal happens at call time on the leg that needs it (return leg).
    const { rightVias: viasRight, leftVias: viasLeft, offsetKm, A, B, snapRadius } =
        loopVias(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });

    let junctions = cachedJunctions;
    if (!junctions) {
        try {
            // Only the Overpass fetch — a missing onProgress must not look like a network miss.
            junctions = await fetchCorridorJunctions(startLat, startLng, destLat, destLng, offsetKm, maxKm, onProgress, winterMode);
        } catch {
            const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });
            return { outbound: loop.outbound, return: loop.return, overlap: null, junctions: null };
        }
    }

    const snappedRight = viasRight.map(v => snapToJunction(v, junctions, snapRadius));
    const snappedLeft  = viasLeft .map(v => snapToJunction(v, junctions, snapRadius));

    onProgress('Building both chiralities…');
    const [outA, retA, outB, retB] = await Promise.all([
        fetchRouteThrough([A, ...snappedRight, B]),
        fetchRouteThrough([B, ...snappedLeft.slice().reverse(), A]),
        fetchRouteThrough([A, ...snappedLeft, B]),
        fetchRouteThrough([B, ...snappedRight.slice().reverse(), A]),
    ]);
    const picked = pickBetterLoop(outA, retA, outB, retB);
    if (!picked.outbound || !picked.return) {
        const loop = await buildLoop(startLat, startLng, destLat, destLng, spread, { avoidBacktracking });
        return { outbound: loop.outbound, return: loop.return, overlap: null, junctions };
    }
    return { ...picked, junctions };
}

// Build a single routed leg A → B. Returns {coords, duration, distance} or null.
async function buildOneWay(startLat, startLng, destLat, destLng) {
    return fetchRouteThrough([
        { lat: startLat, lng: startLng },
        { lat: destLat,  lng: destLng }
    ]);
}

// Explicit globalThis exports. route-dispatch.js resolves buildOneWay /
// buildJunctionLoop / buildLoop from the global scope at call time.
globalThis.OSRM_FI_BASE = OSRM_FI_BASE;
globalThis.OSRM_FI_NEAREST = OSRM_FI_NEAREST;
globalThis.OSRM_FI_TABLE = OSRM_FI_TABLE;
globalThis.OSRM_PUBLIC_BASE = OSRM_PUBLIC_BASE;
globalThis.OSRM_PUBLIC_NEAREST = OSRM_PUBLIC_NEAREST;
globalThis.OSRM_PUBLIC_TABLE = OSRM_PUBLIC_TABLE;
globalThis.SELF_HOSTED_RETRY_MS = SELF_HOSTED_RETRY_MS;
globalThis.PUBLIC_MIN_GAP_MS = PUBLIC_MIN_GAP_MS;
globalThis.MIN_LOOP_OFFSET_KM = MIN_LOOP_OFFSET_KM;
globalThis.SNAP_FRACTION_OF_OFFSET = SNAP_FRACTION_OF_OFFSET;
globalThis.isSelfHostedDown = isSelfHostedDown;
globalThis.resetOsrmFallbackState = resetOsrmFallbackState;
globalThis.tryOsrm = tryOsrm;
globalThis.fetchRouteThrough = fetchRouteThrough;
globalThis.tryNearest = tryNearest;
globalThis.snapToRoad = snapToRoad;
globalThis.screeningTableFn = screeningTableFn;
globalThis.buildLoopSetup = buildLoopSetup;
globalThis.loopVias = loopVias;
globalThis.buildLoop = buildLoop;
globalThis.fetchCorridorJunctions = fetchCorridorJunctions;
globalThis.snapToJunction = snapToJunction;
globalThis.pickBetterLoop = pickBetterLoop;
globalThis.buildJunctionLoop = buildJunctionLoop;
globalThis.buildOneWay = buildOneWay;
