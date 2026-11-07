// Pure geometry helpers — bearings, envelope vias, random points, spread-slider
// mapping. No DOM, no network. Loaded after geo-utils.js (for haversineKm +
// kmToDegLat) and before the osrm/route-view scripts that consume these. Distance is
// haversineKm from geo-utils.js — this file does not re-alias it.

function bearingRad(lat1, lng1, lat2, lng2) {
    const toRad = Math.PI / 180;
    const dLng = (lng2 - lng1) * toRad;
    const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
              Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
    return Math.atan2(y, x);
}

// Point at fraction t along A→B, offset perpendicular by a sin-envelope.
// Peaks at t=0.5 (midpoint), zero at t=0 and t=1 (endpoints).
function envelopeOffsetPoint(aLat, aLng, bLat, bLng, t, maxOffsetKm, side) {
    const lat0 = aLat + t * (bLat - aLat);
    const lng0 = aLng + t * (bLng - aLng);
    const brng = bearingRad(aLat, aLng, bLat, bLng);
    const perpBrng = brng + side * (Math.PI / 2);
    const envelope = kmToDegLat(Math.sin(Math.PI * t) * maxOffsetKm);
    const lat = lat0 + envelope * Math.cos(perpBrng);
    const lng = lng0 + envelope * Math.sin(perpBrng) / Math.cos(lat0 * Math.PI / 180);
    return { lat, lng };
}

// A uniformly random point in the annulus [minKm, maxKm] around a center.
function generateRandomPointAnnulus(centerLat, centerLng, minKm, maxKm) {
    const minDeg = kmToDegLat(minKm);
    const maxDeg = kmToDegLat(maxKm);
    const r = Math.sqrt(Math.random() * (maxDeg ** 2 - minDeg ** 2) + minDeg ** 2);
    const theta = Math.random() * 2 * Math.PI;
    const latOffset = r * Math.cos(theta);
    const lngOffset = r * Math.sin(theta) / Math.cos(centerLat * Math.PI / 180);
    return { lat: centerLat + latOffset, lng: centerLng + lngOffset };
}

// Map a spread-slider value (0-100) to a continuous offset multiplier. Pure —
// no DOM — so the routing layer can be exercised in isolation. Always uses 3
// via points at fixed t positions for consistent loop shape; the slider only
// changes HOW FAR the vias are pushed sideways.
//   0% → offsetMult ~0.03 (nearly straight, barely any loop)
// 50% → offsetMult ~0.15 (gentle oval, default)
// 100% → offsetMult ~0.40 (wide exploratory loop)
function computeSpreadParams(sliderValue) {
    const raw = Number.isFinite(sliderValue) ? sliderValue : 50;
    const pct = raw / 100;
    // Quadratic curve: gentle changes near middle, steeper at extremes
    const offsetMult = 0.03 + pct * pct * 0.37;
    return { offsetMult, viaTs: [0.25, 0.5, 0.75] };
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

// Shared geometry for loop-builders.js's two loop builders. Derives the per-side offset, the
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
// points, shared by loop-builders.js's two builders and buildDirectionsUrl
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

// Browser script tags hoist top-level function declarations to window; explicit
// globalThis assignment also makes these loadable from non-script consumers
// (vm.compileFunction in tests/helpers/load.js).
globalThis.bearingRad = bearingRad;
globalThis.envelopeOffsetPoint = envelopeOffsetPoint;
globalThis.generateRandomPointAnnulus = generateRandomPointAnnulus;
globalThis.computeSpreadParams = computeSpreadParams;
globalThis.MIN_LOOP_OFFSET_KM = MIN_LOOP_OFFSET_KM;
globalThis.SNAP_FRACTION_OF_OFFSET = SNAP_FRACTION_OF_OFFSET;
globalThis.buildLoopSetup = buildLoopSetup;
globalThis.loopVias = loopVias;
