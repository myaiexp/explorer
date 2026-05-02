// Water-aware reachability filtering for destination candidates.
// Loaded after bbox.js / loop-quality.js / novelty.js, before app.js.
// Pure module, no DOM access. OSRM I/O is dependency-injected as a single
// `tableFn(start, candidates) → [{snapM, routeM} | null, ...]` so the caller
// can collapse Stage 1 (snap) and Stage 2 (detour) into one OSRM /table query.

const STAGE1_NEAREST_MAX_M = 500;
const STAGE2_DETOUR_MAX    = 2.2;
const RANDOM_POOL_SIZE     = 15;

function passesStage1(candidate, nearestResult) {
    if (!nearestResult) return false;
    return haversineM(
        [candidate.lat, candidate.lng],
        [nearestResult.lat, nearestResult.lng]
    ) <= STAGE1_NEAREST_MAX_M;
}

function detourRatio(routeMeters, straightKm) {
    if (!routeMeters || !straightKm) return Infinity;
    return (routeMeters / 1000) / straightKm;
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
            const straightKm = haversineM([start.lat, start.lng], [c.lat, c.lng]) / 1000;
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
    if (rejects.length > 0) {
        const withDetour = rejects.filter(s => s.detour !== null);
        let pick = null;
        if (withDetour.length > 0) {
            withDetour.sort((a, b) => a.detour - b.detour);
            pick = withDetour[0];
        } else {
            const withSnap = rejects.filter(s => s.snapM !== null);
            if (withSnap.length > 0) {
                withSnap.sort((a, b) => a.snapM - b.snapM);
                pick = withSnap[0];
            }
        }
        if (pick) {
            bestRejected = { ...pick.candidate, snapM: pick.snapM, detour: pick.detour };
        }
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
globalThis.RANDOM_POOL_SIZE     = RANDOM_POOL_SIZE;
globalThis.passesStage1   = passesStage1;
globalThis.detourRatio    = detourRatio;
globalThis.screenCandidates = screenCandidates;
