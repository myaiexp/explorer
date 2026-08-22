// Unit tests for accountAuth — hash-then-compare of the bearer token.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Db } from '../db.js';
import { accountAuth } from './auth.js';
import { hashToken } from '../lib/token-hash.js';

function appWithStored(stored: string | null) {
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(stored === null ? [] : [{ token: stored }]);
            },
          };
        },
      };
    },
  };
  const app = new Hono();
  app.get('/:username', accountAuth(db as unknown as Db), (c) => c.json({ ok: true }));
  return app;
}

const PLAIN = 'sekret-bearer-token';
const HASH = hashToken(PLAIN);

describe('accountAuth hashes the presented bearer before comparing', () => {
  it('accepts the plaintext token against a stored SHA-256 digest', async () => {
    const app = appWithStored(HASH);
    const res = await app.request('/alice', {
      headers: { Authorization: `Bearer ${PLAIN}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects the stored digest used as the bearer (a DB dump is not a credential)', async () => {
    const app = appWithStored(HASH);
    const res = await app.request('/alice', {
      headers: { Authorization: `Bearer ${HASH}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a wrong plaintext token', async () => {
    const app = appWithStored(HASH);
    const res = await app.request('/alice', {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('returns the same 401 for a missing account as for a wrong token', async () => {
    const app = appWithStored(null);
    const res = await app.request('/nobody', {
      headers: { Authorization: `Bearer ${PLAIN}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });
});
