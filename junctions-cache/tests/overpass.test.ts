// @vitest-environment node
// Tests for junctions-cache/src/overpass.ts — the local-first query/retry loop
// and parseJunctions.
// Audit finding #1563: parseJunctions and the retry/timeout path had zero coverage.
//
// Unlike #1562 (fit-encoder exposed only 3 of ~14 symbols on globalThis, forcing
// load-time string injection), every internal here is reachable through the
// exported entry points runOverpassQuery / fetchJunctionsFromOverpass — so the SUT
// is imported normally and is never modified on disk (git diff stays empty):
//   - parseJunctions runs on the HTTP-200 path → drive it with crafted `elements`.
//   - getStatusWaitSec runs on each PUBLIC retry; its return value is emitted
//     verbatim as the `wait_sec` field of the 'overpass_retry' log line → observe
//     it via the mocked log module.
//
// Targeting: overpass.ts is local-first, so with a clear latch every request goes
// to LOCAL_URL and only a tripped latch sends it to FALLBACK_URL. Each test below
// therefore states its target explicitly — tests about *generic* retry semantics
// run wherever they read most naturally, tests about public slot pacing call
// usePublic() first. _resetLatch() in beforeEach keeps the module-level latch from
// leaking between tests.
//
// fetch is fully mocked (no real HTTP); fake timers skip the retry back-off sleeps.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    fetchJunctionsFromOverpass,
    runOverpassQuery,
    HIGHWAY_EXCLUDE,
    OVERPASS_MAX_BYTES,
} from '../src/overpass.js';
import {
    _resetLatch,
    isLocalDown,
    markLocalDown,
    LOCAL_URL,
    FALLBACK_URL,
    STATUS_URL,
} from '../src/overpass-target.js';
import { log } from '../src/log.js';

// Mock log so we can read the per-retry wait_sec (= getStatusWaitSec()'s return)
// and so test runs don't spew structured log lines to stdout.
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const BBOX = { minLat: 60, minLng: 24, maxLat: 61, maxLng: 25 };
const QUERY = '[out:json][timeout:15];node(1);out;';

const okJson = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
});
const errStatus = (status: number) => new Response(null, { status });

// Force the public fallback: trips the down-latch, so currentTarget() returns
// FALLBACK_URL from the very first attempt.
function usePublic() {
    markLocalDown();
}

// A queued sequence of responses for one endpoint (the last entry repeats), or
// 'reject' for a connection-level failure on every call.
type Serve = Response[] | 'reject';

// Install a fetch mock that can serve either Overpass target. `local` and
// `fallback` are the per-endpoint queues; /status returns `statusBody` text, or
// throws when `statusThrows`. An unqueued endpoint throws loudly rather than
// silently returning a default, so a test that hits the wrong target fails.
function installFetch(opts: {
    local?: Serve;
    fallback?: Serve;
    statusBody?: string;
    statusThrows?: boolean;
}) {
    const idx = { local: 0, fallback: 0 };
    const serve = (queue: Serve | undefined, which: 'local' | 'fallback'): Response => {
        if (queue === undefined) throw new Error(`unexpected ${which} overpass request`);
        if (queue === 'reject') throw new Error(`connect ECONNREFUSED (${which})`);
        const r = queue[Math.min(idx[which], queue.length - 1)]!;
        idx[which]++;
        return r;
    };
    // Second param is declared (though unused here) so mock.calls entries are typed
    // [string, RequestInit] — lets assertions read the init arg without unsafe casts.
    const fetchMock = vi.fn(async (url: string, _init: RequestInit) => {
        if (url === STATUS_URL) {
            if (opts.statusThrows) throw new Error('status endpoint down');
            return new Response(opts.statusBody ?? '', { status: 200 });
        }
        if (url === LOCAL_URL) return serve(opts.local, 'local');
        if (url === FALLBACK_URL) return serve(opts.fallback, 'fallback');
        throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const urlCalls = (m: ReturnType<typeof vi.fn>, url: string = LOCAL_URL): number =>
    m.mock.calls.filter((c) => c[0] === url).length;

const statusCalls = (m: ReturnType<typeof vi.fn>): number => urlCalls(m, STATUS_URL);

const retryWaits = (): number[] =>
    (log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] && c[1].event === 'overpass_retry')
        .map((c) => c[1].wait_sec as number);

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    _resetLatch();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    _resetLatch();
});

