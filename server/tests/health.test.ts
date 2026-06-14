// @vitest-environment node
import { describe, test, expect } from 'vitest';
import { app } from './helpers.js';

describe('GET /api/health', () => {
  test('returns 200 with { status: "ok" }', async () => {
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
