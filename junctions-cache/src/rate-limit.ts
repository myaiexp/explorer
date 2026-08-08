// Per-IP token-bucket rate limiting for the junctions-cache endpoints.
//
// Defense-in-depth behind the nginx edge limiter: the public path is already
// `limit_req`'d, but this also covers direct tailnet access (which bypasses
// nginx) and bounds a single client's request rate per endpoint. The client IP
// is read from X-Forwarded-For (set by the nginx proxy), falling back to the
// raw socket address for direct connections.
//
// TWIN: server/src/middleware/rate-limit.ts carries the same token-bucket core.
// The two are deliberately kept independent — separate deployables on separate
// boxes (this ships to shelly, that to the VPS), each with its own lockfile and
// `--frozen-lockfile` deploy and its own per-package `tsc` rootDir, so there is
// no workspace to share a package through. MIRROR any fix to the shared core in
// BOTH files: the Bucket shape, refill()'s continuous accrual (incl. the
// no-double-rate-burst property), the trusted-proxy client-IP extraction
// (clientIp here / lib/client-ip.ts there), the Retry-After deficit math, and the
// idle-≥-2-windows staleness rule. Do NOT sync the per-service policy, which is
// intentionally different: MAX_BUCKETS (10k here vs 50k there), inline eviction
// here vs a periodic sweeper there, and factory-owned vs module-level maps.

import type { Context, Next } from 'hono';

interface Bucket {
    tokens: number;
    lastRefill: number;
}

const MINUTE = 60_000;
// Hard ceiling per limiter. Far above any realistic active-client count, but
// bounds heap growth under a spoofed-X-Forwarded-For flood of distinct keys.
const MAX_BUCKETS = 10_000;

// nginx on loopback (and IPv4-mapped IPv6). Override with TRUSTED_PROXIES=ip,ip.
const DEFAULT_TRUSTED = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_IP_LEN = 45;
const IP_CHARS = /^[0-9a-fA-F:.]+$/;

function trustedProxies(): ReadonlySet<string> {
    const raw = process.env.TRUSTED_PROXIES;
    if (raw && raw.trim()) {
        return new Set(raw.split(',').map((s: string) => s.trim()).filter(Boolean));
    }
    return DEFAULT_TRUSTED;
}

function isPlausibleIp(value: string): boolean {
    return value.length > 0 && value.length <= MAX_IP_LEN && IP_CHARS.test(value);
}

/**
 * Client IP for the rate-limit key. Trust X-Forwarded-For only when the TCP
 * peer is a known reverse proxy — otherwise a caller who reaches this service
 * directly (tailnet, misconfigured firewall) can cycle XFF values to bypass
 * the per-IP bucket (audit #1342; mirrored from explorer-api lib/client-ip.ts).
 */
export function clientIp(c: Context): string {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    const peer = env?.incoming?.socket?.remoteAddress;
    if (peer && trustedProxies().has(peer)) {
        const xff = c.req.header('x-forwarded-for');
        if (xff) {
            const first = xff.split(',')[0]?.trim();
            if (first && isPlausibleIp(first)) return first;
        }
        return peer;
    }
    if (peer) return peer;
    return 'unknown';
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
