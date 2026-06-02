// Per-bucket cap + window-refill coverage for sectionWriteRateLimit (audit #1568)
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { sectionWriteRateLimit, resetRateLimiter } from '../src/middleware/rate-limit.js';

// Thin harness: mount the real middleware on a no-op 204 handler so the bucket
// logic is exercised directly — no DB, no account-creation rate limit, and fake
// timers stay clear of the pg pool. IP comes from x-forwarded-for (see getIp),
// the username from the path param (read inside the middleware, as in sections.ts).
const app = new Hono();
app.put('/:username/write', sectionWriteRateLimit(), (c) => c.body(null, 204));

const WINDOW_MS = 60_000;

function write(username: string, ip: string): Promise<Response> {
  return app.request(`/${username}/write`, {
    method: 'PUT',
    headers: { 'x-forwarded-for': ip },
  });
}

beforeEach(() => {
  resetRateLimiter();
});

describe('sectionWriteRateLimit — IP write bucket (300/min)', () => {
  test('300 writes from one IP across distinct usernames all pass; 301st is 429 with Retry-After', async () => {
    const ip = '203.0.113.7';

    // Distinct username per write → each username bucket consumes a single token,
    // so the 60/username cap never trips and the 300/IP cap is the sole limiter.
    for (let i = 0; i < 300; i++) {
      const res = await write(`ipuser-${i}`, ip);
      expect(res.status).toBe(204);
    }

    // 301st request from the same IP (fresh username) — IP bucket is drained.
    const res = await write('ipuser-300', ip);
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test('IP write bucket refills after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const ip = '192.0.2.55';

      // Drain the IP bucket (distinct usernames so the username cap never trips first).
      let drainedAfter = 0;
      for (let i = 0; i < 400; i++) {
        const res = await write(`ipref-${i}`, ip);
        if (res.status === 429) {
          drainedAfter = i;
          break;
        }
      }
      expect(drainedAfter).toBeGreaterThan(0);

      // Still limited within the same window.
      expect((await write('ipref-blocked', ip)).status).toBe(429);

      // Advance past the window → bucket refills → next write passes.
      vi.advanceTimersByTime(WINDOW_MS);
      expect((await write('ipref-after', ip)).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sectionWriteRateLimit — per-username bucket (60/min)', () => {
  test('per-username bucket refills after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const username = 'refilluser';
      const ip = '198.51.100.4';

      // Exhaust the 60/username bucket (62 total writes stay well under the 300/IP cap).
      for (let i = 0; i < 60; i++) {
        expect((await write(username, ip)).status).toBe(204);
      }

      // 61st within the same window → username bucket empty → 429.
      expect((await write(username, ip)).status).toBe(429);

      // Advance past the window → bucket refills → next write passes.
      vi.advanceTimersByTime(WINDOW_MS);
      expect((await write(username, ip)).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }
  });
});
