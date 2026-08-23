// Unit tests for trusted-proxy client IP extraction (audit finding #1342).
import { describe, it, expect, afterEach } from 'vitest';
import { Hono, type Context } from 'hono';
import {
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
  it('trusts loopback by default', () => {
    expect(isTrustedProxy('127.0.0.1')).toBe(true);
    expect(isTrustedProxy('::1')).toBe(true);
    expect(isTrustedProxy('::ffff:127.0.0.1')).toBe(true);
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
      LOOPBACK_ENV
    );
    expect(await res.text()).toBe('10.0.0.1');
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
      LOOPBACK_ENV
    );
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('falls back to the peer when trusted proxy sends no forwarding headers', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request('/', {}, LOOPBACK_ENV);
    expect(await res.text()).toBe('127.0.0.1');
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
      LOOPBACK_ENV
    );
    expect(await res.text()).toBe('127.0.0.1');
  });

  it('ignores an implausible last XFF hop rather than walking left into a spoof', async () => {
    const app = appWith((c) => new Response(clientIp(c)));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '198.51.100.7, not-an-ip' } },
      LOOPBACK_ENV
    );
    expect(await res.text()).toBe('127.0.0.1');
  });
});

describe('clientIpForStorage', () => {
  it('records the trusted-proxy last XFF hop', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request(
      '/',
      { headers: { 'x-forwarded-for': '203.0.113.5' } },
      LOOPBACK_ENV
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
      LOOPBACK_ENV
    );
    expect(await res.text()).toBe('203.0.113.9');
  });

  it('returns null without forwarding headers even behind a trusted proxy', async () => {
    const app = appWith((c) => new Response(String(clientIpForStorage(c))));
    const res = await app.request('/', {}, LOOPBACK_ENV);
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
