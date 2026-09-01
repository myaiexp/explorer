// Operational routes — /health and the token-gated /logs dump.

import type { Hono, Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { cacheSize } from '../cache.js';
import { ipRateLimit } from '../rate-limit.js';
import { getRecentLogs } from '../log.js';

// /logs serves recent request events back to a remote caller (debugging). Those
// events include the walker's anchored `start` at ~110 m precision (≈ home) and
// roaming radius, and the endpoint is publicly reachable via the VPS proxy at
// /api/junctions/logs — so it is CLOSED by default (audit: unauthenticated log
// dump leaking home coords). Set LOGS_TOKEN to reopen it behind a constant-time
// bearer-token check; unset ⇒ refuse. journald (`ssh shelly journalctl -u
// wander-junctions`) remains the primary, already-authenticated log path.
export function logsTokenOk(c: Context): boolean {
    const expected = process.env.LOGS_TOKEN;
    if (!expected) return false;
    const got = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

// Called once per createApp(), so the rate-limit bucket maps are per-instance
// (tests) rather than process singletons.
export function registerMetaRoutes(app: Hono): void {
    const logsRateLimit = ipRateLimit(30);
    const healthRateLimit = ipRateLimit(120);

    app.get('/health', healthRateLimit, c => c.json({ ok: true, cacheEntries: cacheSize() }));

    app.get('/logs', logsRateLimit, c => {
        if (!logsTokenOk(c)) return c.json({ error: 'unauthorized' }, 401);
        const n = parseInt(c.req.query('n') ?? '100', 10);
        return c.json({ logs: getRecentLogs(Number.isNaN(n) ? 100 : n) });
    });
}
