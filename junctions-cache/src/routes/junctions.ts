// GET + POST /junctions — road-junction lookups, bbox or start-anchored.

import type { Hono, Context } from 'hono';
import { getJunctions, getJunctionsAnchored } from '../cache.js';
import { ipRateLimit } from '../rate-limit.js';
import {
    parseJunctionsBody,
    parseJunctionsQuery,
    type ParsedJunctionsQuery,
} from '../lib/parse-request.js';
import { queryHasAnchor, QUERY_ANCHOR_ERROR, readParsedBody } from '../lib/post-body.js';
import { logStart, respondLookup } from './respond.js';

function lookupJunctions(c: Context, parsed: ParsedJunctionsQuery) {
    const { bbox, exclude, bboxLog, anchor } = parsed;
    const scope = { bbox: bboxLog, exclude };
    if (anchor) {
        return respondLookup(c, () => getJunctionsAnchored(anchor, exclude, bbox), {
            event: 'lookup',
            pointsKey: 'junctions',
            logFields: { mode: 'anchored', start: logStart(anchor), maxKm: Math.ceil(anchor.maxKm), ...scope },
        });
    }
    return respondLookup(c, () => getJunctions(bbox, exclude), {
        event: 'lookup',
        pointsKey: 'junctions',
        logFields: { mode: 'bbox', ...scope },
    });
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
        const parsed = await readParsedBody(c, parseJunctionsBody);
        if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
        return lookupJunctions(c, parsed);
    });
}
