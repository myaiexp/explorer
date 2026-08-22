import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  app,
  truncateAll,
  createTestAccount,
  VISIT_BODY,
  resetRateLimiter,
  authHeaders,
  TRUSTED_PROXY_ENV,
} from './helpers.js';

beforeEach(async () => {
  // Freeze Date so the token-bucket refill can't grant a token mid-test. These
  // tests fire 60+ real DB-backed requests, which under a loaded serial run
  // (fileParallelism:false) can exceed the ~1s that refills a 60/min bucket and
  // let the request-that-should-429 slip through. Only Date is faked — real
  // timers stay live so pg/hono async I/O is unaffected.
  vi.useFakeTimers({ toFake: ['Date'] });
  await truncateAll();
  resetRateLimiter();
});

afterEach(() => {
  vi.useRealTimers();
});

const visitPayload = (id: string) => JSON.stringify({
  id,
  date: VISIT_BODY.date,
  startLat: VISIT_BODY.startLat,
  startLng: VISIT_BODY.startLng,
  destLat: VISIT_BODY.destLat,
  destLng: VISIT_BODY.destLng,
  distance: VISIT_BODY.distance,
});

describe('rate limiting', () => {
  test('60 writes/min per username — 61st returns 429', async () => {
    const { username: u, token } = await createTestAccount();
    const headers = { 'content-type': 'application/json', ...authHeaders(token) };

    // First 60 requests should succeed
    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}/visits/v-rl-${i}`, {
        method: 'PUT',
        body: visitPayload(`v-rl-${i}`),
        headers,
      });
      expect(res.status).toBe(204);
    }

    // 61st should be rate limited
    const res = await app.request(`/api/${u}/visits/v-rl-60`, {
      method: 'PUT',
      body: visitPayload('v-rl-60'),
      headers,
    });
    expect(res.status).toBe(429);
  });

  test('429 includes Retry-After header', async () => {
    const { username: u, token } = await createTestAccount();
    const headers = { 'content-type': 'application/json', ...authHeaders(token) };

    for (let i = 0; i < 60; i++) {
      await app.request(`/api/${u}/visits/v-ra-${i}`, {
        method: 'PUT',
        body: visitPayload(`v-ra-${i}`),
        headers,
      });
    }

    const res = await app.request(`/api/${u}/visits/v-ra-60`, {
      method: 'PUT',
      body: visitPayload('v-ra-60'),
      headers,
    });
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test('60 reads/min per IP on GET /:username — 61st returns 429', async () => {
    const { username: u, token } = await createTestAccount();
    const headers = authHeaders(token);

    // First 60 authenticated reads succeed
    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}`, { headers });
      expect(res.status).toBe(200);
    }

    // 61st is rate limited (the limiter runs before auth, keyed on IP)
    const res = await app.request(`/api/${u}`, { headers });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  test('X-Forwarded-For chain keys the bucket on the first (client) IP only', async () => {
    const { username: u, token } = await createTestAccount();
    // Proxy chain: real client is 1.2.3.4, 5.6.7.8 is a downstream proxy hop.
    // TRUSTED_PROXY_ENV simulates nginx on loopback so XFF is honoured.
    const chained = { ...authHeaders(token), 'x-forwarded-for': '1.2.3.4, 5.6.7.8' };

    // Drain the 60 reads/min budget via the chain header.
    for (let i = 0; i < 60; i++) {
      expect((await app.request(`/api/${u}`, { headers: chained }, TRUSTED_PROXY_ENV)).status).toBe(200);
    }
    expect((await app.request(`/api/${u}`, { headers: chained }, TRUSTED_PROXY_ENV)).status).toBe(429);

    // The first IP alone hits the *same* bucket → still blocked, proving the
    // key is '1.2.3.4' (the leading element), not the whole header string.
    const firstAlone = { ...authHeaders(token), 'x-forwarded-for': '1.2.3.4' };
    expect((await app.request(`/api/${u}`, { headers: firstAlone }, TRUSTED_PROXY_ENV)).status).toBe(429);

    // The downstream proxy IP alone is a *different* bucket → allowed, proving
    // trailing chain hops are never used for keying.
    const secondAlone = { ...authHeaders(token), 'x-forwarded-for': '5.6.7.8' };
    expect((await app.request(`/api/${u}`, { headers: secondAlone }, TRUSTED_PROXY_ENV)).status).toBe(200);
  });

  test('X-Forwarded-For from an untrusted peer is ignored (spoof cannot bypass)', async () => {
    const { username: u, token } = await createTestAccount();
    const headers = authHeaders(token);
    // Peer is a public IP — attacker-controlled XFF must not mint fresh buckets.
    const untrustedEnv = { incoming: { socket: { remoteAddress: '203.0.113.9' } } };

    for (let i = 0; i < 60; i++) {
      const res = await app.request(
        `/api/${u}`,
        { headers: { ...headers, 'x-forwarded-for': `10.0.0.${i}` } },
        untrustedEnv
      );
      expect(res.status).toBe(200);
    }
    // 61st still keyed on 203.0.113.9, not the rotating XFF values.
    const blocked = await app.request(
      `/api/${u}`,
      { headers: { ...headers, 'x-forwarded-for': '10.0.0.99' } },
      untrustedEnv
    );
    expect(blocked.status).toBe(429);
  });

  test('10 account creations/hour per IP — 11th returns 429', async () => {
    // All requests come from 'unknown' IP (no x-forwarded-for header)
    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/accounts', { method: 'POST' });
      expect(res.status).toBe(201);
    }

    const res = await app.request('/api/accounts', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  test('10 account creations 429 includes Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      await app.request('/api/accounts', { method: 'POST' });
    }
    const res = await app.request('/api/accounts', { method: 'POST' });
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get('Retry-After');
    expect(retryAfter).toBeTruthy();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  test('rate limit resets between tests via resetRateLimiter', async () => {
    // Exhaust account creation limit
    for (let i = 0; i < 10; i++) {
      await app.request('/api/accounts', { method: 'POST' });
    }
    expect((await app.request('/api/accounts', { method: 'POST' })).status).toBe(429);

    // Reset and try again
    resetRateLimiter();
    await truncateAll(); // clear accounts too
    const res = await app.request('/api/accounts', { method: 'POST' });
    expect(res.status).toBe(201);
  });

  // finding #7056 — the per-username write bucket used to decrement before
  // accountAuth, so a missing/wrong token against a public username could lock
  // the owner out of cloud-backup writes for a rolling minute. IP still caps
  // unauthenticated probing; the username bucket is owner-only.
  test('unauthenticated writes do not consume the per-username bucket', async () => {
    const { username: u, token } = await createTestAccount();
    const owner = { 'content-type': 'application/json', ...authHeaders(token) };

    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}/visits/unauth-${i}`, {
        method: 'PUT',
        body: visitPayload(`unauth-${i}`),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(401);
    }

    const res = await app.request(`/api/${u}/visits/owner-after-probe`, {
      method: 'PUT',
      body: visitPayload('owner-after-probe'),
      headers: owner,
    });
    expect(res.status).toBe(204);
  });

  test('wrong-token writes do not consume the per-username bucket', async () => {
    const { username: u, token } = await createTestAccount();
    const owner = { 'content-type': 'application/json', ...authHeaders(token) };
    const wrong = { 'content-type': 'application/json', ...authHeaders('not-the-token') };

    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}/visits/wrong-${i}`, {
        method: 'PUT',
        body: visitPayload(`wrong-${i}`),
        headers: wrong,
      });
      expect(res.status).toBe(401);
    }

    const res = await app.request(`/api/${u}/visits/owner-after-wrong`, {
      method: 'PUT',
      body: visitPayload('owner-after-wrong'),
      headers: owner,
    });
    expect(res.status).toBe(204);
  });

  test('unauthenticated import does not consume the per-username bucket', async () => {
    const { username: u, token } = await createTestAccount();
    const owner = { 'content-type': 'application/json', ...authHeaders(token) };
    const emptyImport = JSON.stringify({
      visits: [], favorites: [], savedLocations: [], history: [],
    });

    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}/import`, {
        method: 'POST',
        body: emptyImport,
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(401);
    }

    const res = await app.request(`/api/${u}/visits/owner-after-import-probe`, {
      method: 'PUT',
      body: visitPayload('owner-after-import-probe'),
      headers: owner,
    });
    expect(res.status).toBe(204);
  });

  // finding #7057 — DELETE /:username was the only mutating account endpoint
  // without an IP limiter, so unauthenticated callers could issue unbounded
  // accountAuth lookups (same 401 for missing/wrong token as GET). Shares the
  // GET /:username 60/min IP read bucket; limiter runs before auth.
  test('60 DELETEs/min per IP on DELETE /:username — 61st returns 429', async () => {
    const { username: u } = await createTestAccount();

    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/${u}`, { method: 'DELETE' });
      expect(res.status).toBe(401);
    }

    const res = await app.request(`/api/${u}`, { method: 'DELETE' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  test('DELETE /:username shares the GET /:username IP read bucket', async () => {
    const { username: u, token } = await createTestAccount();
    const headers = authHeaders(token);

    for (let i = 0; i < 60; i++) {
      expect((await app.request(`/api/${u}`, { headers })).status).toBe(200);
    }

    const res = await app.request(`/api/${u}`, { method: 'DELETE', headers });
    expect(res.status).toBe(429);
  });
});
