// Per-IP token-bucket rate limiting for the junctions-cache endpoints.
//
// Defense-in-depth behind the nginx edge limiter: the public path is already
// `limit_req`'d, but this also covers direct tailnet access (which bypasses
// nginx) and bounds a single client's request rate per endpoint. The client IP
// is read from X-Forwarded-For (set by the nginx proxy), falling back to the
// raw socket address for direct connections.

import type { Context, Next } from 'hono';

interface Bucket {
    tokens: number;
    lastRefill: number;
}

const MINUTE = 60_000;
// Hard ceiling per limiter. Far above any realistic active-client count, but
// bounds heap growth under a spoofed-X-Forwarded-For flood of distinct keys.
const MAX_BUCKETS = 10_000;

export function clientIp(c: Context): string {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        const first = xff.split(',')[0]?.trim();
        if (first) return first;
    }
    // @hono/node-server exposes the raw Node request on c.env.incoming.
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

// Continuously accrue tokens at limit/windowMs per ms, capped at limit. Unlike a
// fixed window this never grants a full reset at a boundary, so a client cannot
// drain the bucket and immediately drain it again (the classic double-rate burst).
function refill(b: Bucket, limit: number, windowMs: number, now: number): void {
    const elapsed = now - b.lastRefill;
    if (elapsed <= 0) return;
    b.tokens = Math.min(limit, b.tokens + (elapsed / windowMs) * limit);
    b.lastRefill = now;
}

// Build an independent IP-keyed limiter middleware: `limit` requests per
// `windowMs` per client IP. Each call owns its own bucket map, so endpoints get
// separate budgets.
export function ipRateLimit(limit: number, windowMs: number = MINUTE) {
    const buckets = new Map<string, Bucket>();
    return async (c: Context, next: Next): Promise<Response | void> => {
        const now = Date.now();
        const ip = clientIp(c);
        let b = buckets.get(ip);
        if (!b) {
            if (buckets.size >= MAX_BUCKETS) {
                // Evict buckets idle ≥ 2 windows (fully refilled ⇒ indistinguishable
                // from never-seen) before admitting a new key.
                for (const [k, bk] of buckets) {
                    if (now - bk.lastRefill >= windowMs * 2) buckets.delete(k);
                }
                if (buckets.size >= MAX_BUCKETS) {
                    return c.json({ error: 'Rate limit exceeded' }, 429);
                }
            }
            b = { tokens: limit, lastRefill: now };
            buckets.set(ip, b);
        } else {
            refill(b, limit, windowMs, now);
        }
        if (b.tokens < 1) {
            const deficit = 1 - b.tokens;
            const secs = Math.max(1, Math.ceil((deficit / limit) * windowMs / 1000));
            return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(secs) });
        }
        b.tokens -= 1;
        await next();
    };
}
