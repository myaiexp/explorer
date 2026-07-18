// @vitest-environment node
// Tests for junctions-cache/src/overpass.ts — Overpass query/retry + parseJunctions.
// Audit finding #1563: parseJunctions and the retry/timeout path had zero coverage.
//
// Unlike #1562 (fit-encoder exposed only 3 of ~14 symbols on globalThis, forcing
// load-time string injection), every internal here is reachable through the single
// exported entry point fetchJunctionsFromOverpass — so the SUT is imported normally
// and is never modified on disk (git diff stays empty):
//   - parseJunctions runs on the HTTP-200 path → drive it with crafted `elements`.
//   - getStatusWaitSec runs on each retry; its return value is emitted verbatim as
//     the `wait_sec` field of the 'overpass_retry' log line → observe it via the
//     mocked log module.
//
// fetch is fully mocked (no real HTTP); fake timers skip the retry back-off sleeps.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJunctionsFromOverpass, HIGHWAY_EXCLUDE } from '../src/overpass.js';
import { log } from '../src/log.js';

// Mock log so we can read the per-retry wait_sec (= getStatusWaitSec()'s return)
// and so test runs don't spew structured log lines to stdout.
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

// Mirror of the SUT's endpoint constants (not exported).
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_STATUS = 'https://overpass-api.de/api/status';
const BBOX = { minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 };

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errStatus = (status: number) => ({ ok: false, status, json: async () => ({}) });

type InterpResp = { ok: boolean; status: number; json?: () => Promise<unknown> };

// Install a fetch mock. `interpreter` is the queued sequence of /interpreter
// responses (the last entry repeats); /status returns `statusBody` text, or throws
// when `statusThrows`.
function installFetch(opts: {
    interpreter: InterpResp[];
    statusBody?: string;
    statusThrows?: boolean;
}) {
    let i = 0;
    // Second param is declared (though unused here) so mock.calls entries are typed
    // [string, RequestInit] — lets assertions read the init arg without unsafe casts.
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
        if (url === OVERPASS_STATUS) {
            if (opts.statusThrows) throw new Error('status endpoint down');
            return { ok: true, status: 200, text: async () => opts.statusBody ?? '' };
        }
        const r = opts.interpreter[Math.min(i, opts.interpreter.length - 1)];
        i++;
        return r;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const urlCalls = (m: ReturnType<typeof vi.fn>): number =>
    m.mock.calls.filter((c) => c[0] === OVERPASS_URL).length;

const retryWaits = (): number[] =>
    (log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] && c[1].event === 'overpass_retry')
        .map((c) => c[1].wait_sec as number);

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// ── parseJunctions (exercised through the HTTP-200 path) ─────────────────────

