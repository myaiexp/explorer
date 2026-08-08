// Client IP extraction for rate limits + account ipFirstSeen.
//
// Trust X-Forwarded-For only when the TCP peer is a known reverse proxy
// (nginx on loopback). Untrusted peers — direct access, misconfigured
// firewall, SSRF — can set XFF arbitrarily; ignoring it there keeps the
// IP rate-limit buckets and ipFirstSeen column honest.

import type { Context } from 'hono';

// Default: nginx (and anything else) that terminates TLS on this host and
// proxies to 127.0.0.1:3700. Override with TRUSTED_PROXIES=ip,ip for other
// topologies (comma-separated).
const DEFAULT_TRUSTED = ['127.0.0.1', '::1', '::ffff:127.0.0.1'] as const;

// inet-column / rate-limit key hygiene — refuse garbage that isn't a plausible
// IPv4/IPv6 literal (Postgres `inet` would reject it on insert anyway, but the
// rate-limit map should never key on multi-KB attacker strings either).
const MAX_IP_LEN = 45; // max textual IPv6
const IP_CHARS = /^[0-9a-fA-F:.]+$/;

function trustedProxies(): ReadonlySet<string> {
  const raw = process.env.TRUSTED_PROXIES;
  if (raw && raw.trim()) {
    return new Set(
      raw
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
    );
  }
  return new Set(DEFAULT_TRUSTED);
}

export function isTrustedProxy(ip: string): boolean {
  return trustedProxies().has(ip);
}

export function isPlausibleIp(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IP_LEN && IP_CHARS.test(value);
}

// @hono/node-server exposes the raw Node IncomingMessage on c.env.incoming.
export function peerAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress;
  return typeof peer === 'string' && peer.length > 0 ? peer : undefined;
}

function firstXffHop(c: Context): string | undefined {
  const raw = c.req.header('x-forwarded-for');
  if (!raw) return undefined;
  const first = raw.split(',')[0]?.trim();
  if (!first || !isPlausibleIp(first)) return undefined;
  return first;
}

/**
 * Rate-limit / bucket key. Prefer the client hop from XFF when the peer is a
 * trusted proxy; otherwise use the peer itself and never honor client XFF.
 * Falls back to 'unknown' when neither is available (e.g. app.request() harness
 * without an injected env).
 */
export function clientIp(c: Context): string {
  const peer = peerAddress(c);
  if (peer && isTrustedProxy(peer)) {
    return firstXffHop(c) ?? peer;
  }
  if (peer) return peer;
  return 'unknown';
}

/**
 * Value for accounts.ipFirstSeen. Only records a client IP when it comes from
 * a trusted-proxy XFF hop (the real visitor behind nginx). Direct/untrusted
 * peers are not written — ipFirstSeen is abuse-forensics for the public edge,
 * not a dump of every local socket address. Missing/untrusted → null.
 */
export function clientIpForStorage(c: Context): string | null {
  const peer = peerAddress(c);
  if (peer && isTrustedProxy(peer)) {
    return firstXffHop(c) ?? null;
  }
  return null;
}
