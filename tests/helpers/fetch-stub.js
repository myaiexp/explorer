// Fake-fetch primitives shared by every suite that stubs global fetch.
/**
 * Three pieces, each with ONE contract — the suite previously carried a
 * same-named local copy of each, and the copies had drifted apart (finding
 * #9762): two `requestOf`s disagreed on whether the body came back parsed,
 * three `installFetch`es took three incompatible argument shapes.
 *
 * - jsonResponse(body, {status})  — the Response subset the app reads.
 * - installCannedFetch(reply)     — every call gets the same reply.
 * - requestOf(fetchMock)          — the single request made, as {url, init, body}.
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
