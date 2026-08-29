// Destination-resolution pipeline — resolve a candidate pool, screen it for
// water-reachability, and build the best route for it. Pure orchestration of
// pieces that live in sibling modules (overpass fetchers, screening, novelty
// ranking, junction/route builders); reads NO DOM — mode flags (winterMode,
// smartRouting, degraded) are passed in, matching route-dispatch.js. This file
// never touches document/DOM or osrm.js's isSelfHostedDown() latch directly.
// Every cross-file dependency (rankByNovelty, generateRandomPointAnnulus,
// capPool, screenCandidates, screeningTableFn, fetchRoadsInRadius,
// fetchPOIsInRadius, buildJunctionLoop, buildRouteForMode,
// OVERLAP_BAD_THRESHOLD, POI_TYPES) is resolved from globalThis at call time.
// Loaded after route-dispatch.js + osrm.js + overpass.js, before app.js;
// generate.js's generateDestination wires it.

// Orchestration-layer routing policy — the size of the random-annulus candidate
// pool and the smart-routing retry budget for findBestLoop. (Don't confuse
// RANDOM_POOL_SIZE with screening.js's SCREENING_POOL_CAP: this seeds the pool,
// that caps the OSRM fan-out over it.)
const RANDOM_POOL_SIZE = 15;
// 3 candidates: deepest novel candidate is usually the best-shape POI in the
// area; if none of the top 3 work, the area is structurally bad.
const MAX_RETRY_ATTEMPTS = 3;

// Single-pick novelty selection: delegate to rankByNovelty (novelty.js), which
// owns the min-distance scoring + most-novel-half selection. rankByNovelty
// shuffles the top half internally, so [0] is a uniformly random pick from the
// most-novel half (or from all candidates when there's no history). Returns
// undefined on an empty pool.
function pickMostNovelDestination(candidates, existingDests) {
    return rankByNovelty(candidates, existingDests)[0];
}

// A pool of fully random points in the annulus — the fallback when Overpass
// fails or returns nothing, and the pool for 'any' (random-point-anywhere).
function randomCandidatePool(startLat, startLng, straightMin, straightMax) {
    return Array.from({ length: RANDOM_POOL_SIZE }, () =>
        generateRandomPointAnnulus(startLat, startLng, straightMin, straightMax));
}

// The random-annulus resolution shape: pool + initial novelty pick, no name.
// Used both as the Overpass fallback and for the 'any' strategy.
function randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests) {
    const candidatePool = randomCandidatePool(startLat, startLng, straightMin, straightMax);
    return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
}

