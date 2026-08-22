// Fake-fetch + fake-timer harness for overpass.js tests. No real HTTP.
import { vi } from 'vitest';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_STATUS = 'https://overpass-api.de/api/status';
export const CENTER = { lat: 62, lng: 25 };

export const okJson = (body) => ({ ok: true, status: 200, json: async () => body });
export const errStatus = (status) => ({ ok: false, status, json: async () => ({}) });

export function installFetch({ interpreter, statusBody = '', statusThrows = false }) {
    let i = 0;
    const fetchMock = vi.fn(async (url) => {
        if (url === OVERPASS_STATUS) {
            if (statusThrows) throw new Error('status endpoint down');
            return { ok: true, status: 200, text: async () => statusBody };
        }
        const r = interpreter[Math.min(i, interpreter.length - 1)];
        i++;
        if (r.throw) throw r.throw;
        return r;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

export const interpreterCalls = (m) => m.mock.calls.filter((c) => c[0] === OVERPASS_URL).length;

export function abortErr() {
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

export function northOf(km) {
    return { lat: CENTER.lat + km / 111, lng: CENTER.lng };
}

export async function settle(promise) {
    const settled = promise.then((v) => ({ v }), (e) => ({ e }));
    await vi.runAllTimersAsync();
    return settled;
}
