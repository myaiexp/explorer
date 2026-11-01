// The log lines and JSON response every Overpass-backed route emits for a lookup.

import type { Context } from 'hono';
import { overpassMsOf, type AnchoredLookupResult, type LookupResult } from '../cache.js';
import { log, type Fields } from '../log.js';

// Never at full precision — a start is usually the walker's home, and these
// lines land in the service log.
export function logStart(start: { startLat: number; startLng: number }): string {
    return `${start.startLat.toFixed(3)},${start.startLng.toFixed(3)}`;
}

export type LookupResponse = {
    event: string;                          // failures log `${event}_failed`
    pointsKey: 'junctions' | 'candidates';  // the response field holding the points
    logFields: Fields;                      // context for the INFO and the ERROR line
};

// `total` is on anchored results only, and overpassMs on anything but a cache
// hit; an undefined field is left out of both the log line and the JSON.
export async function respondLookup(
    c: Context,
    lookup: () => Promise<LookupResult | AnchoredLookupResult>,
    { event, pointsKey, logFields }: LookupResponse,
) {
    try {
        const result = await lookup();
        const count = result.points.length;
        const total = 'total' in result ? result.total : undefined;
        const overpassMs = overpassMsOf(result);
        log('INFO', { event, ...logFields, cache: result.cache, count, total, overpass_ms: overpassMs });
        return c.json({ cache: result.cache, count, total, overpassMs, [pointsKey]: result.points });
    } catch (e) {
        const err = e as Error;
        log('ERROR', { event: `${event}_failed`, ...logFields, err: err.message });
        return c.json({ error: 'POI search is busy. Please try again.' }, 502);
    }
}
