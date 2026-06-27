// Global concurrency cap + bounded queue for outbound Overpass fetches.
//
// The cache's in-flight dedup only collapses *identical* keys; a client that
// sends many DISTINCT bboxes triggers one live Overpass fetch each, so a burst
// of distinct misses can fan out into many parallel queries and get our shared
// public Overpass instance rate-limited or banned (audit: /junctions abuse).
//
// This gate is source-independent: it holds even when the per-IP HTTP limiter is
// evaded (spoofed X-Forwarded-For) or bypassed entirely (direct tailnet access
// that skips the nginx edge limiter). It bounds the load WE place on Overpass,
// which is the actual upstream we must protect.

const MAX_CONCURRENT = 2;   // Overpass public API allows ~2 slots; be a good citizen
const MAX_QUEUED = 24;      // backpressure cap — beyond this, fail fast (caller → 502)

let active = 0;
const waiters: Array<() => void> = [];

export function overpassInFlight(): number {
    return active;
}

export function overpassQueued(): number {
    return waiters.length;
}

// Run `fn` under the global Overpass concurrency cap. If all slots are busy the
// call waits for one to free; if the wait queue is already full it throws so the
// route surfaces the standard "busy" 502 instead of growing the queue unbounded.
export async function runWithOverpassSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) {
        if (waiters.length >= MAX_QUEUED) {
            throw new Error('overpass throttle: queue full');
        }
        await new Promise<void>(resolve => waiters.push(resolve));
    }
    active++;
    try {
        return await fn();
    } finally {
        active--;
        const next = waiters.shift();
        if (next) next();
    }
}