// Resolve the destination candidate pool for the chosen routing strategy.
// POI/road strategies hit Overpass and fall back to a random annulus pool; 'any'
// goes straight to a random pool. `rawLocationType` is the underlying <select>
// value — only meaningful in the 'poi' branch, where it names the specific POI
// key to look up. `winterMode` (roads branch) is passed in, not read from the
// DOM. Three distinct fallbacks with accurate progress messages: a genuine fetch
// failure (only the fetch call is in the try), a successful-but-empty response,
// and a 'poi' key that isn't in the catalog (stale settings restore a value
// with no matching <option>, leaving select.value === ''). Errors from
// capPool/pickMostNovelDestination are NOT caught here — they surface to
// generateDestination's handler instead of being silently masked as "Overpass
// unavailable". Returns the full pool plus an initial novelty pick:
// { candidatePool, dest, destName }.
async function resolveCandidatePool(startLat, startLng, {
    routingStrategy, rawLocationType, straightMin, straightMax, existingDests, onProgress, winterMode = false,
}) {
    if (routingStrategy === 'roads') {
        onProgress('Searching for roads in the area…');
        let roads;
        try {
            roads = await fetchRoadsInRadius(startLat, startLng, straightMin, straightMax, onProgress, winterMode);
        } catch {
            onProgress('Overpass unavailable, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        if (roads.length === 0) {
            onProgress('No roads found nearby, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        const candidatePool = capPool(roads);
        return { candidatePool, dest: pickMostNovelDestination(candidatePool, existingDests), destName: null };
    }
    if (routingStrategy === 'any_poi' || routingStrategy === 'poi') {
        let filters, label;
        if (routingStrategy === 'any_poi') {
            filters = POI_TYPES.map(p => p.filter);
            label = 'any POI';
        } else {
            // One catalog lookup. fetchPOIsInRadius already wraps a scalar
            // filter in an array, so pass poiType.filter as-is — do not
            // wrap-then-unwrap, and do not send an empty union on a miss.
            const poiType = POI_TYPES.find(p => p.key === rawLocationType);
            if (!poiType) {
                onProgress('Unknown place type, using random point…');
                return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
            }
            filters = poiType.filter;
            label = poiType.label || 'places';
        }
        onProgress(`Searching for ${label}…`);
        let pois;
        try {
            pois = await fetchPOIsInRadius(startLat, startLng, straightMin, straightMax, filters, onProgress);
        } catch {
            onProgress('Overpass unavailable, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        if (pois.length === 0) {
            onProgress('No matching places found nearby, using random point…');
            return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
        }
        const candidatePool = capPool(pois);
        const dest = pickMostNovelDestination(candidatePool, existingDests);
        return { candidatePool, dest, destName: dest.name };
    }
    // routingStrategy === 'any': a fully random point anywhere in the annulus.
    return randomPoolResult(startLat, startLng, straightMin, straightMax, existingDests);
}

// Screen the candidate pool for water-reachability before route building.
// Survivors replace the pool and get a fresh novelty pick; if none survive, the
// best-rejected candidate is used and waterLocked is flagged. destName comes
// from the new pick only (unnamed OSM features stay unnamed — do not inherit
// the pre-screening candidate's label). On screening failure (or no screened
// result) the unscreened pool/dest/destName pass through unchanged. Returns
// { candidatePool, dest, destName, waterLocked }.
async function screenCandidatePool(startLat, startLng, { candidatePool, dest, destName, existingDests, onProgress }) {
    try {
        onProgress('Checking reachability…');
        const screened = await screenCandidates(
            { lat: startLat, lng: startLng },
            candidatePool,
            { tableFn: screeningTableFn }
        );
        if (screened.survivors.length > 0) {
            const pool = screened.survivors;
            const pick = pickMostNovelDestination(pool, existingDests);
            return { candidatePool: pool, dest: pick, destName: pick.name || null, waterLocked: false };
        }
        if (screened.bestRejected) {
            return {
                candidatePool: [screened.bestRejected],
                dest: screened.bestRejected,
                destName: screened.bestRejected.name || null,
                waterLocked: true,
            };
        }
    } catch (err) {
        console.warn('Screening failed, falling back to unscreened pool:', err);
    }
    return { candidatePool, dest, destName, waterLocked: false };
}

// True when `candidate` should replace the current best loop. Both legs must be
// present — a total OSRM failure ({outbound:null,return:null,overlap:null}) is
// never ranked, so findBestLoop returns null when nothing usable was built
// (and a later buildLoop fallback with null overlap can still win). A measured
// overlap always beats a null (unknown) overlap; two nulls never displace.
function isBetterLoop(candidate, best) {
    if (!candidate.outbound || !candidate.return) return false;
    if (!best) return true;
    if (candidate.overlap === null) return false;
    return best.overlap === null || candidate.overlap < best.overlap;
}

// Smart-routing retry loop: rank the pool by novelty and build a junction loop
// for each candidate, keeping the lowest-overlap result. Stops early once a
// loop beats the overlap threshold. Each attempt fetches its own corridor —
// the pool is bbox-filtered to that dest, so reusing attempt 1's junctions
// would silently disable snapping on dests in a different direction. The
// junctions-cache service keys on start+maxKm+exclude, so the refetch is a
// cache hit, not a new Overpass query. Returns the best { dest, destName,
// outbound, return, overlap, junctions } seen, or null if nothing was built.
async function findBestLoop(startLat, startLng, { candidatePool, dest, existingDests, maxKm, winterMode, spread, onProgress }) {
    const ranked = candidatePool ? rankByNovelty(candidatePool, existingDests) : [dest];
    const retryBudget = Math.min(MAX_RETRY_ATTEMPTS, ranked.length || 1);

    let bestSeen = null;

    for (let i = 0; i < retryBudget; i++) {
        const tryDest = ranked[i];
        if (!tryDest) break;

        onProgress(retryBudget > 1
            ? `Building route… (attempt ${i + 1}/${retryBudget})`
            : 'Building route…');
        // cachedJunctions: null on every dest — corridor pools do not transfer.
        const result = await buildJunctionLoop(startLat, startLng, tryDest.lat, tryDest.lng,
            { maxKm, onProgress, cachedJunctions: null, winterMode, spread });

        const candidate = {
            dest: tryDest,
            destName: tryDest.name || null,
            outbound: result.outbound,
            return: result.return,
            overlap: result.overlap,
            junctions: result.junctions,
        };
        if (isBetterLoop(candidate, bestSeen)) bestSeen = candidate;

        if (candidate.overlap !== null && candidate.overlap < OVERLAP_BAD_THRESHOLD) break;
    }
    return bestSeen;
}

// Build the route for a resolved destination. Smart round-trips run the
// novelty-retry loop (findBestLoop), which may substitute a different,
// lower-overlap destination; one-way and plain loops dispatch straight through
// buildRouteForMode. `smartRouting`/`winterMode`/`degraded` are passed in (read
// from the DOM/latch by the caller). `degraded` — Layer 2 of the shelly-down
// pipeline reduction — short-circuits BEFORE the smartRouting check: while
// degraded, findBestLoop (and therefore buildJunctionLoop, and therefore the
// junctions-cache fetch) is never entered at all, regardless of smartRouting —
// no candidate retries, one chirality, one buildRouteForMode call. That's the
// whole reduction; findBestLoop itself is untouched (retryBudget stays what it
// is — do not add a second retry-limiting mechanism there). Returns the
// (possibly updated) dest/destName plus the built legs, junctions, and loop
// overlap (null when not a measured smart loop, and outbound/return are
// undefined when a smart build produced nothing).
async function buildRouteForDestination(startLat, startLng, {
    candidatePool, dest, destName, existingDests, maxKm, tripMode, spread, smartRouting, winterMode, onProgress,
    degraded = false,
}) {
    if (!degraded && tripMode !== 'one-way' && smartRouting) {
        const best = await findBestLoop(startLat, startLng,
            { candidatePool, dest, existingDests, maxKm, winterMode, spread, onProgress });
        if (best) {
            return { dest: best.dest, destName: best.destName, outbound: best.outbound,
                return: best.return, junctions: best.junctions, overlap: best.overlap };
        }
        return { dest, destName, outbound: undefined, return: undefined, junctions: null, overlap: null };
    }
    const r = await buildRouteForMode(startLat, startLng, dest.lat, dest.lng, {
        tripMode, smartRouting: false, winterMode: false, onProgress,
        buildingMessage: 'Building route…', spread, degraded,
    });
    return { dest, destName, outbound: r.outbound, return: r.return, junctions: null, overlap: null };
}

// ─── globalThis exports ───────────────────────────────────────────────────────
globalThis.RANDOM_POOL_SIZE = RANDOM_POOL_SIZE;
globalThis.MAX_RETRY_ATTEMPTS = MAX_RETRY_ATTEMPTS;
globalThis.pickMostNovelDestination = pickMostNovelDestination;
globalThis.randomCandidatePool = randomCandidatePool;
globalThis.randomPoolResult = randomPoolResult;
globalThis.resolveCandidatePool = resolveCandidatePool;
globalThis.screenCandidatePool = screenCandidatePool;
globalThis.isBetterLoop = isBetterLoop;
globalThis.findBestLoop = findBestLoop;
globalThis.buildRouteForDestination = buildRouteForDestination;
