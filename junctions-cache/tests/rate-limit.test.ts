// @vitest-environment node
// Tests for junctions-cache/src/rate-limit.ts — the per-IP token-bucket limiter
// (audit: /junctions and /logs had no app-level rate limiting). Driven through a
// throwaway Hono app so the middleware is exercised exactly as wired in app.ts;
// the client IP is supplied via X-Forwarded-For behind a simulated trusted proxy.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { ipRateLimit } from '../src/rate-limit.js';

// nginx on loopback — required for XFF to be trusted (audit #1342).
const PROXY_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

function appWith(limit: number, windowMs?: number) {
    const app = new Hono();
    app.get('/x', ipRateLimit(limit, windowMs), c => c.text('ok'));
    return app;
}

function reqFrom(app: Hono, ip: string) {
    return app.request('/x', { headers: { 'x-forwarded-for': ip } }, PROXY_ENV);
}

afterEach(() => {
    vi.useRealTimers();
});

describe('ipRateLimit', () => {
    test('allows up to `limit` requests then 429s with a Retry-After header', async () => {
        const app = appWith(3);
        for (let i = 0; i < 3; i++) {
            expect((await reqFrom(app, '1.2.3.4')).status).toBe(200);
        }
        const blocked = await reqFrom(app, '1.2.3.4');
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get('Retry-After')).toBeTruthy();
        expect(await blocked.json()).toEqual({ error: 'Rate limit exceeded' });
    });

    test('budgets are per-IP — one client exhausting its bucket does not block another', async () => {
        const app = appWith(1);
        expect((await reqFrom(app, '10.0.0.1')).status).toBe(200);
        expect((await reqFrom(app, '10.0.0.1')).status).toBe(429); // 10.0.0.1 exhausted
        expect((await reqFrom(app, '10.0.0.2')).status).toBe(200); // 10.0.0.2 untouched
    });

    test('reads only the first X-Forwarded-For hop (the client) as the key', async () => {
        const app = appWith(1);
        // "client, proxy1, proxy2" — the client is the first entry.
        const h = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' };
        expect((await app.request('/x', { headers: h }, PROXY_ENV)).status).toBe(200);
        expect((await app.request('/x', { headers: h }, PROXY_ENV)).status).toBe(429);
        // A different client hop behind the same proxies is independent.
        const h2 = { 'x-forwarded-for': '203.0.113.8, 10.0.0.1, 10.0.0.2' };
        expect((await app.request('/x', { headers: h2 }, PROXY_ENV)).status).toBe(200);
    });

    test('ignores X-Forwarded-For from an untrusted peer', async () => {
        const app = appWith(1);
        const untrusted = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };
        // Rotating XFF must not mint a fresh bucket — key is the peer.
        expect(
            (await app.request('/x', { headers: { 'x-forwarded-for': '1.1.1.1' } }, untrusted)).status
        ).toBe(200);
        expect(
            (await app.request('/x', { headers: { 'x-forwarded-for': '2.2.2.2' } }, untrusted)).status
        ).toBe(429);
    });

    test('tokens refill over the window — a blocked client recovers after one full window', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const app = appWith(2, 60_000);

        expect((await reqFrom(app, '9.9.9.9')).status).toBe(200); // 2 -> 1
        expect((await reqFrom(app, '9.9.9.9')).status).toBe(200); // 1 -> 0
        expect((await reqFrom(app, '9.9.9.9')).status).toBe(429); // empty

        vi.advanceTimersByTime(60_000); // a full window refills the bucket to the cap
        expect((await reqFrom(app, '9.9.9.9')).status).toBe(200);
    });
});
