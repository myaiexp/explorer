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

// Same signature as fetch(url, init), plus a per-call timeout (ms). Rejects with
// an AbortError if the response doesn't arrive in time; callers already treat a
// fetch rejection as a network failure, so no call site needs special handling.
async function fetchWithTimeout(url, init = {}, ms = FETCH_TIMEOUT_MS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
}

globalThis.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
globalThis.fetchWithTimeout = fetchWithTimeout;
