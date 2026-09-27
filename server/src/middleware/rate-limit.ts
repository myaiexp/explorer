// Token-bucket rate limiting with bounded, self-evicting buckets.
//
// TWIN: junctions-cache/src/rate-limit.ts carries the same token-bucket core.
// Deliberately independent — separate deployables on separate boxes (that ships
// to shelly, this to the VPS), each with its own lockfile / `--frozen-lockfile`
// deploy / per-package `tsc` rootDir, so there is no workspace to share through.
// MIRROR any fix to the shared core in BOTH files: the Bucket shape, refill()'s
// continuous accrual (incl. the no-double-rate-burst property), the forwarding-
// header parsing (X-Real-IP, then the last XFF hop), the Retry-After deficit
// math, the idle-≥-2-windows staleness rule, and the cap on insert (evict stale,
// then refuse the new key). Do NOT sync the per-service policy: MAX_BUCKETS (50k
// here vs 10k there), the extra periodic sweeper here, module-level maps +
// REGISTRY here vs factory-owned maps there, and how a request earns trust for
// its forwarding headers — the /run/wander-api.sock listener here (loopback is
// NOT trusted, finding #10094) vs the TRUSTED_PROXIES peer list there.
import type { Context, Next } from 'hono';
import { clientIp } from '../lib/client-ip.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// Window lengths, hoisted so the middlewares and the sweeper agree on them.
const MINUTE = 60_000;
const HOUR = 3_600_000;

const usernameBuckets = new Map<string, Bucket>();
const ipWriteBuckets = new Map<string, Bucket>();
const ipAccountBuckets = new Map<string, Bucket>();
const ipReadBuckets = new Map<string, Bucket>();

// Pairs each bucket map with the window it is consumed under, so the sweeper
// can decide staleness per map (a bucket idle ≥ its window is fully refilled
// and therefore indistinguishable from a never-seen key).
const REGISTRY: ReadonlyArray<{ buckets: Map<string, Bucket>; windowMs: number }> = [
  { buckets: usernameBuckets, windowMs: MINUTE },
  { buckets: ipWriteBuckets, windowMs: MINUTE },
  { buckets: ipReadBuckets, windowMs: MINUTE },
  { buckets: ipAccountBuckets, windowMs: HOUR },
];

// Hard ceiling per map. Far above any realistic active-client count for a
// 1–2 minute window, but bounds heap under a many-address flood. Enforced on
// insert by consume() and again by the sweeper.
const MAX_BUCKETS = 50_000;

// The active ceiling. Only tests lower it, through resetRateLimiter().
let maxBuckets = MAX_BUCKETS;

export function resetRateLimiter(cap = MAX_BUCKETS): void {
  usernameBuckets.clear();
  ipWriteBuckets.clear();
  ipAccountBuckets.clear();
  ipReadBuckets.clear();
  maxBuckets = cap;
}

// Drop buckets idle ≥ 2 windows — fully refilled, so indistinguishable from a
// never-seen key. Returns how many were removed.
function evictStale(buckets: Map<string, Bucket>, windowMs: number, now: number): number {
  const cutoff = windowMs * 2;
  let removed = 0;
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill >= cutoff) {
      buckets.delete(key);
      removed++;
    }
  }
  return removed;
}

// Continuously accrue tokens at limit/windowMs per ms, capped at limit. This is
// the token-bucket refill — unlike a fixed window it never grants a full reset
// at a boundary, so a client cannot drain the bucket and immediately drain it
// again (the classic double-rate burst).
function refill(bucket: Bucket, limit: number, windowMs: number, now: number): void {
  const elapsed = now - bucket.lastRefill;
  if (elapsed <= 0) return;
  bucket.tokens = Math.min(limit, bucket.tokens + (elapsed / windowMs) * limit);
  bucket.lastRefill = now;
}

