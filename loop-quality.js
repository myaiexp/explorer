// Loop-quality utilities for detecting degenerate round-trips.
// Loaded after bbox.js, before app.js.

// Default 25 m: tight enough to require both legs to truly share roads
// (sub-block separation passes), loose enough that GPS-jitter-style
// minor coordinate differences still register as overlap.
const OVERLAP_PROXIMITY_M = 25;

// 40% — chirality alone fixes most marginal cases; >0.4 means the legs
// are sharing nearly half their length, which is the lake-collapse signal.
const OVERLAP_BAD_THRESHOLD = 0.4;

// 3 candidates: deepest novel candidate is usually the best-shape POI
// in the area; if none of the top 3 work, area is structurally bad.
const MAX_RETRY_ATTEMPTS = 3;

// Haversine in meters between two [lat, lng] points (matching the
// existing app.js coord shape produced by tryOsrm).
function haversineM(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLng = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// For each p in `from`, count it as "near" if ANY q in `to` is within
// OVERLAP_PROXIMITY_M. Returns the fraction of near points. Naïve O(n*m) —
// coords are 100–500 points typically, fine without spatial indexing.
//
// Early-exit: the inner loop tracks `best` (running min) and breaks the
// moment `best < OVERLAP_PROXIMITY_M`. The metric is the BINARY "is p near
// anywhere in to?" — once we find ONE q within proximity the answer is yes
// and we can stop. Because `best` is monotonically decreasing, a break
// implies the post-loop check is true; no break implies no q within
// proximity was ever encountered.
function _directionalOverlap(fromCoords, toCoords) {
    if (!fromCoords || !toCoords || fromCoords.length === 0) return 0;
    let near = 0;
    for (const p of fromCoords) {
        let best = Infinity;
        for (const q of toCoords) {
            const d = haversineM(p, q);
            if (d < best) best = d;
            if (best < OVERLAP_PROXIMITY_M) break;
        }
        if (best < OVERLAP_PROXIMITY_M) near++;
    }
    return near / fromCoords.length;
}

// Symmetric overlap: max of A→B and B→A directional fractions.
// Returns 0 if either leg is empty/missing (degenerate input is treated
// as "no overlap detectable" — caller should already have null-checked).
function loopOverlapFraction(outboundCoords, returnCoords) {
    if (!outboundCoords?.length || !returnCoords?.length) return 0;
    const a = _directionalOverlap(outboundCoords, returnCoords);
    const b = _directionalOverlap(returnCoords, outboundCoords);
    return Math.max(a, b);
}

// Browser script tags hoist top-level function declarations to window
// automatically. Explicit globalThis assignment makes the helpers loadable
// from non-script consumers (e.g. vm.runInThisContext in tests).
globalThis.OVERLAP_PROXIMITY_M = OVERLAP_PROXIMITY_M;
globalThis.OVERLAP_BAD_THRESHOLD = OVERLAP_BAD_THRESHOLD;
globalThis.MAX_RETRY_ATTEMPTS = MAX_RETRY_ATTEMPTS;
globalThis.loopOverlapFraction = loopOverlapFraction;
