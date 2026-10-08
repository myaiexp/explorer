// Per-IP token-bucket rate limiting for the junctions-cache endpoints.
//
// Defense-in-depth behind the nginx edge limiter: the public path is already
// `limit_req`'d, but this also covers direct tailnet access (which bypasses
// nginx) and bounds a single client's request rate per endpoint. The client IP
// is the TCP socket address; forwarding headers are honoured only when that
// peer is in TRUSTED_PROXIES (loopback by default — nginx). Direct tailnet
// access is therefore keyed on the real peer, not a spoofable XFF / X-Real-IP.
//
// TWIN: server/src/middleware/rate-limit.ts carries the same token-bucket core.
// The two are deliberately kept independent — separate deployables on separate
// boxes (this ships to shelly, that to the VPS), each with its own lockfile and
// `--frozen-lockfile` deploy and its own per-package `tsc` rootDir, so there is
// no workspace to share a package through. MIRROR any fix to the shared core in
// BOTH files: the Bucket shape, refill()'s continuous accrual (incl. the
// no-double-rate-burst property), the forwarding-header parsing (X-Real-IP, then
// the last XFF hop), the Retry-After deficit math, the idle-≥-2-windows
// staleness rule, and the cap on insert (evict stale, then refuse the new key).
// Do NOT sync the per-service policy, which is intentionally different:
// MAX_BUCKETS (10k here vs 50k there), the extra periodic sweeper there,
// factory-owned vs module-level maps, and how a request earns trust for its
// forwarding headers — the TRUSTED_PROXIES peer list here vs a root:www-data
// unix-socket listener there, which trusts no TCP peer at all (finding #10094).

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

// Rate-limit key for an IPv6 address: the /64. IPv4, dotted IPv4-mapped, and
// hex-form IPv4-mapped stay the full address. Unparseable values stay whole.
// TWIN: server/src/lib/client-ip.ts ipv6BucketKey. There is no shared package.
function expandIpv6(ip: string): string[] | null {
    const parts = ip.split('::');
    if (parts.length > 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    if (parts.length === 1 && head.length !== 8) return null;
    if (head.length + tail.length > 8) return null;
    const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    const out: string[] = [];
    for (const group of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
        out.push(Number.parseInt(group, 16).toString(16));
    }
    return out;
}

function ipv6BucketKey(ip: string): string {
    if (!ip.includes(':')) return ip;
    if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(ip)) return ip;
    const hextets = expandIpv6(ip);
    if (!hextets) return ip;
    const mapped = hextets[0] === '0' && hextets[1] === '0' && hextets[2] === '0'
        && hextets[3] === '0' && hextets[4] === '0' && hextets[5] === 'ffff';
    if (mapped) return ip;
    return `${hextets.slice(0, 4).join(':')}::/64`;
}

/**
 * Client IP for the rate-limit key. Trust forwarding headers only when the TCP
 * peer is a known reverse proxy — otherwise a caller who reaches this service
 * directly (tailnet, misconfigured firewall) can cycle XFF / X-Real-IP values
 * to bypass the per-IP bucket (audit #1342; mirrored from wander-api
 * lib/client-ip.ts). Behind a trusted proxy prefer X-Real-IP (nginx overwrites
 * it with $remote_addr), then the last X-Forwarded-For hop — never the
 * client-supplied first hop (finding #7895).
 */
function forwardedClientIp(c: Context): string | undefined {
    const real = c.req.header('x-real-ip')?.trim();
    if (real && isPlausibleIp(real)) return real;
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
        const hops = xff.split(',');
        const last = hops[hops.length - 1]?.trim();
        if (last && isPlausibleIp(last)) return last;
    }
    return undefined;
}

export function clientIp(c: Context): string {
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    const peer = env?.incoming?.socket?.remoteAddress;
    const raw = peer && trustedProxies().has(peer)
        ? (forwardedClientIp(c) ?? peer)
        : (peer ?? 'unknown');
    return ipv6BucketKey(raw);
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
export function ipRateLimit(limit: number, windowMs: number = MINUTE, maxBuckets: number = MAX_BUCKETS) {
    const buckets = new Map<string, Bucket>();
    return async (c: Context, next: Next): Promise<Response | void> => {
        const now = Date.now();
        const ip = clientIp(c);
        let b = buckets.get(ip);
        if (!b) {
            if (buckets.size >= maxBuckets) {
                // Evict buckets idle ≥ 2 windows (fully refilled ⇒ indistinguishable
                // from never-seen) before admitting a new key.
                for (const [k, bk] of buckets) {
                    if (now - bk.lastRefill >= windowMs * 2) buckets.delete(k);
                }
                if (buckets.size >= maxBuckets) {
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
