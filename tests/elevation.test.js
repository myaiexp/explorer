/**
 * Tests for elevation.js — Open-Meteo sampling + per-coord interpolation.
 * Focus: the request goes through net.js's fetchWithTimeout, not bare fetch
 * (audit #5410 / #5444), and the returned array is one altitude per input
 * coord even when the request itself is downsampled (finding #7300 / #7302).
 *
 * The timeout is load-bearing on the FIT-export path: confirmFITExport AWAITS
 * fetchElevations after the modal has already closed, so without it a stalled
 * Open-Meteo leaves the user with no file, no error, and no spinner until the
 * browser's own multi-minute socket default fires.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';

// SCRIPT_DEPS.elevation → net (fetchWithTimeout) + geo-utils (haversineM).
loadScripts('elevation');

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

    // Finding #7302: a 3-point route never exercises sampling (step stays 1).
    // 400 coords → step 4 → ~101 Open-Meteo points; the public contract is still
    // one altitude per input coord, interpolated back onto the full polyline.
    test('a long polyline samples the Open-Meteo request but returns one elevation per coord', async () => {
        const n = 400;
        const long = Array.from({ length: n }, (_, i) => [60 + i * 0.001, 24.9]);
        global.fetch = vi.fn((url) => {
            const nLats = new URL(url).searchParams.get('latitude').split(',').length;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({
                    elevation: Array.from({ length: nLats }, (_, i) => 100 + i),
                }),
            });
        });

        const result = await fetchElevations(long);
        expect(result).toHaveLength(n);

        const [url] = global.fetch.mock.calls[0];
        const nLats = new URL(url).searchParams.get('latitude').split(',').length;
        expect(nLats).toBeLessThan(n);
        expect(nLats).toBeLessThanOrEqual(101);

        // Samples at 0, 4, … plus the last vertex. First sample → 100; last → 100+nLats-1.
        expect(result[0]).toBe(100);
        expect(result[n - 1]).toBe(100 + nLats - 1);
        // Index 2 sits halfway (by distance, equal spacing) between samples 0 and 4.
        expect(result[2]).toBeCloseTo(100.5, 5);
    });
});
