// Unit tests for trusted-proxy client IP extraction (audit finding #1342, #10094).
import { describe, it, expect, afterEach } from 'vitest';
import { Hono, type Context } from 'hono';
import {
  PROXY_SOCKET_FLAG,
  clientIp,
  clientIpForStorage,
  isPlausibleIp,
  isTrustedProxy,
  peerAddress,
} from './client-ip.js';

function appWith(handler: (c: Context) => Response) {
  const app = new Hono();
  app.get('/', (c) => handler(c));
  return app;
}

// nginx over /run/wander-api.sock: index.ts sets the flag, and a unix peer has
// no remoteAddress.
const PROXY_SOCKET_ENV = { [PROXY_SOCKET_FLAG]: true };
// Any local uid connecting to loopback TCP — never trusted (finding #10094).
const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const PUBLIC_ENV = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };

afterEach(() => {
  delete process.env.TRUSTED_PROXIES;
});

describe('isPlausibleIp', () => {
  it('accepts IPv4 and IPv6 literals', () => {
    expect(isPlausibleIp('203.0.113.5')).toBe(true);
    expect(isPlausibleIp('::1')).toBe(true);
    expect(isPlausibleIp('2001:db8::1')).toBe(true);
  });

  it('rejects empty, oversized, or non-IP strings', () => {
    expect(isPlausibleIp('')).toBe(false);
    expect(isPlausibleIp('not an ip')).toBe(false);
    expect(isPlausibleIp('x'.repeat(46))).toBe(false);
    expect(isPlausibleIp('1.2.3.4; DROP TABLE')).toBe(false);
  });
});

describe('isTrustedProxy', () => {
  it('trusts no TCP peer by default — loopback included (finding #10094)', () => {
    expect(isTrustedProxy('127.0.0.1')).toBe(false);
    expect(isTrustedProxy('::1')).toBe(false);
    expect(isTrustedProxy('::ffff:127.0.0.1')).toBe(false);
    expect(isTrustedProxy('203.0.113.1')).toBe(false);
  });

  it('honours TRUSTED_PROXIES override', () => {
    process.env.TRUSTED_PROXIES = '10.0.0.1, 10.0.0.2';
    expect(isTrustedProxy('10.0.0.1')).toBe(true);
    expect(isTrustedProxy('10.0.0.2')).toBe(true);
    expect(isTrustedProxy('127.0.0.1')).toBe(false);
  });
});

describe('clientIp', () => {
  it('uses the last XFF hop when the peer is a trusted proxy (finding #7895)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '  198.51.100.7 , 10.0.0.1' } },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('10.0.0.1');
  });

  it('buckets an IPv6 client by /64 and leaves an IPv4-mapped address whole (finding #11552)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const v6 = await app.request(
      '/',
      { headers: { 'x-real-ip': '2001:0db8:0000:0001::1' } },
      PROXY_SOCKET_ENV
    );
    expect(await v6.text()).toBe('2001:db8:0:1::/64');
    const mapped = await app.request(
      '/',
      { headers: { 'x-real-ip': '::ffff:203.0.113.9' } },
      PROXY_SOCKET_ENV
    );
    expect(await mapped.text()).toBe('::ffff:203.0.113.9');
    const hexMapped = await app.request(
      '/',
      { headers: { 'x-real-ip': '0:0:0:0:0:ffff:c000:201' } },
      PROXY_SOCKET_ENV
    );
    expect(await hexMapped.text()).toBe('0:0:0:0:0:ffff:c000:201');
  });

  it('prefers X-Real-IP over a spoofable XFF chain (finding #7895)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      {
        headers: {
          'x-real-ip': '203.0.113.9',
          'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        },
      },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('keys a proxy-socket request with no forwarding headers on one shared bucket', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request('/', {}, PROXY_SOCKET_ENV);
    expect(await res.text()).toBe('unknown');
  });

  it('ignores X-Real-IP / XFF from a loopback peer — any local uid (finding #10094)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    for (const fresh of ['198.51.100.1', '198.51.100.2']) {
      const res = await app.request(
        '/',
        { headers: { 'x-real-ip': fresh, 'x-forwarded-for': fresh } },
        LOOPBACK_ENV
      );
      expect(await res.text()).toBe('127.0.0.1');
    }
  });

  it('only trusts the proxy-socket flag when it is exactly true', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      { headers: { 'x-real-ip': '198.51.100.3' } },
      { [PROXY_SOCKET_FLAG]: 'true' }
    );
    expect(await res.text()).toBe('unknown');
  });

  it('honours forwarding headers from a TRUSTED_PROXIES peer', async () => {
    process.env.TRUSTED_PROXIES = '203.0.113.9';
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request('/', { headers: { 'x-real-ip': '198.51.100.4' } }, PUBLIC_ENV);
    expect(await res.text()).toBe('198.51.100.4');
  });

  it('ignores XFF and X-Real-IP from an untrusted peer (spoof bypass)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      {
        headers: {
          'x-real-ip': '1.2.3.4',
          'x-forwarded-for': '1.2.3.4',
        },
      },
      PUBLIC_ENV
    );
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('returns unknown when there is no peer and no trusted path (app.request harness)', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    // Even with a client-supplied XFF — no peer means we cannot trust it.
    const res = await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } });
    expect(await res.text()).toBe('unknown');
  });

  it('ignores implausible XFF values from a trusted proxy', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': 'not a real ip!!!' } },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('unknown');
  });

  it('ignores an implausible last XFF hop rather than walking left into a spoof', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '198.51.100.7, not-an-ip' } },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('unknown');
  });
});

describe('clientIpForStorage', () => {
  it('records the full IPv6 address, not the rate-limit /64 (finding #11552)', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request(
      '/',
      { headers: { 'x-real-ip': '2001:db8:0:1::1' } },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('2001:db8:0:1::1');
  });

  it('records the trusted-proxy last XFF hop', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '203.0.113.5' } },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('203.0.113.5');
  });

  it('records X-Real-IP over a spoofed XFF first hop (finding #7895)', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request(
      '/',
      {
        headers: {
          'x-real-ip': '203.0.113.9',
          'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        },
      },
      PROXY_SOCKET_ENV
    );
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('returns null without forwarding headers even behind a trusted proxy', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request('/', {}, PROXY_SOCKET_ENV);
    expect(await res.text()).toBe('null');
  });

  it('returns null for a loopback peer — any local uid (finding #10094)', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request('/', { headers: { 'x-real-ip': '1.2.3.4' } }, LOOPBACK_ENV);
    expect(await res.text()).toBe('null');
  });

  it('returns null for untrusted peers (do not plant client-supplied XFF)', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '1.2.3.4' } },
      PUBLIC_ENV
    );
    expect(await res.text()).toBe('null');
  });

  it('returns null when the harness has no peer', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request('/', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(await res.text()).toBe('null');
  });
});

describe('peerAddress', () => {
  it('reads c.env.incoming.socket.remoteAddress', async () => {
    const app = appWith((c) => new Response(String(peerAddress(c))));
    const res = await app.request('/', {}, LOOPBACK_ENV);
    expect(await res.text()).toBe('127.0.0.1');
  });
});
