// Pins that the API process starts the rate-limit bucket sweeper, and that
// startBucketSweeper actually ticks sweepStaleBuckets (finding #7925).
// Tests keep calling sweepStaleBuckets() directly; the one case that starts
// the interval stops it afterwards so it is not left running.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import {
  ipWriteRateLimit,
  usernameWriteRateLimit,
  resetRateLimiter,
  sweepStaleBuckets,
  startBucketSweeper,
  stopBucketSweeper,
} from '../src/middleware/rate-limit.js';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
  'utf8',
);

describe('server bootstrap starts the rate-limit bucket sweeper (finding #7925)', () => {
  test('index.ts imports and calls startBucketSweeper', () => {
    expect(src).toMatch(
      /import\s*\{\s*startBucketSweeper\s*\}\s*from\s*['"]\.\/middleware\/rate-limit\.js['"]/,
    );
    expect(src).toMatch(/^startBucketSweeper\(\);$/m);
  });
});

const WINDOW_MS = 60_000;
const app = new Hono();
app.put(
  '/:username/write',
  ipWriteRateLimit(),
  usernameWriteRateLimit(),
  (c) => c.body(null, 204),
);
const PROXY_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

function write(username: string, ip: string): Promise<Response> {
  return app.request(
    `/${username}/write`,
    { method: 'PUT', headers: { 'x-forwarded-for': ip } },
    PROXY_ENV,
  );
}

describe('startBucketSweeper', () => {
  beforeEach(() => {
    resetRateLimiter();
    stopBucketSweeper();
  });

  afterEach(() => {
    stopBucketSweeper();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('default interval is 5 minutes, unref\'d, and a second call is a no-op', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    startBucketSweeper();
    startBucketSweeper();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 5 * 60_000);
    expect(unref).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test('interval callback runs sweepStaleBuckets', async () => {
    vi.useFakeTimers();
    await write('staleuser', '203.0.113.10');

    startBucketSweeper(WINDOW_MS);
    vi.advanceTimersByTime(2 * WINDOW_MS);

    // Sweeper already dropped the idle username + IP buckets; a follow-up
    // sweep finds nothing left.
    expect(sweepStaleBuckets()).toBe(0);
  });
});