describe('parseJunctions (via fetchJunctionsFromOverpass 200 path)', () => {
    async function junctionsFrom(elements: unknown[]) {
        installFetch({ interpreter: [okJson({ elements })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        return p;
    }

    test('a node shared by ≥2 ways is identified as a junction', async () => {
        const out = await junctionsFrom([
            { type: 'way', id: 100, nodes: [1, 2] },
            { type: 'way', id: 101, nodes: [1, 3] },
            { type: 'node', id: 1, lat: 60.5, lon: 24.5 },
            { type: 'node', id: 2, lat: 60.6, lon: 24.6 },
            { type: 'node', id: 3, lat: 60.7, lon: 24.7 },
        ]);
        expect(out).toEqual([{ lat: 60.5, lng: 24.5 }]);
    });

    test('a junction at lat=0/lon=0 is still identified (guards the != null check)', async () => {
        const out = await junctionsFrom([
            { type: 'way', id: 100, nodes: [1, 2] },
            { type: 'way', id: 101, nodes: [1, 9] },
            { type: 'node', id: 1, lat: 0, lon: 0 }, // falsy but valid coordinates
            { type: 'node', id: 2, lat: 60.6, lon: 24.6 },
            { type: 'node', id: 9, lat: 60.9, lon: 24.9 },
        ]);
        expect(out).toEqual([{ lat: 0, lng: 0 }]);
    });

    test('a way referencing a node absent from elements is silently skipped', async () => {
        const out = await junctionsFrom([
            { type: 'way', id: 100, nodes: [1, 999] },
            { type: 'way', id: 101, nodes: [1, 999] }, // 999 shared by 2 ways but never defined
            { type: 'node', id: 1, lat: 60.5, lon: 24.5 },
        ]);
        expect(out).toEqual([{ lat: 60.5, lng: 24.5 }]); // no undefined entry for 999
    });

    test('single-node ways can never form a junction', async () => {
        const out = await junctionsFrom([
            { type: 'way', id: 100, nodes: [1] },
            { type: 'way', id: 101, nodes: [2] },
            { type: 'node', id: 1, lat: 60.5, lon: 24.5 },
            { type: 'node', id: 2, lat: 60.6, lon: 24.6 },
        ]);
        expect(out).toEqual([]);
    });

    test('ways with absent/non-array nodes and nodes lacking coords are ignored, no crash', async () => {
        const out = await junctionsFrom([
            { type: 'way', id: 100 }, // nodes absent → skipped
            { type: 'way', id: 98, nodes: 5 }, // truthy non-array: Array.isArray guard must skip it
            { type: 'way', id: 101, nodes: [1, 2] }, //   (else `for (const id of 5)` throws)
            { type: 'way', id: 102, nodes: [1, 2] },
            { type: 'node', id: 1, lat: 60.5, lon: 24.5 },
            { type: 'node', id: 2 }, // missing lat/lon → no coords recorded
        ]);
        expect(out).toEqual([{ lat: 60.5, lng: 24.5 }]); // node 2 shared but coordless → dropped
    });
});

// ── fetchJunctionsFromOverpass — request shape + retry/timeout path ──────────

describe('fetchJunctionsFromOverpass — request + retry/timeout', () => {
    const SAMPLE = (lat: number, lon: number) => [
        { type: 'way', id: 1, nodes: [7, 8] },
        { type: 'way', id: 2, nodes: [7, 9] },
        { type: 'node', id: 7, lat, lon },
    ];

    test('200: returns parsed junctions and POSTs the built query', async () => {
        const fetchMock = installFetch({ interpreter: [okJson({ elements: SAMPLE(60.1, 24.1) })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.1, lng: 24.1 }]);

        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(OVERPASS_URL);
        expect(init.method).toBe('POST');
        const raw = init.body as string;
        expect(raw.startsWith('data=')).toBe(true);
        const decoded = decodeURIComponent(raw);
        expect(decoded).toContain(HIGHWAY_EXCLUDE.default);
        expect(decoded).toContain('(60,24,61,25)');
    });

    test('the winter preset uses the winter highway-exclude list', async () => {
        const fetchMock = installFetch({ interpreter: [okJson({ elements: [] })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'winter');
        await vi.runAllTimersAsync();
        await p;
        const decoded = decodeURIComponent(fetchMock.mock.calls[0]![1].body as string);
        expect(decoded).toContain(HIGHWAY_EXCLUDE.winter);
    });

    test('retries after a 429 and succeeds on the next attempt', async () => {
        const fetchMock = installFetch({
            interpreter: [errStatus(429), okJson({ elements: SAMPLE(60.2, 24.2) })],
            statusBody: '',
        });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.2, lng: 24.2 }]);
        expect(urlCalls(fetchMock)).toBe(2);
    });

    test('retries after a 504 and succeeds on the next attempt', async () => {
        const fetchMock = installFetch({
            interpreter: [errStatus(504), okJson({ elements: SAMPLE(60.3, 24.3) })],
            statusBody: '',
        });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.3, lng: 24.3 }]);
        expect(urlCalls(fetchMock)).toBe(2);
    });

    // Audit #3158: an all-retries-exhausted 429/504 used to throw the status-less
    // 'overpass exhausted' (the 429/504 branch `continue`s, never touching lastErr),
    // so the caller couldn't tell "upstream is rate-limiting us" from any other
    // failure. The terminal error must now preserve the final status.
    test('three consecutive 429s exhaust the 3-attempt cap → throws status-bearing "retries exhausted (http 429)"', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(429)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('overpass retries exhausted (http 429)');
        expect(urlCalls(fetchMock)).toBe(3);
    });

    test('504 is retryable too → three 504s throw status-bearing "retries exhausted (http 504)"', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(504)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass retries exhausted (http 504)');
        expect(urlCalls(fetchMock)).toBe(3);
    });

    // Audit #3158 regression: the terminal failure is observable, not swallowed.
    // Pins that the rate-limit status survives all the way to the thrown Error —
    // distinguishable from the generic, status-less exhaustion sentinel.
    test('the exhausted 429 failure is distinguishable, not the generic "overpass exhausted"', async () => {
        installFetch({ interpreter: [errStatus(429)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        const msg = (err as Error).message;
        expect(msg).toContain('429');           // final upstream status preserved
        expect(msg).toContain('exhausted');      // signals retries were exhausted
        expect(msg).not.toBe('overpass exhausted'); // no longer swallowed
    });

    // Idea #1601 / audit sibling: non-transient 4xx (malformed query, etc.) must
    // not burn the retry budget — rethrow on the first response so we skip the
    // status-endpoint probes + back-off sleeps that only help 429/504/5xx.
    test('a 400 fails immediately without retrying (one interpreter call)', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(400)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 400');
        expect(urlCalls(fetchMock)).toBe(1);
    });

    test('a 403 fails immediately without retrying', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(403)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 403');
        expect(urlCalls(fetchMock)).toBe(1);
    });

    // 5xx other than 504 still get the retry budget (transient upstream).
    test('a 500 is retried up to the attempt cap', async () => {
        const fetchMock = installFetch({ interpreter: [errStatus(500)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 500');
        expect(urlCalls(fetchMock)).toBe(3);
    });
});

// ── getStatusWaitSec (observed via the overpass_retry wait_sec log field) ────
// Note: it parses the /status endpoint *body* ("Slot available after: …, in N
// seconds"), not the Retry-After header (the finding's phrasing).

describe('getStatusWaitSec (via overpass_retry wait_sec)', () => {
    async function firstRetryWait(opts: { statusBody?: string; statusThrows?: boolean }) {
        installFetch({ interpreter: [errStatus(429), okJson({ elements: [] })], ...opts });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        await p;
        return retryWaits()[0];
    }

    test('parses "in N seconds" from the status body and adds 2', async () => {
        const wait = await firstRetryWait({
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 8 seconds',
        });
        expect(wait).toBe(10); // 8 + 2
    });

    test('clamps very long waits to 60s', async () => {
        const wait = await firstRetryWait({
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 100 seconds',
        });
        expect(wait).toBe(60); // min(100 + 2, 60)
    });

    test('falls back to 15s when the status body does not match', async () => {
        const wait = await firstRetryWait({ statusBody: 'nothing parseable here' });
        expect(wait).toBe(15);
    });

    test('falls back to 15s when the status fetch throws', async () => {
        const wait = await firstRetryWait({ statusThrows: true });
        expect(wait).toBe(15);
    });
});
