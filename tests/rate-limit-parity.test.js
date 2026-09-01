// @vitest-environment node
/**
 * Drift guard for the token-bucket rate-limiter core that exists in two
 * independent deployables:
 *   - server/src/middleware/rate-limit.ts     (VPS wander-api)
 *   - junctions-cache/src/rate-limit.ts        (shelly microservice)
 *
 * Both files carry reciprocal TWIN comments spelling out which parts MUST stay
 * behaviourally identical: the Bucket shape, refill()'s continuous accrual (incl.
 * the no-double-rate-burst property), the trusted-proxy client-IP extraction
 * (X-Real-IP, else X-Forwarded-For's last hop, but only when the TCP peer is a
 * known proxy — audit #1342 / finding #7895), and the Retry-After deficit math. There is no shared package to
 * enforce this (separate lockfiles, separate boxes), so this test is the
 * enforcement — the sibling of tests/poi-catalog-parity.test.js.
 *
 * Rather than compare source text (the two files legitimately differ in variable
 * names, structure, and per-service policy), we drive both limiters through
 * IDENTICAL request vectors under a pinned clock and assert identical observable
 * behaviour (allow/block + Retry-After). A fix that lands in only one core forks
 * the outputs and fails RED here. Per-service policy — MAX_BUCKETS, the sweeper
 * vs inline eviction — is deliberately NOT exercised; only the shared core is.
 *
 * The comparison uses the two limiters at a matching config (60 requests / 60s):
 * server's readRateLimit() is fixed at 60/min per IP, and junctions'
 * ipRateLimit(60, 60_000) matches it — so identical inputs must yield identical
 * outputs iff the shared core agrees.
 *
 * Type-only `import type ... from 'hono'` in both modules is stripped by esbuild
 * at transform time, so neither pulls hono in at runtime — they import cleanly
 * into this root (hono-less) test.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ipRateLimit } from '../junctions-cache/src/rate-limit.ts';
import { readRateLimit, resetRateLimiter } from '../server/src/middleware/rate-limit.ts';

// nginx on loopback — the peer both cores trust, so XFF is honored for it.
const TRUSTED_PEER = '127.0.0.1';
// A direct caller (tailnet / misconfigured firewall). Both cores must ignore
// whatever XFF it sends and key on this address instead.
const UNTRUSTED_PEER = '100.64.0.9';

// Minimal Hono-Context stand-in exposing exactly what the two limiters touch:
// c.req.header('x-forwarded-for' | 'x-real-ip'), c.req.param(), c.env, and
// c.json(body, status, headers). Captures the c.json() call so the caller can
// read status + headers.
//
// c.env.incoming.socket.remoteAddress is where @hono/node-server puts the TCP
// peer, and both cores read it to decide whether forwarding headers are
// trustworthy at all. A stand-in without it makes every request key on the
// 'unknown' fallback, which silently collapses the distinct-client cases below
// into one shared bucket.
function makeCtx(xff, peer, realIp) {
    let jsonCall = null;
    const c = {
        req: {
            header: (name) => {
                const n = name.toLowerCase();
                if (n === 'x-forwarded-for') return xff;
                if (n === 'x-real-ip') return realIp;
                return undefined;
            },
            param: () => 'unknown',
        },
        env: { incoming: { socket: { remoteAddress: peer } } },
        json: (body, status, headers) => {
            jsonCall = { body, status: status ?? 200, headers: headers ?? {} };
            return jsonCall;
        },
    };
    return { c, getJsonCall: () => jsonCall };
}

// Run one request through a middleware and normalize the outcome to
// { blocked, retryAfter } — blocked iff the middleware 429'd instead of next().
async function drive(mw, xff, peer = TRUSTED_PEER, realIp) {
    const { c, getJsonCall } = makeCtx(xff, peer, realIp);
    await mw(c, async () => {});
    const jc = getJsonCall();
    if (jc && jc.status === 429) {
        return { blocked: true, retryAfter: jc.headers['Retry-After'] };
    }
    return { blocked: false, retryAfter: undefined };
}

// Both limiters at the same (limit=60, window=60s) config.
function makePair() {
    return { junctions: ipRateLimit(60, 60_000), server: readRateLimit() };
}

describe('rate-limiter core parity: server ↔ junctions-cache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        resetRateLimiter(); // server maps are module-level; junctions maps are per-factory
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('both import as callable middleware factories', () => {
        expect(typeof ipRateLimit).toBe('function');
        expect(typeof readRateLimit).toBe('function');
    });

    test('refill accrual + Retry-After deficit math agree across identical vectors', async () => {
        const { junctions, server } = makePair();
        // Distinct IP keys so the two limiters never share a bucket (they don't
        // anyway — different maps — but this keeps intent explicit).
        const JIP = 'jx';
        const SIP = 'sx';

        // Exhaust from a clean bucket at t=0: 60 allowed, 61st blocked, and the
        // blocked Retry-After must match across both cores.
        for (let i = 0; i < 60; i++) {
            expect((await drive(junctions, JIP)).blocked).toBe(false);
            expect((await drive(server, SIP)).blocked).toBe(false);
        }
        const j61 = await drive(junctions, JIP);
        const s61 = await drive(server, SIP);
        expect(j61.blocked).toBe(true);
        expect(s61.blocked).toBe(true);
        expect(j61.retryAfter).toBe(s61.retryAfter);

        // Partial refill at +500ms: 0.5 token accrued (60·500/60000) — still under
        // 1, so still blocked, and the deficit→seconds math must still agree.
        vi.setSystemTime(500);
        const j500 = await drive(junctions, JIP);
        const s500 = await drive(server, SIP);
        expect(j500.blocked).toBe(true);
        expect(s500.blocked).toBe(true);
        expect(j500.retryAfter).toBe(s500.retryAfter);

        // A full token accrues 1000ms after the last touch (t=1500): both admit
        // exactly one request. Proves the accrual RATE is identical, not just the
        // cap. (A drift like doubling the accrual would admit here at t=500.)
        vi.setSystemTime(1500);
        expect((await drive(junctions, JIP)).blocked).toBe(false);
        expect((await drive(server, SIP)).blocked).toBe(false);
    });

    test('behind a trusted proxy, both key on the LAST X-Forwarded-For hop (finding #7895)', async () => {
        const { junctions, server } = makePair();

        // Every drive() below comes from TRUSTED_PEER, so XFF is honored.
        // Exhaust each limiter using a multi-hop XFF whose last hop is 5.6.7.8.
        for (let i = 0; i < 60; i++) {
            await drive(junctions, '1.2.3.4, 5.6.7.8');
            await drive(server, '9.9.9.9, 5.6.7.8');
        }

        // A request with the SAME last hop (different leading hops) shares the
        // exhausted bucket → blocked in both. If either still read the first
        // hop, this would be a fresh bucket and pass.
        expect((await drive(junctions, '42.42.42.42, 5.6.7.8')).blocked).toBe(true);
        expect((await drive(server, '42.42.42.42, 5.6.7.8')).blocked).toBe(true);

        // A request whose LAST hop differs is a distinct client → allowed in both.
        expect((await drive(junctions, '5.6.7.8, 7.7.7.7')).blocked).toBe(false);
        expect((await drive(server, '5.6.7.8, 7.7.7.7')).blocked).toBe(false);
    });

    test('behind a trusted proxy, both prefer X-Real-IP over XFF (finding #7895)', async () => {
        const { junctions, server } = makePair();

        for (let i = 0; i < 60; i++) {
            await drive(junctions, '1.2.3.4, 5.6.7.8', TRUSTED_PEER, '203.0.113.9');
            await drive(server, '9.9.9.9, 8.8.8.8', TRUSTED_PEER, '203.0.113.9');
        }

        // Same X-Real-IP, completely different XFF → still the exhausted bucket.
        expect((await drive(junctions, '7.7.7.7', TRUSTED_PEER, '203.0.113.9')).blocked).toBe(true);
        expect((await drive(server, '7.7.7.7', TRUSTED_PEER, '203.0.113.9')).blocked).toBe(true);

        expect((await drive(junctions, '7.7.7.7', TRUSTED_PEER, '203.0.113.10')).blocked).toBe(false);
        expect((await drive(server, '7.7.7.7', TRUSTED_PEER, '203.0.113.10')).blocked).toBe(false);
    });

    test('from an untrusted peer, both ignore X-Forwarded-For and key on the peer', async () => {
        const { junctions, server } = makePair();

        // The bypass audit #1342 closed: a direct caller cycling XFF values used to
        // mint a fresh bucket per value. Now the peer is the key, so 60 requests
        // exhaust it no matter how many distinct XFF strings they carry.
        for (let i = 0; i < 60; i++) {
            await drive(junctions, `10.0.0.${i}`, UNTRUSTED_PEER);
            await drive(server, `10.0.0.${i}`, UNTRUSTED_PEER);
        }
        expect((await drive(junctions, '203.0.113.7', UNTRUSTED_PEER)).blocked).toBe(true);
        expect((await drive(server, '203.0.113.7', UNTRUSTED_PEER)).blocked).toBe(true);

        // ...and that exhaustion is scoped to that peer: a different untrusted peer
        // is a different client in both, so the spoof-proofing is not a global lock.
        expect((await drive(junctions, '203.0.113.7', '100.64.0.10')).blocked).toBe(false);
        expect((await drive(server, '203.0.113.7', '100.64.0.10')).blocked).toBe(false);
    });
});
