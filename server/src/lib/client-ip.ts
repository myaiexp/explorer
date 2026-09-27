// Client IP extraction for rate limits + account ipFirstSeen.
//
// Trust forwarding headers only on a connection that provably came from the
// reverse proxy. Anyone else — another local uid, a misconfigured firewall,
// SSRF — can set XFF / X-Real-IP arbitrarily; ignoring them there keeps the
// IP rate-limit buckets and ipFirstSeen column honest.
//
// In production that proof is the listener: wander-api.socket hands the
// service /run/wander-api.sock, 0660 root:www-data, so only nginx can connect,
// and index.ts marks every request accepted there with PROXY_SOCKET_FLAG.
// Loopback TCP is deliberately NOT trusted: every uid on the box can reach
// 127.0.0.1, and trusting it let any of them mint a fresh rate-limit key per
// request with X-Real-IP (finding #10094).
//
// Behind a trusted proxy, prefer X-Real-IP (nginx overwrites it with
// $remote_addr) then the *last* X-Forwarded-For hop (the address nginx
// appended). The leftmost XFF hops are client-supplied and must not key
// buckets or ipFirstSeen (finding #7895).

import type { Context } from 'hono';

// c.env key index.ts sets to `true` on requests accepted on the proxy socket.
// Tests inject it through app.request()'s env argument to simulate nginx.
export const PROXY_SOCKET_FLAG = 'viaProxySocket';

// TCP peers whose forwarding headers are honoured. Empty by default — the
// proxy socket is the production path. TRUSTED_PROXIES=ip,ip opts a remote
// proxy in for other topologies (comma-separated).
const DEFAULT_TRUSTED: readonly string[] = [];

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

// Strict `=== true`: only index.ts sets the flag, and nothing a client sends
// can reach c.env.
function viaProxySocket(c: Context): boolean {
  const env = c.env as Record<string, unknown> | undefined;
  return env?.[PROXY_SOCKET_FLAG] === true;
}

function fromTrustedProxy(c: Context, peer: string | undefined): boolean {
  if (viaProxySocket(c)) return true;
  return peer !== undefined && isTrustedProxy(peer);
}

function lastXffHop(c: Context): string | undefined {
  const raw = c.req.header('x-forwarded-for');
  if (!raw) return undefined;
  const hops = raw.split(',');
  const last = hops[hops.length - 1]?.trim();
  if (!last || !isPlausibleIp(last)) return undefined;
  return last;
}

// nginx sets X-Real-IP to $remote_addr (the connecting client). Fall back to
// the last XFF hop when a proxy only forwards X-Forwarded-For. Never walk
// left into a spoofed first hop if the last hop is garbage.
function forwardedClientIp(c: Context): string | undefined {
  const real = c.req.header('x-real-ip')?.trim();
  if (real && isPlausibleIp(real)) return real;
  return lastXffHop(c);
}

/**
 * Rate-limit / bucket key. Prefer the nginx-overwritten client address when
 * the request came through a trusted proxy; otherwise use the TCP peer itself
 * and never honor client forwarding headers. Falls back to 'unknown' when
 * neither is available — a proxy-socket request with no forwarding header
 * (unix peers have no address), or the app.request() harness with no env —
 * so those share one bucket rather than each getting a fresh one.
 */
export function clientIp(c: Context): string {
  const peer = peerAddress(c);
  if (fromTrustedProxy(c, peer)) {
    return forwardedClientIp(c) ?? peer ?? 'unknown';
  }
  return peer ?? 'unknown';
}

/**
 * Value for accounts.ipFirstSeen. Only records a client IP when it comes from
 * a trusted-proxy forwarding header (the real visitor behind nginx). Direct/
 * untrusted peers are not written — ipFirstSeen is abuse-forensics for the
 * public edge, not a dump of every local socket address. Missing/untrusted → null.
 */
export function clientIpForStorage(c: Context): string | null {
  if (fromTrustedProxy(c, peerAddress(c))) {
    return forwardedClientIp(c) ?? null;
  }
  return null;
}
