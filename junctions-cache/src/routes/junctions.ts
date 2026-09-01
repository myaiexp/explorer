// GET + POST /junctions — road-junction lookups, bbox or start-anchored.

import type { Hono, Context } from 'hono';
import { getJunctions, getJunctionsAnchored, overpassMsOf } from '../cache.js';
import { ipRateLimit } from '../rate-limit.js';
import { log } from '../log.js';
import {
    parseJunctionsQuery,
    fieldsFromUnknown,
    type ParsedJunctionsQuery,
} from '../lib/parse-request.js';
import { readJsonBody, queryHasAnchor, QUERY_ANCHOR_ERROR } from '../lib/post-body.js';

async function lookupJunctions(c: Context, parsed: ParsedJunctionsQuery) {
    const { bbox, exclude, bboxLog, anchor } = parsed;
    const mode = anchor ? 'anchored' : 'bbox';
    try {
        if (anchor) {
            const result = await getJunctionsAnchored(anchor, exclude, bbox);
            log('INFO', {
                event: 'lookup',
                mode,
                cache: result.cache,
                start: `${anchor.startLat.toFixed(3)},${anchor.startLng.toFixed(3)}`,
                maxKm: Math.ceil(anchor.maxKm),
                bbox: bboxLog,
                exclude,
                count: result.junctions.length,
                total: result.total,
                overpass_ms: overpassMsOf(result),
            });
            return c.json({
                cache: result.cache,
                count: result.junctions.length,
                total: result.total,
                overpassMs: overpassMsOf(result),
                junctions: result.junctions,
            });
        }

        const result = await getJunctions(bbox, exclude);
        log('INFO', {
            event: 'lookup',
            mode,
            cache: result.cache,
            bbox: bboxLog,
            exclude,
            count: result.junctions.length,
            overpass_ms: overpassMsOf(result),
        });
        return c.json({
            cache: result.cache,
            count: result.junctions.length,
            overpassMs: overpassMsOf(result),
            junctions: result.junctions,
        });
    } catch (e) {
        const err = e as Error;
        log('ERROR', { event: 'lookup_failed', mode, bbox: bboxLog, exclude, err: err.message });
        return c.json({ error: 'POI search is busy. Please try again.' }, 502);
    }
}

// Called once per createApp(), so the rate-limit bucket map is per-instance
// (tests) rather than a process singleton. The limit is generous since re-rolls
// are mostly cache hits — the global Overpass concurrency cap in
// overpass-limit.ts is the real upstream protection.
export function registerJunctionsRoutes(app: Hono): void {
    const junctionsRateLimit = ipRateLimit(60);

    app.get('/junctions', junctionsRateLimit, async c => {
        if (queryHasAnchor(c)) return c.json({ error: QUERY_ANCHOR_ERROR }, 400);
        const parsed = parseJunctionsQuery({
            bbox: c.req.query('bbox'),
            exclude: c.req.query('exclude'),
        });
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        return lookupJunctions(c, parsed);
    });

    app.post('/junctions', junctionsRateLimit, async c => {
        if (queryHasAnchor(c)) return c.json({ error: QUERY_ANCHOR_ERROR }, 400);
        const read = await readJsonBody(c);
        if (!read.ok) return c.json({ error: read.error }, read.status);
        const fields = fieldsFromUnknown(read.body);
        if (!fields.ok) return c.json({ error: fields.error }, 400);
        const parsed = parseJunctionsQuery(fields.fields);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        return lookupJunctions(c, parsed);
    });
}
