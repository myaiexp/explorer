// Hono app factory — routes only, no bootstrap.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { getJunctions, getJunctionsAnchored, cacheSize, type LookupResult } from './cache.js';
import { ipRateLimit } from './rate-limit.js';
import { log, getRecentLogs } from './log.js';
import {
    parseJunctionsQuery,
    fieldsFromUnknown,
    type ParsedJunctionsQuery,
} from './lib/parse-request.js';
import { BodyTooLargeError, readTextCapped } from './lib/read-capped.js';

// Match nginx client_max_body_size 16k so a direct tailnet POST cannot
// dump an unbounded JSON body that the proxy would have refused.
const MAX_POST_BYTES = 16 * 1024;

// /logs serves recent request events back to a remote caller (debugging). Those
// events include the walker's anchored `start` at ~110 m precision (≈ home) and
// roaming radius, and the endpoint is publicly reachable via the VPS proxy at
// /api/junctions/logs — so it is CLOSED by default (audit: unauthenticated log
// dump leaking home coords). Set LOGS_TOKEN to reopen it behind a constant-time
// bearer-token check; unset ⇒ refuse. journald (`ssh shelly journalctl -u
// wander-junctions`) remains the primary, already-authenticated log path.
function logsTokenOk(c: Context): boolean {
    const expected = process.env.LOGS_TOKEN;
    if (!expected) return false;
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// overpassMs is on every live Overpass wait — originator (`miss`) and
// inflight-join (`coalesced`). Instant in-memory hits omit it.
function overpassMsOf(result: LookupResult): number | undefined {
    return result.cache === 'hit' ? undefined : result.overpassMs;
}

// startLat/startLng on the request line land in nginx access logs at full JS
// precision (often home). GET is bbox-only; anchored lookups go through POST
// (finding #7559). A leftover query-string start on POST is refused the same way.
const QUERY_ANCHOR_ERROR = 'startLat, startLng, maxKm must be sent in the POST body';

function queryHasAnchor(c: Context): boolean {
    return c.req.query('startLat') != null
        || c.req.query('startLng') != null
        || c.req.query('maxKm') != null;
}

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

export function createApp(): Hono {
    const app = new Hono();

    // Per-IP rate limiters (defense-in-depth behind the nginx edge limiter; also
    // guards the direct-tailnet path that bypasses nginx). /junctions is generous
    // since re-rolls are mostly cache hits — the global Overpass concurrency cap in
    // cache.ts is the real upstream protection. Owned by the factory so each
    // createApp() gets a fresh bucket map (tests) rather than a process singleton.
    const junctionsRateLimit = ipRateLimit(60);
    const logsRateLimit = ipRateLimit(30);
    const healthRateLimit = ipRateLimit(120);

    app.get('/health', healthRateLimit, c => c.json({ ok: true, cacheEntries: cacheSize() }));

    app.get('/logs', logsRateLimit, c => {
        if (!logsTokenOk(c)) return c.json({ error: 'unauthorized' }, 401);
        const n = parseInt(c.req.query('n') ?? '100', 10);
        return c.json({ logs: getRecentLogs(Number.isNaN(n) ? 100 : n) });
    });

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
        let body: unknown;
        try {
            const text = await readTextCapped(
                c.req.raw.body,
                MAX_POST_BYTES,
                'request',
                c.req.header('content-length'),
            );
            body = JSON.parse(text);
        } catch (e) {
            if (e instanceof BodyTooLargeError) return c.json({ error: 'body too large' }, 413);
            return c.json({ error: 'invalid JSON' }, 400);
        }
        const fields = fieldsFromUnknown(body);
        if (!fields.ok) return c.json({ error: fields.error }, 400);
        const parsed = parseJunctionsQuery(fields.fields);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        return lookupJunctions(c, parsed);
    });

    return app;
}
