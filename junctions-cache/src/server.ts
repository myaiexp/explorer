// Hono entrypoint — single GET /junctions endpoint backed by the cache.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getJunctions, getJunctionsAnchored, loadCache, cacheSize } from './cache.js';
import { log, getRecentLogs } from './log.js';
import type { Bbox, ExcludePreset } from './overpass.js';

const PORT = parseInt(process.env.PORT ?? '5001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_AREA_DEG2 = 4;     // hard cap on bbox area to prevent abuse (~ 444km × 222km in Finland)
const MAX_RADIUS_KM = 50;    // sanity cap on start-anchored radius

const app = new Hono();

app.get('/health', c => c.json({ ok: true, cacheEntries: cacheSize() }));

app.get('/logs', c => {
    const n = parseInt(c.req.query('n') ?? '100', 10);
    return c.json({ logs: getRecentLogs(Number.isNaN(n) ? 100 : n) });
});

app.get('/junctions', async c => {
    const bboxStr = c.req.query('bbox');
    const excludeStr = (c.req.query('exclude') ?? 'default') as string;
    const startLatStr = c.req.query('startLat');
    const startLngStr = c.req.query('startLng');
    const maxKmStr = c.req.query('maxKm');

    if (!bboxStr) return c.json({ error: 'missing bbox' }, 400);
    if (excludeStr !== 'default' && excludeStr !== 'winter') {
        return c.json({ error: 'exclude must be "default" or "winter"' }, 400);
    }
    const exclude = excludeStr as ExcludePreset;

    const parts = bboxStr.split(',').map(s => parseFloat(s));
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
        return c.json({ error: 'bbox must be minLat,minLng,maxLat,maxLng' }, 400);
    }
    const [minLat, minLng, maxLat, maxLng] = parts as [number, number, number, number];
    if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 || minLat >= maxLat || minLng >= maxLng) {
        return c.json({ error: 'bbox out of range or inverted' }, 400);
    }
    if ((maxLat - minLat) * (maxLng - minLng) > MAX_AREA_DEG2) {
        return c.json({ error: 'bbox too large' }, 400);
    }

    const bbox: Bbox = { minLat, minLng, maxLat, maxLng };
    const bboxLog = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;

    // Anchor params are all-or-nothing: startLat, startLng and maxKm must be
    // supplied together. A partial set is a malformed request — silently falling
    // through to bbox mode would look like success while ignoring the intended
    // anchoring (audit #3159).
    const anchorEntries: [string, string | undefined][] = [
        ['startLat', startLatStr],
        ['startLng', startLngStr],
        ['maxKm', maxKmStr],
    ];
    const presentAnchorCount = anchorEntries.filter(([, v]) => v != null).length;
    if (presentAnchorCount > 0 && presentAnchorCount < anchorEntries.length) {
        const missing = anchorEntries.filter(([, v]) => v == null).map(([k]) => k);
        return c.json({ error: `incomplete anchor: missing ${missing.join(', ')} (startLat, startLng, maxKm must be supplied together)` }, 400);
    }

    // Start-anchored mode: cache once per (start, maxKm, exclude). Used when
    // the client supplies all three. Falls through to legacy bbox mode when none
    // are supplied.
    if (startLatStr != null && startLngStr != null && maxKmStr != null) {
        const startLat = parseFloat(startLatStr);
        const startLng = parseFloat(startLngStr);
        const maxKm = parseFloat(maxKmStr);
        if (Number.isNaN(startLat) || Number.isNaN(startLng) || Number.isNaN(maxKm)) {
            return c.json({ error: 'invalid startLat/startLng/maxKm' }, 400);
        }
        if (startLat < -90 || startLat > 90 || startLng < -180 || startLng > 180) {
            return c.json({ error: 'startLat/startLng out of range' }, 400);
        }
        if (maxKm <= 0 || maxKm > MAX_RADIUS_KM) {
            return c.json({ error: `maxKm must be in (0, ${MAX_RADIUS_KM}]` }, 400);
        }

        try {
            const result = await getJunctionsAnchored({ startLat, startLng, maxKm }, exclude, bbox);
            log('INFO', {
                event: 'lookup',
                mode: 'anchored',
                cache: result.cache,
                start: `${startLat.toFixed(3)},${startLng.toFixed(3)}`,
                maxKm: Math.ceil(maxKm),
                bbox: bboxLog,
                exclude,
                count: result.junctions.length,
                total: result.total,
                overpass_ms: result.cache === 'miss' ? result.overpassMs : undefined
            });
            return c.json({
                cache: result.cache,
                count: result.junctions.length,
                total: result.total,
                overpassMs: result.cache === 'miss' ? result.overpassMs : undefined,
                junctions: result.junctions
            });
        } catch (e) {
            const err = e as Error;
            log('ERROR', { event: 'lookup_failed', mode: 'anchored', bbox: bboxLog, exclude, err: err.message });
            return c.json({ error: 'POI search is busy. Please try again.' }, 502);
        }
    }

    try {
        const result = await getJunctions(bbox, exclude);
        log('INFO', {
            event: 'lookup',
            mode: 'bbox',
            cache: result.cache,
            bbox: bboxLog,
            exclude,
            count: result.junctions.length,
            overpass_ms: result.cache === 'miss' ? result.overpassMs : undefined
        });
        return c.json({
            cache: result.cache,
            count: result.junctions.length,
            overpassMs: result.cache === 'miss' ? result.overpassMs : undefined,
            junctions: result.junctions
        });
    } catch (e) {
        const err = e as Error;
        log('ERROR', { event: 'lookup_failed', mode: 'bbox', bbox: bboxLog, exclude, err: err.message });
        return c.json({ error: 'POI search is busy. Please try again.' }, 502);
    }
});

await loadCache();
serve({ fetch: app.fetch, port: PORT, hostname: HOST });
log('INFO', { event: 'started', host: HOST, port: PORT });
