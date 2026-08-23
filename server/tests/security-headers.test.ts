// @vitest-environment node
// Covers the secureHeaders middleware + the NODE_ENV-gated CORS allowlist.
// The test helper loads .env (NODE_ENV=production), so the shared `app` under
// test exercises the production code path: localhost dev origins are excluded.
// The non-production describe below constructs a fresh createApp after stubbing
// NODE_ENV so the localhost allowlist is actually exercised (finding #7928).
import { describe, test, expect, beforeAll } from 'vitest';
import type { Hono } from 'hono';
import { app, db } from './helpers.js';
import { createApp } from '../src/app.js';

describe('security headers', () => {
  test('locked-down CSP + framing/sniff/referrer headers on responses', async () => {
    const res = await app.request('/api/health');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('CORS origin allowlist (production gate)', () => {
  test('allows the deployed frontend origin', async () => {
    const res = await app.request('/api/health', {
      headers: { Origin: 'https://mase.fi' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mase.fi');
  });

  test('rejects localhost dev origins in production', async () => {
    const res = await app.request('/api/health', {
      headers: { Origin: 'http://localhost:8080' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('http://localhost:8080');
  });

  test('preflight Allow-Headers is the explicit list, not the request header (finding #7896)', async () => {
    // Empty/default allowHeaders used to parse Access-Control-Request-Headers
    // with a quadratic regex (CVE-2026-69207). An explicit list skips that path
    // and must never echo attacker-supplied names.
    const res = await app.request('/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mase.fi',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': `authorization,content-type,${' '.repeat(2000)}x-evil`,
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    const names = allowed.split(',').map((s) => s.trim()).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-account-token']));
    expect(names).not.toContain('x-evil');
    expect(allowed).not.toMatch(/ {8}/);
  });
});

describe('CORS origin allowlist (non-production, finding #7928)', () => {
  let devApp: Hono;

  // createApp reads NODE_ENV at construction time. Stub it, build a fresh app,
  // then restore so later files still see the .env production value.
  beforeAll(() => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      devApp = createApp(db);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  test.each(['http://localhost:8080', 'http://localhost:9755'])(
    'allows %s',
    async (origin) => {
      const res = await devApp.request('/api/health', {
        headers: { Origin: origin },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    },
  );

  test('still allows the deployed frontend origin', async () => {
    const res = await devApp.request('/api/health', {
      headers: { Origin: 'https://mase.fi' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://mase.fi');
  });
});
