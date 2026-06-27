// Per-bucket cap + window-refill coverage for sectionWriteRateLimit (audit #1568)
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import {
  sectionWriteRateLimit,
  resetRateLimiter,
  sweepStaleBuckets,
} from '../src/middleware/rate-limit.js';

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

describe('token-bucket smoothing — no double-rate burst at the window boundary', () => {
  // The exact finding scenario: drain the bucket at T≈59s, then at T=60s the old
  // fixed-window code would grant a full 60-token reset → 120 reqs in <2s. A token
  // bucket only accrues limit/window per ms, so the boundary grants ~1 token, not 60.
  test('draining at T=59s then crossing T=60s grants ~1 token, not a full reset', async () => {
    vi.useFakeTimers();
    try {
      const username = 'burst';
      const ip = '203.0.113.200';

      // Reach T=59s with the bucket untouched (refill caps at the limit, so it is
      // still full), then drain all 60 tokens.
      vi.advanceTimersByTime(59_000);
      let drained = 0;
      for (let i = 0; i < 60; i++) {
        if ((await write(username, ip)).status === 204) drained++;
      }
      expect(drained).toBe(60);
      expect((await write(username, ip)).status).toBe(429);

      // Cross the fixed-window boundary (1s later). A fixed window would reset to
      // 60; the token bucket has accrued exactly 1 token.
      vi.advanceTimersByTime(1_000);
      let burst = 0;
      for (let i = 0; i < 60; i++) {
        if ((await write(username, ip)).status === 204) burst++;
      }
      expect(burst).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('tokens accrue proportionally — half a window refills ~half the limit', async () => {
    vi.useFakeTimers();
    try {
      const username = 'proportional';
      const ip = '203.0.113.201';

      // Drain the 60/username bucket.
      for (let i = 0; i < 60; i++) {
        expect((await write(username, ip)).status).toBe(204);
      }
      expect((await write(username, ip)).status).toBe(429);

      // Half the window → ~30 tokens back, so exactly 30 writes pass then 429.
      vi.advanceTimersByTime(WINDOW_MS / 2);
      let allowed = 0;
      for (let i = 0; i < 60; i++) {
        if ((await write(username, ip)).status === 204) allowed++;
      }
      expect(allowed).toBe(30);
      expect((await write(username, ip)).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sweepStaleBuckets — bounded memory', () => {
  test('evicts buckets idle past 2× their window, keeps recent ones', async () => {
    vi.useFakeTimers();
    try {
      // The fake clock starts at the real time, so anchor staleness to t0.
      const t0 = Date.now();
      // One key creates entries in both the username and IP write maps.
      await write('staleuser', '203.0.113.10');
      await write('staleuser', '203.0.113.10');

      // Just under 2× the 60s window → nothing is stale yet.
      expect(sweepStaleBuckets(t0 + 2 * WINDOW_MS - 1)).toBe(0);

      // At/after 2× the window the username + IP buckets are fully refilled and
      // therefore safe to drop: 1 username entry + 1 IP entry = 2 removed.
      expect(sweepStaleBuckets(t0 + 2 * WINDOW_MS)).toBe(2);
      expect(sweepStaleBuckets(t0 + 2 * WINDOW_MS)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('hard cap evicts the least-recently-active survivors', async () => {
    vi.useFakeTimers();
    try {
      // Seed three distinct username buckets from one shared IP at increasing
      // timestamps so the oldest username is unambiguous and the IP map holds a
      // single (under-cap) entry.
      const t0 = Date.now();
      const ip = '203.0.113.20';
      await write('cap-a', ip);
      vi.advanceTimersByTime(1_000);
      await write('cap-b', ip);
      vi.advanceTimersByTime(1_000);
      await write('cap-c', ip);

      // Cap each map at 2 entries (now=current, so nothing is stale): the username
      // map has 3 → drops the single oldest (cap-a). The IP write map holds 1
      // entry, under the cap, so it is untouched. Total removed = 1.
      expect(sweepStaleBuckets(t0 + 2_000, 2)).toBe(1);

      // A fresh write for the evicted key starts a brand-new full bucket: it and
      // 59 more pass before the 60/username cap trips again.
      let allowed = 0;
      for (let i = 0; i < 61; i++) {
        if ((await write('cap-a', ip)).status === 204) allowed++;
      }
      expect(allowed).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });
});
