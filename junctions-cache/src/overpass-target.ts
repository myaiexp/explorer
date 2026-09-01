// Which Overpass instance the next request goes to: the self-hosted local one,
// or the public fallback while local is latched down.
//
// TWIN of the frontend's isSelfHostedDown latch in explorer/osrm.js: after a
// local failure we stop hammering a box we already know is unreachable and send
// traffic to the public instance for LOCAL_DOWN_LATCH_MS, then probe local
// again. Deliberately independent copies — separate deployables, no shared
// build step.
//
// Module-scoped mutable state is safe here: the latch is a single number whose
// only writes are "set to now + 5 min" and "clear", so concurrent requests
// racing it can at worst re-latch an already-latched window. overpass-limit.ts
// caps concurrent outbound queries at 2 regardless.

// Read once at load, like CACHE_PATH in cache-store.ts. Exported so overpass.ts
// and the tests share one source of truth rather than re-deriving the strings.
export const LOCAL_URL    = process.env.OVERPASS_URL ?? 'http://127.0.0.1:5002/api/interpreter';
export const FALLBACK_URL = process.env.OVERPASS_FALLBACK_URL ?? 'https://overpass-api.de/api/interpreter';
// Slot-availability probe. Public-only: the local instance has no slot concept
// and serves no such endpoint, so nothing on the local path may fetch this.
export const STATUS_URL   = process.env.OVERPASS_STATUS_URL ?? 'https://overpass-api.de/api/status';

export const LOCAL_DOWN_LATCH_MS = 5 * 60_000;

export type Target = { url: string; local: boolean };

let localDownUntil = 0;   // Date.now() ms; 0 means "not latched"

// True while we're skipping the self-hosted instance entirely.
export function isLocalDown(): boolean {
    return Date.now() < localDownUntil;
}

// Latch local as down for LOCAL_DOWN_LATCH_MS. Called for connection failures
// and 5xx from local — never for a 4xx, which means OUR query is malformed and
// would fail identically against the fallback (so latching would both ship a
// bad query to a public server and cost us five minutes of local for nothing).
export function markLocalDown(): void {
    localDownUntil = Date.now() + LOCAL_DOWN_LATCH_MS;
}

// Local unless the down-latch is live; then the public fallback.
export function currentTarget(): Target {
    return isLocalDown()
        ? { url: FALLBACK_URL, local: false }
        : { url: LOCAL_URL, local: true };
}

// Test seam: clears the latch so module state doesn't leak between tests.
export function _resetLatch(): void {
    localDownUntil = 0;
}
