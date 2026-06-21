import { describe, test, expect, beforeEach } from 'vitest';
import { app, db, truncateAll, createTestAccount, VISIT_BODY, resetRateLimiter, authHeaders } from './helpers.js';
import { schema } from '../src/db.js';

beforeEach(async () => {
  await truncateAll();
  resetRateLimiter();
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
});
