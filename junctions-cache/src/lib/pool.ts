// Candidate-pool primitives — annulus filtering and random down-sampling,
// moved off the browser so a generate ships kilobytes instead of megabytes.

// Mirrors the frontend's SCREENING_POOL_CAP (screening.js). The client still
// calls capPool defensively — it bounds its own OSRM /table fan-out whatever a
// server sends — but this is now where the cut actually happens.
export const POOL_CAP = 45;

export type Point = { lat: number; lng: number };

// The same haversine the frontend used (geo-utils.js), so the candidate set is
// unchanged from today's client-side filtering. Do not re-derive the formula.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Keep only the points whose crow-flies distance from the centre falls in
// [minKm, maxKm], inclusive at both ends. Generic over the point shape so a POI
// keeps its `name` through the filter.
export function filterToAnnulus<T extends Point>(
    points: T[],
    centerLat: number,
    centerLng: number,
    minKm: number,
    maxKm: number,
): T[] {
    const out: T[] = [];
    for (const p of points) {
        const d = haversineKm(centerLat, centerLng, p.lat, p.lng);
        if (d >= minKm && d <= maxKm) out.push(p);
    }
    return out;
}

// Partial Fisher-Yates: shuffle only the first k positions, which is all a
// down-sample reads. Mirrors novelty.js's partialShuffle. Operates on `arr`
// in place — callers pass a copy.
function partialShuffle<T>(arr: T[], k: number): T[] {
    const n = Math.min(k, arr.length);
    for (let i = 0; i < n; i++) {
        const j = i + Math.floor(Math.random() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

// Randomly down-sample to `cap` entries. Returns the input array itself when it
// already fits, so a caller can tell "nothing was dropped" by identity. Never
// mutates the input: the cached superset is sampled fresh on every request, so
// shuffling it in place would reorder the stored set under every later reader.
export function samplePool<T>(points: T[], cap: number): T[] {
    if (points.length <= cap) return points;
    return partialShuffle(points.slice(), cap).slice(0, cap);
}
