// @vitest-environment node
// Tests for the two boundaries of one Overpass attempt in overpass.ts: its abort
// deadline covers the body read as well as the headers, and an HTTP failure
// reaches the retry loop as a typed error rather than as words in a message.
//
// The socket block runs real fetch against a real http server, because the fix
// rests on undici rejecting an in-progress body read when the signal aborts. A
// mocked stream would only restate that belief. Only setTimeout/clearTimeout are
// faked there, so sockets keep running while the 30 s deadline is skipped.

import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OverpassHttpError, runOverpassQuery } from '../src/overpass.js';
import {
    _resetLatch,
    FALLBACK_URL,
    isLocalDown,
    LOCAL_URL,
    markLocalDown,
    STATUS_URL,
} from '../src/overpass-target.js';
import { log } from '../src/log.js';

vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const QUERY = '[out:json][timeout:15];node(1);out;';
const ATTEMPT_MS = 30_000;
const STATUS_PROBE_MS = 5_000;
const ONE_NODE = { elements: [{ type: 'node', id: 7, lat: 60.1, lon: 24.1 }] };

const okJson = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

// A body that sends one chunk and then nothing, ending only when its request
// aborts — which is how undici ends a response body.
function stalledBody(signal: AbortSignal): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('{"elements":['));
            signal.addEventListener('abort', () => controller.error(signal.reason));
        },
    });
}

const retryWaits = (): number[] =>
    (log as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter((c) => c[1] && c[1].event === 'overpass_retry')
        .map((c) => c[1].wait_sec as number);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    _resetLatch();
});

describe('attempt deadline over a real socket', () => {
    let server: Server;
    let origin: string;
    let respond: (res: ServerResponse, request: number) => void;
    let requests: number;
    const realFetch = globalThis.fetch;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        vi.clearAllMocks();
        _resetLatch();
        requests = 0;
        server = createServer((req, res) => {
            req.resume();
            respond(res, ++requests);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });

    afterEach(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });

    // Sends every Overpass URL to the local server, recording which was asked
    // for, and resolves `headers` once the first response's headers are in — the
    // moment the old timer was cleared.
    function routeToServer() {
        const urls: string[] = [];
        let headersIn!: () => void;
        const headers = new Promise<void>((resolve) => { headersIn = resolve; });
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            urls.push(url);
            const res = await realFetch(origin, init);
            headersIn();
            return res;
        });
        return { urls, headers };
    }

    test('a local body that stalls after the headers is aborted at the deadline and falls back', async () => {
        respond = (res, request) => {
            if (request === 1) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.write('{"elements":[');     // and never finishes
            } else {
                res.end(JSON.stringify(ONE_NODE));
            }
        };
        const { urls, headers } = routeToServer();

        const answer = runOverpassQuery(QUERY);
        await headers;
        await vi.advanceTimersByTimeAsync(ATTEMPT_MS);

        expect(await Promise.race([answer, realDelay(1_000, 'still holding the slot')]))
            .toEqual(ONE_NODE.elements);
        expect(urls).toEqual([LOCAL_URL, FALLBACK_URL]);
        // A local instance that stops mid-response is unhealthy.
        expect(isLocalDown()).toBe(true);
    });

    test('an error response nobody reads does not keep its connection open', async () => {
        const closed = new Promise<string>((resolve) => {
            respond = (res) => {
                res.on('close', () => resolve('closed'));
                res.writeHead(400);
                res.write('partial error page');
            };
        });
        routeToServer();

        await expect(runOverpassQuery(QUERY)).rejects.toThrow('overpass http 400');

        expect(await Promise.race([closed, realDelay(1_000, 'still open')])).toBe('closed');
    });
});

describe('attempt deadline on the retry path', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        _resetLatch();
    });

    test('every public attempt is bounded, so a stalling fallback ends in a rejection', async () => {
        markLocalDown();
        const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
            if (url === STATUS_URL) return new Response('', { status: 200 });
            return new Response(stalledBody(init.signal!), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchMock);

        let failure: Error | null = null;
        const settled = runOverpassQuery(QUERY).catch((e: Error) => { failure = e; });
        await vi.advanceTimersByTimeAsync(3 * ATTEMPT_MS + 2 * 15_000);
        await settled;

        expect(failure).toMatchObject({ name: 'AbortError' });
        expect(fetchMock.mock.calls.filter((c) => c[0] === FALLBACK_URL)).toHaveLength(3);
    });

    test('a status probe whose body stalls gives up at its own deadline and uses the default wait', async () => {
        markLocalDown();
        let attempts = 0;
        vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
            if (url === STATUS_URL) return new Response(stalledBody(init.signal!), { status: 200 });
            return ++attempts === 1 ? new Response(null, { status: 429 }) : okJson(ONE_NODE);
        });

        const answer = runOverpassQuery(QUERY);
        await vi.advanceTimersByTimeAsync(STATUS_PROBE_MS + 15_000);

        expect(retryWaits()).toEqual([15]);
        await expect(answer).resolves.toEqual(ONE_NODE.elements);
    });

    test('a finished attempt leaves no deadline armed', async () => {
        vi.stubGlobal('fetch', async () => okJson(ONE_NODE));

        await expect(runOverpassQuery(QUERY)).resolves.toEqual(ONE_NODE.elements);

        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('HTTP failures are typed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        _resetLatch();
    });

    test('a 4xx rejects with an OverpassHttpError carrying the status', async () => {
        vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));

        const err = await runOverpassQuery(QUERY).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(OverpassHttpError);
        expect(err).toMatchObject({ status: 403, message: 'overpass http 403' });
    });

    test('a spent 5xx budget rejects with an OverpassHttpError carrying the status', async () => {
        markLocalDown();
        vi.stubGlobal('fetch', async (url: string) =>
            url === STATUS_URL ? new Response('') : new Response(null, { status: 503 }));

        const failure = runOverpassQuery(QUERY).catch((e: unknown) => e);
        await vi.runAllTimersAsync();
        const err = await failure;

        expect(err).toBeInstanceOf(OverpassHttpError);
        expect(err).toMatchObject({ status: 503 });
    });

    // The status used to be read back out of the error text, so any failure
    // worded like one was treated as that status: this connection error would
    // have counted as a 4xx — no latch, no retry.
    test('a connection failure worded like a status is still a connection failure', async () => {
        vi.stubGlobal('fetch', async (url: string) => {
            if (url === LOCAL_URL) throw new Error('overpass http 400');
            return okJson(ONE_NODE);
        });

        // Handler attached before the timers run: a rejection must fail this
        // test, not surface as an unhandled error beside it.
        const assertion = expect(runOverpassQuery(QUERY)).resolves.toEqual(ONE_NODE.elements);
        await vi.runAllTimersAsync();

        await assertion;
        expect(isLocalDown()).toBe(true);
    });
});
