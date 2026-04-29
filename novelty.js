// Novelty ranking helpers — distance-from-existing scoring for retry use.
// Loaded after bbox.js, before app.js. Pure helpers, no DOM access.

// Haversine in km between (lat1, lng1) and (lat2, lng2). Local copy to keep
// novelty.js loadable without app.js (which owns calculateDistance).
function _haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Min haversine distance from candidate `c` (object with .lat/.lng) to any
// point in `existingDests` (array of [lat, lng] tuples).
function minDistanceToExisting(c, existingDests) {
    return existingDests.reduce(
        (min, [eLat, eLng]) => Math.min(min, _haversineKm(c.lat, c.lng, eLat, eLng)),
        Infinity
    );
}

// Fisher-Yates in place. Returns the same array for chaining.
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
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
globalThis.shuffleInPlace = shuffleInPlace;
globalThis.rankByNovelty = rankByNovelty;
