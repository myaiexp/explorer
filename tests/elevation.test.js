/**
 * Tests for elevation.js — the Open-Meteo sampling half. Focus: the request goes
 * through net.js's fetchWithTimeout, not bare fetch (audit #5410 / #5444).
 *
 * That distinction is load-bearing on the FIT-export path: confirmFITExport
 * AWAITS fetchElevations after the modal has already closed, so without a timeout
 * a stalled Open-Meteo leaves the user with no file, no error, and no spinner
 * until the browser's own multi-minute socket default fires.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

// Both are plain browser scripts that register their helpers on globalThis
// (net.js's fetchWithTimeout is what elevation.js resolves at call time);
// helpers/load.js evaluates them once here, mirroring index.html's order — net.js
// first.
loadScripts('net', 'elevation');

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

const coords = [[60.1, 24.9], [60.2, 25.0], [60.3, 25.1]];

describe('fetchElevations', () => {
    test('aborts a stalled request instead of hanging on the socket default', async () => {
        vi.useFakeTimers();
        global.fetch = stalledFetch();

        const pending = fetchElevations(coords);
        // Assert the rejection before advancing, so the timer firing has a handler
        // waiting and the run cannot report an unhandled rejection.
        const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
    });

    test('passes an AbortSignal — the discriminator against a bare fetch', async () => {
        global.fetch = vi.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ elevation: [10, 20, 30] }),
        }));

        await expect(fetchElevations(coords)).resolves.toEqual([10, 20, 30]);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toContain('api.open-meteo.com/v1/elevation');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    test('a non-OK response yields null (unchanged contract for both callers)', async () => {
        global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 503 }));
        await expect(fetchElevations(coords)).resolves.toBeNull();
    });
});
