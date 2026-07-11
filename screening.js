// Water-aware reachability filtering for destination candidates.
// Dependencies (globalThis): haversineM — the canonical Haversine from
// geo-utils.js; partialShuffle — the shared Fisher-Yates swap loop from
// novelty.js. Both must load before this file (index.html order: geo-utils →
// novelty → screening). No other cross-file globals are read.
// Pure module, no DOM access. OSRM I/O is dependency-injected as a single
// `tableFn(start, candidates) → [{snapM, routeM} | null, ...]` so the caller
// can collapse Stage 1 (snap) and Stage 2 (detour) into one OSRM /table query.

const STAGE1_NEAREST_MAX_M = 500;
const STAGE2_DETOUR_MAX    = 2.2;
const SCREENING_POOL_CAP   = 45;   // bound parallel OSRM fan-out for Overpass pools

// Randomly down-sample a candidate pool to SCREENING_POOL_CAP entries.
// Fisher-Yates partial shuffle on a copy — input array is not mutated.
// Returns the input untouched if it's already at or below the cap.
function capPool(candidates) {
    if (!candidates || candidates.length <= SCREENING_POOL_CAP) return candidates;
    const copy = globalThis.partialShuffle(candidates.slice(), SCREENING_POOL_CAP);
    return copy.slice(0, SCREENING_POOL_CAP);
}

// Detour penalty = routed km / straight-line km. Returns Infinity when either
// input is missing or zero: a 0-metre route (start == destination) or a 0-km
// straight distance is a degenerate route, and Infinity > STAGE2_DETOUR_MAX
// guarantees such a candidate is rejected at Stage 2 downstream.
function detourRatio(routeMeters, straightKm) {
    if (!routeMeters || !straightKm) return Infinity;
    return (routeMeters / 1000) / straightKm;
}

// Element with the smallest numeric `key`, or null if the array is empty.
// Ties resolve to the earliest element (strict `<` keeps the first seen).
function minBy(arr, key) {
    let best = null;
    for (const el of arr) {
        if (best === null || el[key] < best[key]) best = el;
    }
    return best;
}

async function screenCandidates(start, candidates, { tableFn }) {
    if (!candidates || candidates.length === 0) {
        return { survivors: [], bestRejected: null, diagnostics: [] };
    }

    // Single OSRM /table call replaces the old N nearest + N route calls.
    // tableFn must return an array aligned with `candidates`; each entry is
    // `{snapM, routeM}` (numbers or null) or `null` if the row could not be
    // resolved at all. A throw here lets the caller fall back to unscreened.
    const table = await tableFn(start, candidates);
    if (!Array.isArray(table) || table.length !== candidates.length) {
        throw new Error('tableFn returned malformed result');
    }

    const states = candidates.map((c, i) => {
        const t = table[i] ?? {};
        const snapM = (typeof t.snapM === 'number' && isFinite(t.snapM)) ? t.snapM : null;
        const routeM = (typeof t.routeM === 'number' && isFinite(t.routeM)) ? t.routeM : null;
        const stage1Ok = snapM !== null && snapM <= STAGE1_NEAREST_MAX_M;

        let stage = null, reason = null, detour = null;
        if (!stage1Ok) {
            stage = 'stage1-reject';
            reason = snapM === null ? 'nearest-failed' : 'snap-too-far';
        } else if (routeM === null) {
            stage = 'stage2-reject';
            reason = 'route-failed';
        } else {
            const straightKm = globalThis.haversineM(start.lat, start.lng, c.lat, c.lng) / 1000;
            const d = detourRatio(routeM, straightKm);
            detour = isFinite(d) ? d : null;
            if (detour !== null && detour <= STAGE2_DETOUR_MAX) {
                stage = 'survived';
            } else {
                stage = 'stage2-reject';
                reason = 'detour-too-high';
            }
        }
        return { candidate: c, snapM, detour, stage, reason };
    });

    // Survivors are shallow-copied so adding screening annotations does not
    // leak back onto the caller's input objects (tests verify this in the
    // all-pass scenario). Original input order is preserved.
    const survivors = [];
    for (const s of states) {
        if (s.stage === 'survived') {
            survivors.push({ ...s.candidate, snapM: s.snapM, detour: s.detour });
        }
    }

    // bestRejected: prefer the lowest-detour reject if Stage 2 ran for any
    // candidate; otherwise fall back to the smallest-snapM reject. Shallow-
    // copied so annotations don't leak onto caller inputs.
    let bestRejected = null;
    const rejects = states.filter(s => s.stage !== 'survived');
    // Two-tier fallback: lowest-detour reject (Stage 2 ran), else smallest-snapM
    // reject (Stage 1 only). `??` keeps the second minBy from running when the
    // first tier has a pick.
    const pick = minBy(rejects.filter(s => s.detour !== null), 'detour')
              ?? minBy(rejects.filter(s => s.snapM !== null), 'snapM');
    if (pick) {
        bestRejected = { ...pick.candidate, snapM: pick.snapM, detour: pick.detour };
    }

    const diagnostics = states.map(s => ({
        candidate: s.candidate,
        stage: s.stage,
        reason: s.reason,
        snapM: s.snapM,
        detour: s.detour,
    }));

    return { survivors, bestRejected, diagnostics };
}

globalThis.STAGE1_NEAREST_MAX_M = STAGE1_NEAREST_MAX_M;
globalThis.STAGE2_DETOUR_MAX    = STAGE2_DETOUR_MAX;
globalThis.SCREENING_POOL_CAP   = SCREENING_POOL_CAP;
globalThis.capPool        = capPool;
globalThis.detourRatio    = detourRatio;
globalThis.screenCandidates = screenCandidates;
