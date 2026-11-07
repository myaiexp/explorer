// Pins jsonResponse's Response subset, and stalledFetch: one AbortError, two stall stages, installed via stubGlobal.
// The copies in net/elevation/overpass had already forked the error text
// (finding #12677). A bare fetch with no signal must reject, not hang.
import { describe, test, expect, afterEach, vi } from 'vitest';
import { abortError, jsonResponse, stalledFetch } from './fetch-stub.js';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('jsonResponse', () => {
    test('derives ok from status and resolves json() to the body', async () => {
        expect(jsonResponse({ a: 1 }).ok).toBe(true);
        expect(jsonResponse({}, { status: 204 }).ok).toBe(true);
        expect(jsonResponse({}, { status: 429 }).ok).toBe(false);
        await expect(jsonResponse({ a: 1 }).json()).resolves.toEqual({ a: 1 });
    });

    // Sync reads Retry-After, so headers is always a real Headers — absent
    // means empty, never undefined.
    test('carries headers as a Headers, empty by default', () => {
        expect(jsonResponse({}).headers).toBeInstanceOf(Headers);
        expect([...jsonResponse({}).headers]).toEqual([]);
        const res = jsonResponse({}, { status: 429, headers: { 'Retry-After': '10' } });
        expect(res.headers.get('retry-after')).toBe('10');
    });
});

describe('abortError', () => {
    test('is an AbortError whose message matches a real abort', () => {
        const error = abortError();
        expect(error).toMatchObject({ name: 'AbortError' });
        expect(error.message).toBe('The operation was aborted.');
    });
});

describe('stalledFetch', () => {
    test('never settles until the request signal aborts, and is the global fetch', async () => {
        const fetchMock = stalledFetch();
        expect(globalThis.fetch).toBe(fetchMock);

        const ctl = new AbortController();
        const pending = fetchMock('https://example.test/hang', { signal: ctl.signal });
        let rejected = null;
        pending.catch((error) => { rejected = error; });
        await Promise.resolve();
        expect(rejected).toBeNull();

        ctl.abort();
        await expect(pending).rejects.toMatchObject({
            name: 'AbortError',
            message: 'The operation was aborted.',
        });
    });

    test('body stage returns headers immediately and stalls in json()', async () => {
        const fetchMock = stalledFetch('body');
        const ctl = new AbortController();
        const res = await fetchMock('https://example.test/body', { signal: ctl.signal });
        expect(res).toMatchObject({ ok: true, status: 200 });

        const pending = res.json();
        let rejected = null;
        pending.catch((error) => { rejected = error; });
        await Promise.resolve();
        expect(rejected).toBeNull();

        ctl.abort();
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    test('a call with no signal rejects instead of hanging', async () => {
        const fetchMock = stalledFetch();
        await expect(fetchMock('https://example.test/nosignal')).rejects.toThrow(TypeError);
    });

    test('an unknown stage throws', () => {
        expect(() => stalledFetch('headers')).toThrow(/unknown stage/);
    });
});
