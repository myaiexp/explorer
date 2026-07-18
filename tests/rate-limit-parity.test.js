// @vitest-environment node
/**
 * Drift guard for the token-bucket rate-limiter core that exists in two
 * independent deployables:
 *   - server/src/middleware/rate-limit.ts     (VPS explorer-api)
 *   - junctions-cache/src/rate-limit.ts        (shelly microservice)
 *
 * Both files carry reciprocal TWIN comments spelling out which parts MUST stay
 * behaviourally identical: the Bucket shape, refill()'s continuous accrual (incl.
 * the no-double-rate-burst property), the X-Forwarded-For-first client-IP
 * extraction, and the Retry-After deficit math. There is no shared package to
 * enforce this (separate lockfiles, separate boxes), so this test is the
 * enforcement — the sibling of tests/overpass-exclude-parity.test.js.
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

// Minimal Hono-Context stand-in exposing exactly what the two limiters touch:
// c.req.header('x-forwarded-for'), c.req.param(), c.env, and c.json(body, status,
// headers). Captures the c.json() call so the caller can read status + headers.
function makeCtx(xff) {
    let jsonCall = null;
    const c = {
        req: {
            header: (name) => (name.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
            param: () => 'unknown',
        },
        env: {},
        json: (body, status, headers) => {
            jsonCall = { body, status: status ?? 200, headers: headers ?? {} };
            return jsonCall;
        },
    };
    return { c, getJsonCall: () => jsonCall };
}

// Run one request through a middleware and normalize the outcome to
// { blocked, retryAfter } — blocked iff the middleware 429'd instead of next().
async function drive(mw, xff) {
    const { c, getJsonCall } = makeCtx(xff);
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

    test('client-IP extraction keys on the FIRST X-Forwarded-For hop in both', async () => {
        const { junctions, server } = makePair();

        // Exhaust each limiter using a multi-hop XFF whose first hop is 1.2.3.4.
        for (let i = 0; i < 60; i++) {
            await drive(junctions, '1.2.3.4, 5.6.7.8');
            await drive(server, '1.2.3.4, 9.9.9.9');
        }

        // A request with the SAME first hop (different trailing hops) shares the
        // exhausted bucket → blocked in both. If either read a different XFF
        // position, this would be a fresh bucket and pass.
        expect((await drive(junctions, '1.2.3.4, 42.42.42.42')).blocked).toBe(true);
        expect((await drive(server, '1.2.3.4, 42.42.42.42')).blocked).toBe(true);

        // A request whose FIRST hop differs is a distinct client → allowed in both.
        expect((await drive(junctions, '7.7.7.7, 1.2.3.4')).blocked).toBe(false);
        expect((await drive(server, '7.7.7.7, 1.2.3.4')).blocked).toBe(false);
    });
});