// ── parseJunctions (exercised through the HTTP-200 path) ─────────────────────
// Target-agnostic: served from local, which is where a healthy deployment reads.

describe('parseJunctions (via fetchJunctionsFromOverpass 200 path)', () => {
    async function junctionsFrom(elements: unknown[]) {
        installFetch({ local: [okJson({ elements })] });
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

    test('200: returns parsed junctions and POSTs the built query to the LOCAL instance', async () => {
        const fetchMock = installFetch({ local: [okJson({ elements: SAMPLE(60.1, 24.1) })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.1, lng: 24.1 }]);

        const [url, init] = fetchMock.mock.calls[0]!;
        // Local-first: a healthy self-hosted instance takes /junctions — the
        // heaviest of our queries — and the public API is never touched.
        expect(url).toBe(LOCAL_URL);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(0);
        expect(init.method).toBe('POST');
        const headers = init.headers as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
        const raw = init.body as string;
        expect(raw.startsWith('data=')).toBe(true);
        const decoded = decodeURIComponent(raw);
        expect(decoded).toContain(HIGHWAY_EXCLUDE.default);
        expect(decoded).toContain('(60,24,61,25)');
    });

    test('the winter preset uses the winter highway-exclude list', async () => {
        const fetchMock = installFetch({ local: [okJson({ elements: [] })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'winter');
        await vi.runAllTimersAsync();
        await p;
        const decoded = decodeURIComponent(fetchMock.mock.calls[0]![1].body as string);
        expect(decoded).toContain(HIGHWAY_EXCLUDE.winter);
    });

    test('the identifying User-Agent is sent on public requests', async () => {
        usePublic();
        const fetchMock = installFetch({ fallback: [okJson({ elements: [] })] });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        await p;
        const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
        expect(headers['User-Agent']).toBe('wander-junctions/0.1 (mase@tuta.com)');
    });

    // 429/504 are the public instance's own signals (slot exhaustion, gateway
    // timeout), so these pacing/exhaustion tests run against the fallback. The
    // local equivalents live in the local-first block below.
    test('retries after a 429 and succeeds on the next attempt', async () => {
        usePublic();
        const fetchMock = installFetch({
            fallback: [errStatus(429), okJson({ elements: SAMPLE(60.2, 24.2) })],
            statusBody: '',
        });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.2, lng: 24.2 }]);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(2);
    });

    test('retries after a 504 and succeeds on the next attempt', async () => {
        usePublic();
        const fetchMock = installFetch({
            fallback: [errStatus(504), okJson({ elements: SAMPLE(60.3, 24.3) })],
            statusBody: '',
        });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.3, lng: 24.3 }]);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(2);
    });

    // Audit #3158: an all-retries-exhausted 429/504 used to throw the status-less
    // 'overpass exhausted' (the 429/504 branch `continue`s, never touching lastErr),
    // so the caller couldn't tell "upstream is rate-limiting us" from any other
    // failure. The terminal error must now preserve the final status.
    test('three consecutive 429s exhaust the 3-attempt cap → throws status-bearing "retries exhausted (http 429)"', async () => {
        usePublic();
        const fetchMock = installFetch({ fallback: [errStatus(429)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe('overpass retries exhausted (http 429)');
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(3);
    });

    test('504 is retryable too → three 504s throw status-bearing "retries exhausted (http 504)"', async () => {
        usePublic();
        const fetchMock = installFetch({ fallback: [errStatus(504)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass retries exhausted (http 504)');
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(3);
    });

    // Audit #3158 regression: the terminal failure is observable, not swallowed.
    // Pins that the rate-limit status survives all the way to the thrown Error —
    // distinguishable from the generic, status-less exhaustion sentinel.
    test('the exhausted 429 failure is distinguishable, not the generic "overpass exhausted"', async () => {
        usePublic();
        installFetch({ fallback: [errStatus(429)], statusBody: '' });
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
        usePublic();
        const fetchMock = installFetch({ fallback: [errStatus(400)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 400');
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });

    test('a 403 fails immediately without retrying', async () => {
        const fetchMock = installFetch({ local: [errStatus(403)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 403');
        expect(urlCalls(fetchMock)).toBe(1);
    });

    // 5xx other than 504 still get the retry budget (transient upstream). Run on
    // the public target: on local a 5xx additionally trips the latch and moves
    // attempt 2 to the fallback (covered below), which would hide the budget.
    test('a 500 is retried up to the attempt cap', async () => {
        usePublic();
        const fetchMock = installFetch({ fallback: [errStatus(500)], statusBody: '' });
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect((err as Error).message).toBe('overpass http 500');
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(3);
    });

    test('Content-Length over the cap fails without retrying (finding #7755)', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url === STATUS_URL) return new Response('');
            return new Response('{}', {
                status: 200,
                headers: { 'content-length': String(OVERPASS_MAX_BYTES + 1) },
            });
        });
        vi.stubGlobal('fetch', fetchMock);
        const errP = fetchJunctionsFromOverpass(BBOX, 'default').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        const err = await errP;
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toMatch(/overpass body too large/);
        expect(urlCalls(fetchMock)).toBe(1);
        // An oversized body is our bbox being too big, not local being unhealthy —
        // so it must not cost us five minutes of the local instance.
        expect(isLocalDown()).toBe(false);
    });
});

// ── local-first target + public fallback ────────────────────────────────────

describe('runOverpassQuery — local-first with public fallback', () => {
    const ONE_NODE = { elements: [{ type: 'node', id: 7, lat: 60.1, lon: 24.1 }] };

    test('a connection failure against local marks it down and retries against public', async () => {
        const fetchMock = installFetch({
            local: 'reject',
            fallback: [okJson(ONE_NODE)],
            statusBody: '',
        });
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        const elements = await p;
        expect(elements).toHaveLength(1);
        expect(isLocalDown()).toBe(true);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(1);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });

    test('a local 5xx also trips the latch', async () => {
        const fetchMock = installFetch({
            local: [errStatus(502)],
            fallback: [okJson(ONE_NODE)],
            statusBody: '',
        });
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(isLocalDown()).toBe(true);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(1);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });

    test('a local 504 is both retryable and a latch trip — the retry lands on public', async () => {
        // 504 takes the retryable `continue` branch rather than the throw path,
        // so the latch has to be set there too or the retry goes back to a
        // gateway we already know is timing out.
        const fetchMock = installFetch({
            local: [errStatus(504)],
            fallback: [okJson(ONE_NODE)],
            statusBody: '',
        });
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(isLocalDown()).toBe(true);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(1);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });

    test('a local 400 does NOT trip the latch — it is our query that is wrong', async () => {
        // Latching here would ship a query we already know is malformed to a
        // public server, and cost us five minutes of local for nothing.
        const fetchMock = installFetch({ local: [errStatus(400)], statusBody: '' });
        const errP = runOverpassQuery('bad').then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        expect((await errP as Error).message).toMatch(/overpass http 400/);
        expect(isLocalDown()).toBe(false);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(0);
    });

    test('local retries do not sleep on the public status probe', async () => {
        // 429 is retryable but not a 5xx, so all three attempts stay on local.
        const fetchMock = installFetch({
            local: [errStatus(429), errStatus(429), okJson(ONE_NODE)],
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 40 seconds',
        });
        const t0 = Date.now();
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(3);
        // The slot concept is public-only: never probed, never slept on.
        expect(statusCalls(fetchMock)).toBe(0);
        expect(retryWaits()).toEqual([0, 0]);
        // Two public back-offs would have burned 84 s of wall clock here.
        expect(Date.now() - t0).toBeLessThan(15_000);
        expect(isLocalDown()).toBe(false);
    });

    test('public-path retries keep the existing status-probe pacing', async () => {
        usePublic();
        const fetchMock = installFetch({
            fallback: [errStatus(429), okJson(ONE_NODE)],
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 8 seconds',
        });
        const t0 = Date.now();
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(statusCalls(fetchMock)).toBe(1);
        expect(retryWaits()).toEqual([10]);        // 8 + 2
        expect(Date.now() - t0).toBeGreaterThanOrEqual(10_000);
    });

    // The latch window is exactly when self-hosted Overpass is down, so the
    // handover must not be the slow path: probing the public status endpoint
    // here would stall the FIRST request of every 5-minute window by 15 s,
    // making the fallback visibly slow precisely when it is load-bearing.
    // Local failing is not a slot signal — only public can produce one.
    test('the local→public handover does not pay the public status probe', async () => {
        const fetchMock = installFetch({
            local: 'reject',
            fallback: [okJson(ONE_NODE)],
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 40 seconds',
        });
        const t0 = Date.now();
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(statusCalls(fetchMock)).toBe(0);
        expect(retryWaits()).toEqual([0]);
        expect(Date.now() - t0).toBeLessThan(15_000);
    });

    // ...but once we are ON public, a public push-back is still honoured.
    test('a public 429 after the handover restores the probe', async () => {
        const fetchMock = installFetch({
            local: 'reject',
            fallback: [errStatus(429), okJson(ONE_NODE)],
            statusBody: 'Slot available after: 2024-01-01T00:00:00Z, in 8 seconds',
        });
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        // Attempt 1 (the handover) skips it; attempt 2 follows a public 429.
        expect(statusCalls(fetchMock)).toBe(1);
        expect(retryWaits()).toEqual([0, 10]);
    });

    test('a fallback that also fails surfaces the public failure, latch still set', async () => {
        const fetchMock = installFetch({
            local: 'reject',
            fallback: [errStatus(429)],
            statusBody: '',
        });
        const errP = runOverpassQuery(QUERY).then(() => null, (e) => e);
        await vi.runAllTimersAsync();
        // lastErr (the local connection failure) is preferred over the generic
        // sentinel, exactly as before the split.
        expect((await errP as Error).message).toMatch(/ECONNREFUSED/);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(1);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(2);
        expect(isLocalDown()).toBe(true);
    });

    test('once latched, a later call starts on public without probing local again', async () => {
        usePublic();
        const fetchMock = installFetch({ fallback: [okJson(ONE_NODE)] });
        const p = runOverpassQuery(QUERY);
        await vi.runAllTimersAsync();
        expect(await p).toHaveLength(1);
        expect(urlCalls(fetchMock, LOCAL_URL)).toBe(0);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });

    test('fetchJunctionsFromOverpass goes through runOverpassQuery, so /junctions falls back too', async () => {
        const fetchMock = installFetch({
            local: 'reject',
            fallback: [okJson({
                elements: [
                    { type: 'way', id: 1, nodes: [7, 8] },
                    { type: 'way', id: 2, nodes: [7, 9] },
                    { type: 'node', id: 7, lat: 60.4, lon: 24.4 },
                ],
            })],
            statusBody: '',
        });
        const p = fetchJunctionsFromOverpass(BBOX, 'default');
        await vi.runAllTimersAsync();
        expect(await p).toEqual([{ lat: 60.4, lng: 24.4 }]);
        expect(urlCalls(fetchMock, FALLBACK_URL)).toBe(1);
    });
});

// ── getStatusWaitSec (observed via the overpass_retry wait_sec log field) ────
// Note: it parses the /status endpoint *body* ("Slot available after: …, in N
// seconds"), not the Retry-After header (the finding's phrasing).
//
// Public-path only now: the probe is never reached from a local retry, so every
// case here trips the latch first.

describe('getStatusWaitSec (via overpass_retry wait_sec, public path)', () => {
    async function firstRetryWait(opts: { statusBody?: string; statusThrows?: boolean }) {
        usePublic();
        installFetch({ fallback: [errStatus(429), okJson({ elements: [] })], ...opts });
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
