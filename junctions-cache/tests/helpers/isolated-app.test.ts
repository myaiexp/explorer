// @vitest-environment node
// Pins the isolated-app bootstrap: env cleanup, temp-dir removal, one post().
// The lifecycle exists so the HTTP suites cannot fork again (finding #12678):
// LOGS_TOKEN cleanup lived in only one copy, and post() had two signatures.

import { describe, test, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
    cleanupIsolatedState,
    installIsolatedLifecycle,
    loadServer,
    post,
    tmpCacheFile,
} from './isolated-app.js';

const ISOLATED_ENV = [
    'LOGS_TOKEN',
    'CACHE_PATH',
    'CACHE_TTL_MS',
    'CACHE_EMPTY_TTL_MS',
    'CACHE_MAX_ENTRIES',
    'CACHE_MAX_POINTS',
    'CACHE_SAVE_DEBOUNCE_MS',
] as const;

describe('cleanupIsolatedState', () => {
    test('drops LOGS_TOKEN, CACHE_PATH, and the cache tuning env', () => {
        for (const key of ISOLATED_ENV) process.env[key] = 'leak';
        const dir = dirname(tmpCacheFile('jlife-'));
        expect(existsSync(dir)).toBe(true);

        cleanupIsolatedState();

        for (const key of ISOLATED_ENV) expect(process.env[key], key).toBeUndefined();
        expect(existsSync(dir)).toBe(false);
    });
});

describe('installIsolatedLifecycle', () => {
    installIsolatedLifecycle({ fakeTimers: true });

    test('beforeEach installs fake timers, so a debounce cannot fire on its own', () => {
        expect(vi.isFakeTimers()).toBe(true);
        let fired = false;
        setTimeout(() => { fired = true; }, 200);
        expect(fired).toBe(false);
        vi.advanceTimersByTime(200);
        expect(fired).toBe(true);
    });

    test('loadServer returns pick() plus a fresh app on an empty cache', async () => {
        const { fetch, marker } = await loadServer(async () => ({ marker: 'picked' }), 'jlife-');
        expect(marker).toBe('picked');
        const res = await fetch(new Request('http://localhost/health'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.cacheEntries).toBe(0);
    });
});

describe('post', () => {
    test('POSTs JSON to the given path, with raw and header overrides', async () => {
        const seen: Request[] = [];
        const fetch = async (req: Request) => {
            seen.push(req);
            return new Response(JSON.stringify({ ok: true }), { status: 201 });
        };

        const result = await post(fetch, '/pois', { a: 1 }, { headers: { 'x-test': 'yes' } });
        expect(result).toEqual({ status: 201, body: { ok: true } });
        expect(seen[0]!.url).toBe('http://localhost/pois');
        expect(seen[0]!.method).toBe('POST');
        expect(seen[0]!.headers.get('content-type')).toBe('application/json');
        expect(seen[0]!.headers.get('x-test')).toBe('yes');
        expect(await seen[0]!.text()).toBe(JSON.stringify({ a: 1 }));

        await post(fetch, '/roads', null, { raw: '{not json' });
        expect(seen[1]!.url).toBe('http://localhost/roads');
        expect(await seen[1]!.text()).toBe('{not json');
    });
});
