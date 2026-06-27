// @vitest-environment node
// Covers the secureHeaders middleware + the NODE_ENV-gated CORS allowlist.
// The test helper loads .env (NODE_ENV=production), so the app under test
// exercises the production code path: localhost dev origins are excluded.
import { describe, test, expect } from 'vitest';
import { app } from './helpers.js';

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
});
