// @vitest-environment node
/**
 * Tests for net.js — fetchWithTimeout's 20s default hang-breaker (finding #7586).
 *
 * elevation.test.js is the only other stall/AbortSignal coverage, and it
 * passes ELEVATION_TIMEOUT_MS (10s) explicitly. OSRM, Nominatim, and sync
 * apiFetch rely on this default; a broken FETCH_TIMEOUT_MS (undefined/0) or
 * a wrapper that stops passing signal would not fail those suites.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

loadScripts('net');

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

// A fetch that never responds but honours its AbortSignal — the shape of a
// stalled connection. A bare fetch() call passes no signal, so `init.signal`
// would be undefined and this stub would throw rather than hang.
function stalledFetch() {
    return vi.fn((url, init) => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
            const e = new Error('The operation was aborted.');
            e.name = 'AbortError';
            reject(e);
        });
    }));
}

describe('FETCH_TIMEOUT_MS', () => {
    test('is the 20s hang-breaker OSRM / Nominatim / sync apiFetch inherit', () => {
        expect(FETCH_TIMEOUT_MS).toBe(20_000);
    });
});

describe('fetchWithTimeout', () => {
    test('aborts a stalled two-arg fetch at 20s, not sooner', async () => {
        vi.useFakeTimers();
        global.fetch = stalledFetch();

        const pending = fetchWithTimeout('https://example.test/osrm');
        let rejected = null;
        pending.catch((e) => { rejected = e; });

        await vi.advanceTimersByTimeAsync(19_999);
        expect(rejected).toBeNull();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [, init] = global.fetch.mock.calls[0];
        expect(init.signal).toBeInstanceOf(AbortSignal);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(rejected).toMatchObject({ name: 'AbortError' });
    });

    test('clears the abort timer on success so a later tick does not abort', async () => {
        vi.useFakeTimers();
        const abort = vi.spyOn(AbortController.prototype, 'abort');
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200 }));

        await expect(fetchWithTimeout('https://example.test/nominatim')).resolves.toMatchObject({
            ok: true,
        });
        expect(abort).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(20_000);
        expect(abort).not.toHaveBeenCalled();
    });
});
