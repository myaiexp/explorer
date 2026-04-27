import type { Context, Next } from 'hono';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const usernameBuckets = new Map<string, Bucket>();
const ipWriteBuckets = new Map<string, Bucket>();
const ipAccountBuckets = new Map<string, Bucket>();

export function resetRateLimiter(): void {
  usernameBuckets.clear();
  ipWriteBuckets.clear();
  ipAccountBuckets.clear();
}

function getIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((c.env as any)?.incoming?.socket?.remoteAddress as string | undefined) ??
    'unknown'
  );
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
    bucket = { tokens: limit, lastRefill: now };
    buckets.set(key, bucket);
  }
  // refill if window elapsed
  if (now - bucket.lastRefill >= windowMs) {
    bucket.tokens = limit;
    bucket.lastRefill = now;
  }
  if (bucket.tokens <= 0) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

function retryAfter(
  buckets: Map<string, Bucket>,
  key: string,
  windowMs: number
): number {
  const bucket = buckets.get(key);
  if (!bucket) return Math.ceil(windowMs / 1000);
  const elapsed = Date.now() - bucket.lastRefill;
  return Math.ceil((windowMs - elapsed) / 1000);
}

/** 60 writes/min per username param + 300 writes/min per IP */
export function sectionWriteRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getIp(c);
    const username = c.req.param('username') ?? 'unknown';
    const WINDOW = 60_000;

    if (!consume(usernameBuckets, username, 60, WINDOW)) {
      const secs = retryAfter(usernameBuckets, username, WINDOW);
      return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(secs) });
    }
    if (!consume(ipWriteBuckets, ip, 300, WINDOW)) {
      const secs = retryAfter(ipWriteBuckets, ip, WINDOW);
      return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(secs) });
    }
    await next();
  };
}

/** 10 account creations/hour per IP */
export function accountCreationRateLimit() {
  return async (c: Context, next: Next) => {
    const ip = getIp(c);
    const WINDOW = 3_600_000;

    if (!consume(ipAccountBuckets, ip, 10, WINDOW)) {
      const secs = retryAfter(ipAccountBuckets, ip, WINDOW);
      return c.json({ error: 'Rate limit exceeded' }, 429, { 'Retry-After': String(secs) });
    }
    await next();
  };
}
