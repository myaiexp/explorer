// Fake-fetch primitives shared by every suite that stubs global fetch.
/**
 * Each piece has ONE contract. The suite previously carried a same-named local
 * copy of each, and the copies drifted (finding #9762: requestOf's body, three
 * installFetch argument shapes; finding #12677: four stalled-fetch copies whose
 * AbortError text had already forked).
 *
 * - jsonResponse(body, {status})  — the Response subset the app reads.
 * - installCannedFetch(reply)     — every call gets the same reply.
 * - requestOf(fetchMock)          — the single request made, as {url, init, body}.
 * - abortError()                  — the one AbortError those stalls reject with.
 * - stalledFetch() / stalledFetch('body')
 *                                 — never settles until init.signal aborts.
 *                                   'body': headers are 200, json() is what stalls.
 *
 * Suites that route by URL (osrm.test.js, osrm-fallback.test.js) keep their own
 * installer, named after what it keys on; the OSRM response/echo fixtures they
 * share live in ./osrm-fetch.js.
 */
import { expect, vi } from 'vitest';

/**
 * A Response-shaped object with a JSON body. `ok` is derived from `status`,
 * as on a real Response, so a test cannot build a `{ok: true, status: 503}`
 * that no server ever sends.
 */
export function jsonResponse(body, { status = 200 } = {}) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Stub global fetch with one canned reply for every call: a response object,
 * or `{ throw: err }` to reject. Installed via vi.stubGlobal, so the suite's
 * afterEach must call vi.unstubAllGlobals().
 */
export function installCannedFetch(reply) {
    const fetchMock = vi.fn(async () => {
        if (reply.throw) throw reply.throw;
        return reply;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/**
 * The AbortError a stalled fetch rejects with once its signal fires. One
 * message: the net/elevation copies used a trailing period, overpass's
 * abortErr dropped it (finding #12677).
 */
export function abortError() {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    return error;
}

// A fetch that never settles until init.signal aborts. A call with no signal
// rejects (init.signal throws) rather than hanging — a bare fetch() passes
// none, and a stub that swallowed that would hide a wrapper that stopped
// forwarding the signal. 'body' is the other hang: headers have arrived and
// json() is what never resolves.
function stallUntilAbort(init) {
    return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()));
    });
}

export function stalledFetch(stage = 'request') {
    if (stage !== 'request' && stage !== 'body') {
        throw new Error(`stalledFetch: unknown stage '${stage}'`);
    }
    const fetchMock = vi.fn((url, init) => {
        if (stage === 'body') {
            return Promise.resolve({ ok: true, status: 200, json: () => stallUntilAbort(init) });
        }
        return stallUntilAbort(init);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

/**
 * The one request the code under test made. `url` is resolved against the
 * production origin so a same-origin path ('/api/junctions/pois') still has a
 * pathname and search to inspect; `init` is `{}` when none was passed; `body`
 * is the parsed JSON body, or undefined when there is none.
 */
export function requestOf(fetchMock) {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init = {}] = fetchMock.mock.calls[0];
    return {
        url: new URL(url, 'https://mase.fi'),
        init,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
}
