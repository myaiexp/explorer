// Shared fetch-with-timeout wrapper for every frontend network call.
// AbortController + setTimeout so a stalled connection rejects promptly instead
// of hanging on the browser's multi-minute socket default — which would leave
// the generate spinner up with a dead button (withLoading), or freeze the sync
// outbox with _flushing stuck true. Mirrors junctions-cache/src/overpass.ts's
// fetchWithTimeout. No DOM. Loaded first, before any module that fetches.

// Default per-call ceiling. OSRM (self-hosted, fast), Nominatim, and the sync
// API all fit well under this; the junctions-cache pool endpoints pass an
// explicit larger ms, since a cache miss there has to reach Overpass.
const FETCH_TIMEOUT_MS = 20000;

// Same signature as fetch(url, init), plus a per-call timeout (ms). The timer
// covers the body read too: clearing it when the headers arrive leaves
// res.json() able to stall withLoading forever. A reply with no body method
// (a test double that is just {ok, status}) clears immediately. unref so an
// unread real Response does not hold the process open. Rejects with an
// AbortError; callers already treat a fetch rejection as a network failure.
async function fetchWithTimeout(url, init = {}, ms = FETCH_TIMEOUT_MS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    if (typeof timer.unref === 'function') timer.unref();
    let cleared = false;
    const clear = () => {
        if (cleared) return;
        cleared = true;
        clearTimeout(timer);
    };
    try {
        const res = await fetch(url, { ...init, signal: ctl.signal });
        const methods = ['json', 'text', 'arrayBuffer', 'blob'];
        const present = methods.filter((method) => typeof res[method] === 'function');
        if (present.length === 0) {
            clear();
            return res;
        }
        for (const method of present) {
            const orig = res[method].bind(res);
            res[method] = async (...args) => {
                try {
                    return await orig(...args);
                } finally {
                    clear();
                }
            };
        }
        return res;
    } catch (err) {
        clear();
        throw err;
    }
}

globalThis.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
globalThis.fetchWithTimeout = fetchWithTimeout;
