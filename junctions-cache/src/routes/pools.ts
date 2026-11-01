// POST /pois + POST /roads — start-anchored candidate pools, sampled to POOL_CAP.

import type { Hono, Context } from 'hono';
import type { AnchoredLookupResult } from '../cache.js';
import { ipRateLimit } from '../rate-limit.js';
import { parsePoiRequest, parseRoadRequest, type PoolAnchor } from '../lib/parse-pool-request.js';
import { readParsedBody } from '../lib/post-body.js';
import { filtersForTypes } from '../poi-catalog.js';
import { POOL_CAP, samplePool } from '../lib/pool.js';
import { getPoisAnchored, getRoadsAnchored } from '../lookups.js';
import { logStart, respondLookup } from './respond.js';

// The cached set is the whole annulus; the response is a fresh random slice of
// it, so a cache hit still re-rolls rather than replaying the same candidates.
// `total` stays the size of the cached set.
function respondWithPool(
    c: Context,
    kind: 'pois' | 'roads',
    anchor: PoolAnchor,
    select: string,
    lookup: () => Promise<AnchoredLookupResult>,
) {
    const sampled = async () => {
        const result = await lookup();
        return { ...result, points: samplePool(result.points, POOL_CAP) };
    };
    return respondLookup(c, sampled, {
        event: 'pool_lookup',
        pointsKey: 'candidates',
        logFields: { kind, start: logStart(anchor), minKm: anchor.minKm, maxKm: anchor.maxKm, select },
    });
}

// Called once per createApp(), so the rate-limit buckets are per-instance
// (tests) rather than process singletons. Each endpoint gets its own budget, as
// in registerJunctionsRoutes; the global Overpass concurrency cap in
// overpass-limit.ts is the real upstream protection.
export function registerPoolRoutes(app: Hono): void {
    const poisRateLimit = ipRateLimit(60);
    const roadsRateLimit = ipRateLimit(60);

    app.post('/pois', poisRateLimit, async c => {
        const parsed = await readParsedBody(c, parsePoiRequest);
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
        // Re-resolved rather than threaded through the parser: filtersForTypes is
        // the single place a catalog key becomes an Overpass filter, and it has
        // already rejected anything unknown above.
        const resolved = filtersForTypes(parsed.types);
        if (!resolved.ok) return c.json({ error: resolved.error }, 400);
        return respondWithPool(c, 'pois', parsed.anchor, resolved.typesKey,
            () => getPoisAnchored(parsed.anchor, resolved.typesKey, resolved.filters));
    });

    app.post('/roads', roadsRateLimit, async c => {
        const parsed = await readParsedBody(c, parseRoadRequest);
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
        return respondWithPool(c, 'roads', parsed.anchor, parsed.exclude,
            () => getRoadsAnchored(parsed.anchor, parsed.exclude));
    });
}
