// @vitest-environment node
/**
 * Tests for overpass.js queryOverpass — 429/504 retry, status-slot wait, and
 * AbortError retry (finding #7065). Parser coverage lives in overpass-parse.test.js.
 *
 * Fake fetch + fake timers, no real HTTP. SCRIPT_DEPS pulls net.js
 * (fetchWithTimeout) and geometry.js; tests stub global fetch underneath.
 */
import { describe, test, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { loadScripts } from './helpers/load.js';
import {
    OVERPASS_URL, okJson, errStatus, installFetch, interpreterCalls,
    abortErr, settle,
} from './helpers/overpass-fetch.js';

beforeAll(() => {
    loadScripts('overpass');
});

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('queryOverpass — request + retry', () => {
    test('200: POSTs the query and returns parsed JSON', async () => {
        const fetchMock = installFetch({ interpreter: [okJson({ elements: [{ id: 1 }] })] });
        const { v } = await settle(queryOverpass('[out:json];out;'));
        expect(v).toEqual({ elements: [{ id: 1 }] });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(OVERPASS_URL);
        expect(init.method).toBe('POST');
        expect(init.body).toBe('data=' + encodeURIComponent('[out:json];out;'));
        expect(interpreterCalls(fetchMock)).toBe(1);
    });

    test('retries after a 429 and succeeds on the next attempt', async () => {
        const fetchMock = installFetch({
            interpreter: [errStatus(429), okJson({ elements: [] })],
        });
        const { v } = await settle(queryOverpass('q'));
        expect(v).toEqual({ elements: [] });
        expect(interpreterCalls(fetchMock)).toBe(2);
    });

    test('retries after a 504 and succeeds on the next attempt', async () => {
        const fetchMock = installFetch({
            interpreter: [errStatus(504), okJson({ elements: [] })],
        });
        const { v } = await settle(queryOverpass('q'));
        expect(v).toEqual({ elements: [] });
        expect(interpreterCalls(fetchMock)).toBe(2);
    });

    test('three consecutive 429s exhaust the 3-attempt cap', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(429)] });
        const { e } = await settle(queryOverpass('q'));
        expect(e).toBeInstanceOf(Error);
        expect(e.message).toBe('POI search is busy. Please wait a moment and try again.');
        expect(interpreterCalls(fetchMock)).toBe(3);
    });

    test('a 400 fails immediately without retrying', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(400)] });
        const { e } = await settle(queryOverpass('q'));
        expect(e.message).toBe('Failed to fetch POI data. Please try again.');
        expect(interpreterCalls(fetchMock)).toBe(1);
    });

    test('a 500 fails immediately without retrying (only 429/504 are retryable HTTP)', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(500)] });
        const { e } = await settle(queryOverpass('q'));
        expect(e.message).toBe('Failed to fetch POI data. Please try again.');
        expect(interpreterCalls(fetchMock)).toBe(1);
    });

    test('AbortError on the interpreter is retried and succeeds on the next attempt', async () => {
        const fetchMock = installFetch({
            interpreter: [{ throw: abortErr() }, okJson({ elements: [{ id: 7 }] })],
        });
        const { v, e } = await settle(queryOverpass('q'));
        expect(e).toBeUndefined();
        expect(v).toEqual({ elements: [{ id: 7 }] });
        expect(interpreterCalls(fetchMock)).toBe(2);
    });

    test('three AbortErrors exhaust the 3-attempt cap (busy message, not the abort)', async () => {
        const fetchMock = installFetch({ interpreter: [{ throw: abortErr() }] });
        const { e } = await settle(queryOverpass('q'));
        expect(e).toBeInstanceOf(Error);
        expect(e.name).not.toBe('AbortError');
        expect(e.message).toBe('POI search is busy. Please wait a moment and try again.');
        expect(interpreterCalls(fetchMock)).toBe(3);
    });
});

describe('queryOverpass — status-slot wait', () => {
    async function firstRetryProgress(opts) {
        const onProgress = vi.fn();
        installFetch({ interpreter: [errStatus(429), okJson({ elements: [] })], ...opts });
        const { e } = await settle(queryOverpass('q', onProgress));
        expect(e).toBeUndefined();
        return onProgress.mock.calls.map((c) => c[0]);
    }

    test('parses "in N seconds" from the status body, adds 2, and reports it', async () => {
        const msgs = await firstRetryProgress({
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 8 seconds',
        });
        expect(msgs).toContain('POI search is busy, retrying in 10s…');
    });

    test('clamps very long waits to 60s', async () => {
        const msgs = await firstRetryProgress({
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 100 seconds',
        });
        expect(msgs).toContain('POI search is busy, retrying in 60s…');
    });

    test('falls back to 15s when the status body does not match', async () => {
        const msgs = await firstRetryProgress({ statusBody: 'nothing parseable here' });
        expect(msgs).toContain('POI search is busy, retrying in 15s…');
    });

    test('falls back to 15s when the status fetch throws (no progress text)', async () => {
        const onProgress = vi.fn();
        installFetch({
            interpreter: [errStatus(429), okJson({ elements: [] })],
            statusThrows: true,
        });
        const { e } = await settle(queryOverpass('q', onProgress));
        expect(e).toBeUndefined();
        // status catch sleeps 15s without an onProgress call
        expect(onProgress).not.toHaveBeenCalled();
    });
});
