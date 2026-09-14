/**
 * Tests for elevation.js — Open-Meteo sampling + per-coord interpolation, and
 * the user-visible profile chart (finding #7781). Focus: the request goes
 * through net.js's fetchWithTimeout, not bare fetch (audit #5410 / #5444),
 * and the returned array is one altitude per input coord even when the
 * request itself is downsampled (finding #7300 / #7302).
 *
 * The timeout is load-bearing on the FIT-export path: confirmFITExport AWAITS
 * fetchElevations after the modal has already closed, so without it a stalled
 * Open-Meteo leaves the user with no file, no error, and no spinner until the
 * browser's own multi-minute socket default fires. renderElevationChart is
 * the other public surface: hide on <2 samples, flat-range fallback, and
 * the gain/loss stats — route-view tests stub it, so this file owns it.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { loadScripts } from './helpers/load.js';
import { jsonResponse } from './helpers/fetch-stub.js';

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
        global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ elevation: [10, 20, 30] })));

        await expect(fetchElevations(coords)).resolves.toEqual([10, 20, 30]);
        const [url, init] = global.fetch.mock.calls[0];
        expect(url).toContain('api.open-meteo.com/v1/elevation');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    test('a non-OK response yields null (unchanged contract for both callers)', async () => {
        global.fetch = vi.fn(() => Promise.resolve(jsonResponse({}, { status: 503 })));
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
            return Promise.resolve(jsonResponse({
                elevation: Array.from({ length: nLats }, (_, i) => 100 + i),
            }));
        });

        const result = await fetchElevations(long);
        expect(result).toHaveLength(n);

        const [url] = global.fetch.mock.calls[0];
        const nLats = new URL(url).searchParams.get('latitude').split(',').length;
        expect(nLats).toBeLessThan(n);
        expect(nLats).toBeLessThanOrEqual(100);

        // Samples every `step` plus the last vertex. First sample → 100; last → 100+nLats-1.
        expect(result[0]).toBe(100);
        expect(result[n - 1]).toBe(100 + nLats - 1);
    });

    // Idea #4020: Open-Meteo rejects >100 coordinates with a 400, and
    // fetchElevations turns that into null — a silently missing chart on every
    // route over 100 vertices. The cap is a hard API limit, so it is pinned here
    // across the whole shape of n rather than at one sample length.
    test.each([100, 101, 161, 199, 200, 201, 397, 500, 3000, 16000])(
        'a %i-vertex route sends at most 100 coordinates to Open-Meteo',
        async (n) => {
            const long = Array.from({ length: n }, (_, i) => [60 + i * 0.001, 24.9]);
            global.fetch = vi.fn((url) => {
                const nLats = new URL(url).searchParams.get('latitude').split(',').length;
                return Promise.resolve(jsonResponse({
                    elevation: Array.from({ length: nLats }, () => 100),
                }));
            });

            await fetchElevations(long);
            const [url] = global.fetch.mock.calls[0];
            const nLats = new URL(url).searchParams.get('latitude').split(',').length;
            const nLngs = new URL(url).searchParams.get('longitude').split(',').length;
            expect(nLats).toBeLessThanOrEqual(100);
            expect(nLngs).toBe(nLats);
        },
    );

    // A route at or under the cap needs no downsampling at all — one Open-Meteo
    // reading per vertex, no interpolation error introduced for free.
    test('a route at the cap is sent 1:1, not downsampled', async () => {
        const n = 100;
        const long = Array.from({ length: n }, (_, i) => [60 + i * 0.001, 24.9]);
        global.fetch = vi.fn((url) => {
            const nLats = new URL(url).searchParams.get('latitude').split(',').length;
            return Promise.resolve(jsonResponse({
                elevation: Array.from({ length: nLats }, (_, i) => 100 + i),
            }));
        });

        const result = await fetchElevations(long);
        const [url] = global.fetch.mock.calls[0];
        expect(new URL(url).searchParams.get('latitude').split(',')).toHaveLength(n);
        expect(result).toEqual(Array.from({ length: n }, (_, i) => 100 + i));
    });
});

describe('renderElevationChart', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="elevationContainer" class="active"></div>';
    });

    function container() {
        return document.getElementById('elevationContainer');
    }

    function statsText() {
        return [...container().querySelectorAll('.elevation-stats span')]
            .map((el) => el.textContent);
    }

    test('<2 samples removes .active and clears the chart', () => {
        renderElevationChart([10], '#E66100');
        expect(container().classList.contains('active')).toBe(false);
        expect(container().children).toHaveLength(0);

        container().classList.add('active');
        renderElevationChart(null, '#E66100');
        expect(container().classList.contains('active')).toBe(false);
        expect(container().children).toHaveLength(0);
    });

    test('a rising series shows rounded gain and 0 loss', () => {
        renderElevationChart([10.4, 20.4, 30.4], '#56B4E9');

        expect(container().classList.contains('active')).toBe(true);
        expect(container().querySelector('svg.elevation-chart')).not.toBeNull();
        expect(statsText()).toEqual(['10–30 m', '↑ 20 m', '↓ 0 m']);
    });

    test('a falling series shows 0 gain and rounded loss', () => {
        renderElevationChart([30, 20, 10], '#56B4E9');
        expect(statsText()).toEqual(['10–30 m', '↑ 0 m', '↓ 20 m']);
    });

    test('a flat series still renders (range fallback) with 0 gain and 0 loss', () => {
        renderElevationChart([15, 15, 15], '#E66100');

        expect(container().classList.contains('active')).toBe(true);
        const svg = container().querySelector('svg.elevation-chart');
        expect(svg).not.toBeNull();
        // range = max-min || 1, so every point maps to a finite y instead of NaN.
        const points = svg.querySelector('polyline').getAttribute('points');
        expect(points).not.toMatch(/NaN/);
        expect(statsText()).toEqual(['15–15 m', '↑ 0 m', '↓ 0 m']);
    });
});
