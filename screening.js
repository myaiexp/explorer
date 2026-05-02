// Water-aware reachability filtering for destination candidates.
// Loaded after bbox.js / loop-quality.js / novelty.js, before app.js.
// Pure module, no DOM access. OSRM I/O is dependency-injected.

const STAGE1_NEAREST_MAX_M = 500;
const STAGE2_DETOUR_MAX    = 2.2;
const RANDOM_POOL_SIZE     = 15;

// haversineM (from loop-quality.js, on globalThis) takes [lat, lng] arrays —
// not {lat, lng} objects. Adapter centralizes the conversion.
function _snapMeters(candidate, nearestResult) {
    return haversineM(
        [candidate.lat, candidate.lng],
        [nearestResult.lat, nearestResult.lng]
    );
}

function passesStage1(candidate, nearestResult) {
    if (!nearestResult) return false;
    return _snapMeters(candidate, nearestResult) <= STAGE1_NEAREST_MAX_M;
}

function detourRatio(routeMeters, straightKm) {
    if (!routeMeters || !straightKm) return Infinity;
    return (routeMeters / 1000) / straightKm;
}

async function screenCandidates(start, candidates, { nearestFn, routeFn }) {
    if (!candidates || candidates.length === 0) {
        return { survivors: [], bestRejected: null, diagnostics: [] };
    }

    // Stage 1: snap each candidate to the foot graph. A null/throw from
    // nearestFn → treated as a stage 1 reject (snap unknown, safe to skip).
    const nearestResults = await Promise.all(
        candidates.map(c => nearestFn(c).catch(() => null))
    );

    const states = candidates.map((c, i) => {
        const nr = nearestResults[i];
        let snapM = null;
        let stage1Ok = false;
        if (nr) {
            snapM = _snapMeters(c, nr);
            stage1Ok = snapM <= STAGE1_NEAREST_MAX_M;
        }
        return {
            candidate: c,
            snapM,
            detour: null,
            stage1Ok,
            stage: stage1Ok ? null : 'stage1-reject',
            reason: stage1Ok ? null : (nr ? 'snap-too-far' : 'nearest-failed'),
        };
    });

    // Stage 2: route from start to each stage-1 survivor. A null/throw from
    // routeFn → stage 2 reject (detour unknown, safe to skip).
    const stage2Indices = [];
    states.forEach((s, i) => { if (s.stage1Ok) stage2Indices.push(i); });
    const stage2Routes = await Promise.all(
        stage2Indices.map(i => routeFn(start, candidates[i]).catch(() => null))
    );

    for (let k = 0; k < stage2Indices.length; k++) {
        const i = stage2Indices[k];
        const route = stage2Routes[k];
        const c = candidates[i];
        const straightKm = haversineM([start.lat, start.lng], [c.lat, c.lng]) / 1000;
        const detour = route ? detourRatio(route.distance, straightKm) : Infinity;
        states[i].detour = isFinite(detour) ? detour : null;
        if (route && isFinite(detour) && detour <= STAGE2_DETOUR_MAX) {
            states[i].stage = 'survived';
            states[i].reason = null;
        } else {
            states[i].stage = 'stage2-reject';
            states[i].reason = route ? 'detour-too-high' : 'route-failed';
        }
    }

    // Survivors are shallow-copied so adding screening annotations does not
    // leak back onto the caller's input objects (tests verify this in the
    // all-pass scenario). Original input order is preserved.
    const survivors = [];
    for (const s of states) {
        if (s.stage === 'survived') {
            survivors.push({ ...s.candidate, snapM: s.snapM, detour: s.detour });
        }
    }

    // bestRejected: prefer the lowest-detour reject if stage 2 ran for any
    // candidate (the rejects with computed detour); otherwise fall back to
    // the smallest-snapM reject. Annotated in place so the caller can use
    // the same object identity (and read its existing fields like .name)
    // when surfacing it as the chosen destination.
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
            pick.candidate.snapM = pick.snapM;
            pick.candidate.detour = pick.detour;
            bestRejected = pick.candidate;
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
