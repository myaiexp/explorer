// POST /pois + POST /roads — start-anchored candidate pools, sampled to POOL_CAP.

import type { Hono, Context } from 'hono';
import { overpassMsOf, type AnchoredLookupResult } from '../cache.js';
import { ipRateLimit } from '../rate-limit.js';
import { log } from '../log.js';
import { parsePoiRequest, parseRoadRequest, type PoolAnchor } from '../lib/parse-pool-request.js';
import { readJsonBody, queryHasAnchor, QUERY_ANCHOR_ERROR } from '../lib/post-body.js';
import { filtersForTypes } from '../poi-catalog.js';
import { POOL_CAP, samplePool } from '../lib/pool.js';
import { getPoisAnchored, getRoadsAnchored } from '../lookups.js';

// The cached set is the whole annulus; the response is a fresh random slice of
// it, so a cache hit still re-rolls rather than replaying the same candidates.
async function respondWithPool(
    c: Context,
    kind: 'pois' | 'roads',
    anchor: PoolAnchor,
    select: string,
    lookup: () => Promise<AnchoredLookupResult>,
) {
    // Never at full precision — a start is usually the walker's home
    // (finding #7559), and these lines land in the service log.
    const start = `${anchor.startLat.toFixed(3)},${anchor.startLng.toFixed(3)}`;
    try {
        const result = await lookup();
        const candidates = samplePool(result.junctions, POOL_CAP);
        log('INFO', {
            event: 'pool_lookup',
            kind,
            cache: result.cache,
            start,
            minKm: anchor.minKm,
            maxKm: anchor.maxKm,
            select,
            count: candidates.length,
            total: result.total,
            overpass_ms: overpassMsOf(result),
        });
        return c.json({
            cache: result.cache,
            count: candidates.length,
            total: result.total,
            overpassMs: overpassMsOf(result),
            candidates,
        });
    } catch (e) {
        const err = e as Error;
        log('ERROR', { event: 'pool_lookup_failed', kind, start, select, err: err.message });
        return c.json({ error: 'POI search is busy. Please try again.' }, 502);
    }
}

// Called once per createApp(), so the rate-limit buckets are per-instance
// (tests) rather than process singletons. Each endpoint gets its own budget, as
// in registerJunctionsRoutes; the global Overpass concurrency cap in
// overpass-limit.ts is the real upstream protection.
export function registerPoolRoutes(app: Hono): void {
    const poisRateLimit = ipRateLimit(60);
    const roadsRateLimit = ipRateLimit(60);

    app.post('/pois', poisRateLimit, async c => {
        if (queryHasAnchor(c)) return c.json({ error: QUERY_ANCHOR_ERROR }, 400);
        const read = await readJsonBody(c);
        if (!read.ok) return c.json({ error: read.error }, read.status);
        const parsed = parsePoiRequest(read.body);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        // Re-resolved rather than threaded through the parser: filtersForTypes is
        // the single place a catalog key becomes an Overpass filter, and it has
        // already rejected anything unknown above.
        const resolved = filtersForTypes(parsed.types);
        if (!resolved.ok) return c.json({ error: resolved.error }, 400);
        return respondWithPool(c, 'pois', parsed.anchor, resolved.typesKey,
            () => getPoisAnchored(parsed.anchor, resolved.typesKey, resolved.filters));
    });

    app.post('/roads', roadsRateLimit, async c => {
        if (queryHasAnchor(c)) return c.json({ error: QUERY_ANCHOR_ERROR }, 400);
        const read = await readJsonBody(c);
        if (!read.ok) return c.json({ error: read.error }, read.status);
        const parsed = parseRoadRequest(read.body);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        return respondWithPool(c, 'roads', parsed.anchor, parsed.exclude,
            () => getRoadsAnchored(parsed.anchor, parsed.exclude));
    });
}