function consume(
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    // Cap on insert, not only in the 5-minute sweep: a flood of fresh keys
    // would otherwise grow the map without bound between sweeps. A new key
    // that still finds the map full after stale eviction is refused rather
    // than displacing a live bucket (finding #10094).
    if (buckets.size >= maxBuckets) {
      evictStale(buckets, windowMs, now);
      if (buckets.size >= maxBuckets) return false;
    }
    bucket = { tokens: limit, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    refill(bucket, limit, windowMs, now);
  }
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

// Seconds until ≥1 token is available again. Called right after a failed
// consume(), so the bucket's tokens are current as of `now` (refill just ran).
function retryAfter(
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number
): number {
  const bucket = buckets.get(key);
  if (!bucket) return Math.ceil(windowMs / 1000);
  const deficit = 1 - bucket.tokens;
  if (deficit <= 0) return 1;
  const msNeeded = (deficit / limit) * windowMs;
  return Math.max(1, Math.ceil(msNeeded / 1000));
}

// Evict buckets idle long enough to be indistinguishable from a fresh one, then
// enforce the hard cap by dropping the least-recently-active survivors. Returns
// the number of entries removed. `cap` is injectable for testing.
export function sweepStaleBuckets(now = Date.now(), cap = maxBuckets): number {
  let removed = 0;
  for (const { buckets, windowMs } of REGISTRY) {
    removed += evictStale(buckets, windowMs, now);
    if (buckets.size > cap) {
      const oldestFirst = [...buckets.entries()].sort(
        (a, b) => a[1].lastRefill - b[1].lastRefill
      );
      const excess = buckets.size - cap;
      for (let i = 0; i < excess; i++) {
        buckets.delete(oldestFirst[i][0]);
        removed++;
      }
    }
  }
  return removed;
}

let sweepTimer: ReturnType<typeof setInterval> | undefined;

// Start periodic eviction of stale rate-limit buckets. Idempotent; the timer is
// unref'd so it never keeps the process alive. Called once from the server entry
// point (pinned by tests/bucket-sweeper.test.ts). Tests drive sweepStaleBuckets()
// directly; if a test starts the interval it must call stopBucketSweeper() so
// the timer is not left running.
export function startBucketSweeper(intervalMs = 5 * MINUTE): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => sweepStaleBuckets(), intervalMs);
  sweepTimer.unref?.();
}

// Test-facing counterpart of startBucketSweeper — clears the interval and
// resets the idempotency latch so a later start can arm a new timer.
export function stopBucketSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = undefined;
}

function limited(
  c: Context,
  buckets: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number
) {
  if (consume(buckets, key, limit, windowMs)) return null;
  const secs = retryAfter(buckets, key, limit, windowMs);
  return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(secs) });
}

/** 300 writes/min per IP. Mount BEFORE accountAuth so unauthenticated
 *  probing is bounded without touching the per-username bucket. */
export function ipWriteRateLimit() {
  return async (c: Context, next: Next) => {
    const denied = limited(c, ipWriteBuckets, clientIp(c), 300, MINUTE);
    if (denied) return denied;
    await next();
  };
}

/** 60 writes/min per username. Mount AFTER accountAuth so a missing/wrong
 *  token cannot lock the account owner out of cloud-backup writes. */
export function usernameWriteRateLimit() {
  return async (c: Context, next: Next) => {
    const username = c.req.param('username') ?? 'unknown';
    const denied = limited(c, usernameBuckets, username, 60, MINUTE);
    if (denied) return denied;
    await next();
  };
}

/** 60 reads/min per IP — throttles probing of GET /:username and DELETE /:username */
export function readRateLimit() {
  return async (c: Context, next: Next) => {
    const denied = limited(c, ipReadBuckets, clientIp(c), 60, MINUTE);
    if (denied) return denied;
    await next();
  };
}

/** 10 account creations/hour per IP */
export function accountCreationRateLimit() {
  return async (c: Context, next: Next) => {
    const denied = limited(c, ipAccountBuckets, clientIp(c), 10, HOUR);
    if (denied) return denied;
    await next();
  };
}
