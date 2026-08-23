// @vitest-environment node
// POST /junctions — start-anchored lookups travel in the JSON body so the
// request line (and therefore nginx access logs) never carries home coords
// (finding #7559). GET query-string anchors are refused in server.test.ts;
// this file covers the POST contract: JSON parse, number coercion, the same
// bbox/anchor validation as GET used to apply, lookup, and the shared
// per-IP rate limit.

import { describe, test, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/overpass.js', () => ({ fetchJunctionsFromOverpass: vi.fn() }));
vi.mock('../src/log.js', () => ({ log: vi.fn(), getRecentLogs: vi.fn() }));

const tmpDirs: string[] = [];
function tmpCacheFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'jpost-'));
    tmpDirs.push(dir);
    return join(dir, 'cache.json');
}

type FetchFn = (req: Request) => Promise<Response>;

async function loadServer() {
    vi.resetModules();
    process.env.CACHE_PATH = tmpCacheFile();
    const overpass = await import('../src/overpass.js');
    const { createApp } = await import('../src/app.js');
    const app = createApp();
    return {
        fetch: app.fetch as FetchFn,
        fetchMock: overpass.fetchJunctionsFromOverpass as unknown as Mock,
    };
}

async function post(
    fetch: FetchFn,
    body: unknown,
    { path = '/junctions', raw, headers }: { path?: string; raw?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
    const res = await fetch(new Request('http://localhost' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw ?? JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
}

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => {
    vi.useRealTimers();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OK_BBOX = '60,24,60.5,24.5';
const ANCHOR = { startLat: 60.2, startLng: 24.2, maxKm: 10 };

describe('POST /junctions — JSON + bbox', () => {
    test('invalid JSON → 400', async () => {
        const { fetch, fetchMock } = await loadServer();
        const { status, body } = await post(fetch, null, { raw: '{not json' });
        expect(status).toBe(400);
        expect(body.error).toMatch(/invalid JSON/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('non-object JSON → 400 body must be a JSON object', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await post(fetch, [OK_BBOX]);
        expect(status).toBe(400);
        expect(body.error).toMatch(/JSON object/);
    });

    test('missing bbox → 400', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await post(fetch, ANCHOR);
        expect(status).toBe(400);
        expect(body.error).toBe('missing bbox');
    });

    test('bbox-only body is legacy mode (no total)', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await post(fetch, { bbox: OK_BBOX });
        expect(status).toBe(200);
        expect(body.cache).toBe('miss');
        expect(body.total).toBeUndefined();
    });
});

describe('POST /junctions — start-anchored', () => {
    test('JSON numbers for start/radius take the anchored path (carries total)', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await post(fetch, { bbox: OK_BBOX, ...ANCHOR });
        expect(status).toBe(200);
        expect(body.cache).toBe('miss');
        expect(typeof body.total).toBe('number');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('string start/radius are accepted the same way', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await post(fetch, {
            bbox: OK_BBOX,
            startLat: '60.2',
            startLng: '24.2',
            maxKm: '10',
        });
        expect(status).toBe(200);
        expect(typeof body.total).toBe('number');
    });

    test('maxKm = 50 (boundary) is accepted', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const { status, body } = await post(fetch, { bbox: OK_BBOX, ...ANCHOR, maxKm: 50 });
        expect(status).toBe(200);
        expect(typeof body.total).toBe('number');
    });

    test('maxKm = 50.001 → 400', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await post(fetch, { bbox: OK_BBOX, ...ANCHOR, maxKm: 50.001 });
        expect(status).toBe(400);
        expect(body.error).toMatch(/maxKm must be in/);
    });

    test('startLat out of range → 400', async () => {
        const { fetch } = await loadServer();
        const { status, body } = await post(fetch, { bbox: OK_BBOX, ...ANCHOR, startLat: 91 });
        expect(status).toBe(400);
        expect(body.error).toMatch(/startLat\/startLng out of range/);
    });

    test('only startLat in the body → 400 incomplete anchor', async () => {
        const { fetch, fetchMock } = await loadServer();
        const { status, body } = await post(fetch, { bbox: OK_BBOX, startLat: 60.2 });
        expect(status).toBe(400);
        expect(body.error).toMatch(/incomplete anchor/);
        expect(body.error).toMatch(/startLng/);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('anchored Overpass failure → 502', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockRejectedValue(new Error('overpass exhausted'));
        const { status, body } = await post(fetch, { bbox: OK_BBOX, ...ANCHOR });
        expect(status).toBe(502);
        expect(body.error).toBe('POI search is busy. Please try again.');
    });

    test('query-string start params on POST are still refused', async () => {
        const { fetch, fetchMock } = await loadServer();
        const { status, body } = await post(
            fetch,
            { bbox: OK_BBOX },
            { path: '/junctions?startLat=60.2&startLng=24.2&maxKm=10' },
        );
        expect(status).toBe(400);
        expect(body.error).toMatch(/POST body/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('POST /junctions — rate limit shares the GET bucket', () => {
    test('the 61st POST 429s', async () => {
        const { fetch, fetchMock } = await loadServer();
        fetchMock.mockResolvedValue([{ lat: 60.2, lng: 24.2 }]);
        const statuses: number[] = [];
        for (let i = 0; i < 61; i++) {
            statuses.push((await post(fetch, { bbox: OK_BBOX })).status);
        }
        expect(statuses.slice(0, 60).every(s => s === 200)).toBe(true);
        expect(statuses[60]).toBe(429);
    });
});
