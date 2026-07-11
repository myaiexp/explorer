// Novelty ranking helpers — distance-from-existing scoring for retry use.
// Loaded after geo-utils.js, before app.js. Pure helpers, no DOM access.

// Min haversine distance from candidate `c` (object with .lat/.lng) to any
// point in `existingDests` (array of [lat, lng] tuples). Uses the shared
// haversineKm from geo-utils.js.
function minDistanceToExisting(c, existingDests) {
    return existingDests.reduce(
        (min, [eLat, eLng]) => Math.min(min, haversineKm(c.lat, c.lng, eLat, eLng)),
        Infinity
    );
}

// Fisher-Yates on the first `k` positions of `arr`, in place. Each of the first
// `k` slots receives a uniformly-random pick from the not-yet-placed tail, so a
// partial shuffle (k < length) samples k uniform elements in O(k) without paying
// for a full O(n) shuffle. k >= length - 1 is a full uniform shuffle. Returns the
// same array for chaining. This is the single swap loop shared by shuffleInPlace
// (full) and screening.js capPool (partial, k = SCREENING_POOL_CAP).
function partialShuffle(arr, k) {
    const n = arr.length;
    const limit = Math.min(k, n - 1);
    for (let i = 0; i < limit; i++) {
        const j = i + Math.floor(Math.random() * (n - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Fisher-Yates in place (full shuffle). Returns the same array for chaining.
function shuffleInPlace(arr) {
    return partialShuffle(arr, arr.length);
}

// Order candidates for retry use: most-novel half (shuffled) first, rest
// after. Used by the smart-routing branch's retry loop.
function rankByNovelty(candidates, existingDests) {
    if (!candidates.length) return [];
    if (!existingDests || existingDests.length === 0) {
        return shuffleInPlace(candidates.slice());
    }
    const scored = candidates.map(c => ({
        c,
        score: minDistanceToExisting(c, existingDests),
    }));
    scored.sort((a, b) => b.score - a.score);
    const topSize = Math.max(1, Math.ceil(scored.length / 2));
    const top = shuffleInPlace(scored.slice(0, topSize).map(x => x.c));
    const rest = scored.slice(topSize).map(x => x.c);
    return [...top, ...rest];
}

globalThis.minDistanceToExisting = minDistanceToExisting;
globalThis.partialShuffle = partialShuffle;
globalThis.shuffleInPlace = shuffleInPlace;
globalThis.rankByNovelty = rankByNovelty;
