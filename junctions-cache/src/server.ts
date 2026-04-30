// Hono entrypoint — single GET /junctions endpoint backed by the cache.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getJunctions, loadCache, cacheSize } from './cache.js';
import { log } from './log.js';
import type { Bbox, ExcludePreset } from './overpass.js';

const PORT = parseInt(process.env.PORT ?? '5001', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_AREA_DEG2 = 4;  // hard cap on bbox area to prevent abuse (~ 444km × 222km in Finland)

const app = new Hono();

app.get('/health', c => c.json({ ok: true, cacheEntries: cacheSize() }));

app.get('/junctions', async c => {
    const bboxStr = c.req.query('bbox');
    const excludeStr = (c.req.query('exclude') ?? 'default') as string;
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

    try {
        const result = await getJunctions(bbox, exclude);
        log('INFO', {
            event: 'lookup',
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
        log('ERROR', { event: 'lookup_failed', bbox: bboxLog, exclude, err: err.message });
        return c.json({ error: 'POI search is busy. Please try again.' }, 502);
    }
});

await loadCache();
serve({ fetch: app.fetch, port: PORT, hostname: HOST });
log('INFO', { event: 'started', host: HOST, port: PORT });
