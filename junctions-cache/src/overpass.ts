// Overpass query + retry with timeout, local-first with public fallback.

import { log } from './log.js';
import { BodyTooLargeError, readTextCapped } from './lib/read-capped.js';
import { currentTarget, markLocalDown, STATUS_URL, type Target } from './overpass-target.js';
import { recordLocalDataTimestamp, type Osm3sHeader } from './overpass-freshness.js';

// One attempt's whole budget: headers and body together.
const ATTEMPT_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;
// Hard cap before JSON.parse so a runaway Overpass dump cannot OOM the
// process. 32 MiB is above a typical walk-bbox response
// and well under MemoryMax=512M.
export const OVERPASS_MAX_BYTES = 32 * 1024 * 1024;

export type LatLng = { lat: number; lng: number };

// Overpass answered with a non-2xx status. Carries the number so failurePolicy
// can branch on it.
export class OverpassHttpError extends Error {
    constructor(public readonly status: number) {
        super(`overpass http ${status}`);
        this.name = 'OverpassHttpError';
    }
}

// Overpass reported its own timeout or out-of-memory inside a 200, as a `remark`
// beside truncated or empty `elements`. Its own class because failurePolicy has
// to tell it apart from a connection failure, which latches local down. A
// too-big query is not an unhealthy instance, and it would fail identically on
// the fallback.
export class OverpassIncompleteError extends Error {
    constructor(public readonly remark: string) {
        super(`overpass incomplete: ${remark}`);
        this.name = 'OverpassIncompleteError';
    }
}

// Deliberately permissive: one shape for every query we run. Junctions read
// `nodes`/`lat`/`lon`; the POI and road fetchers read `center` and `tags`.
export type OverpassElement = {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    nodes?: number[];
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
};

// The road-filter presets. The frontend POSTs /pois and /roads and names a
// preset by keyword ('default' | 'winter'); this is the only copy. Keep it
// server-side: a client that can only name a preset cannot inject a filter into
// our own Overpass instance. (The twin that must stay in step is
// poi-catalog.ts <-> wander/poi-types.js.)
export type ExcludePreset = 'default' | 'winter';
export const HIGHWAY_EXCLUDE: Record<ExcludePreset, string> = {
    default: 'motorway|motorway_link|trunk|trunk_link|service|steps',
    winter:  'motorway|motorway_link|trunk|trunk_link|service|steps|path|track|footway|bridleway|cycleway|pedestrian'
};

export type Bbox = { minLat: number; minLng: number; maxLat: number; maxLng: number };

function buildQuery(bbox: Bbox, exclude: ExcludePreset): string {
    const { minLat, minLng, maxLat, maxLng } = bbox;
    return `
[out:json][timeout:15];
way["highway"]["highway"!~"${HIGHWAY_EXCLUDE[exclude]}"](${minLat},${minLng},${maxLat},${maxLng});
out body;
>;
out skel qt;`.trim();
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// Run one request under one abort deadline, held until `request` settles. The
// timer has to outlive fetch(), which resolves at the headers: a body that stalls
// after them would otherwise keep its Overpass slot until undici's own 300 s gap
// timeout. An abort rejects a body read in progress, so a stall reaches the
// caller's catch like any other failed request. The closing abort is a no-op for
// a body read to the end; for one left unread (an error status) it closes the
// connection, which nothing else would until GC.
async function withDeadline<T>(ms: number, request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        return await request(ctl.signal);
    } finally {
        clearTimeout(timer);
        ctl.abort();
    }
}

// Public-only. Parses the public instance's slot-availability body; the local
// instance has no slot concept, so a local retry must never come through here
// (a 60 s sleep for a local hiccup is a wrecked request).
async function getStatusWaitSec(): Promise<number> {
    try {
        const text = await withDeadline(STATUS_TIMEOUT_MS, async (signal) => {
            const r = await fetch(STATUS_URL, { signal });
            return r.text();
        });
        const m = text.match(/Slot available after: .+, in (\d+) seconds/);
        return m && m[1] ? Math.min(parseInt(m[1], 10) + 2, 60) : 15;
    } catch {
        return 15;
    }
}

// The slot probe exists to honour the PUBLIC instance's back-off, so it runs only
// when public itself just pushed back. Two cases it deliberately skips:
//   - a local retry: there are no slots to wait for, and a 15–60 s sleep would
//     turn a momentary local hiccup into a wrecked request;
//   - the local→public handover: local failing carries no slot signal, and
//     probing there would stall the FIRST request of every latch window by 15 s.
//     That window is exactly when self-hosted Overpass is down, so the fallback
//     would be visibly slow precisely when it is load-bearing.
async function paceRetry(attempt: number, local: boolean, prevWasPublic: boolean): Promise<void> {
    const wait = (!local && prevWasPublic) ? await getStatusWaitSec() : 0;
    log('WARN', { event: 'overpass_retry', attempt, wait_sec: wait, local });
    if (wait > 0) await sleep(wait * 1000);
}

// One POST to `target`, the body read included in its deadline. Returns
// data.elements; every failure is a throw for runOverpassQuery to judge.
async function attemptQuery(target: Target, query: string, attempt: number): Promise<OverpassElement[]> {
    return withDeadline(ATTEMPT_TIMEOUT_MS, async (signal) => {
        const res = await fetch(target.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'wander-junctions/0.1 (mase@tuta.com)'
            },
            body: 'data=' + encodeURIComponent(query),
            signal,
        });
        if (!res.ok) throw new OverpassHttpError(res.status);
        const text = await readTextCapped(
            res.body,
            OVERPASS_MAX_BYTES,
            'overpass',
            res.headers.get('content-length'),
        );
        const data = JSON.parse(text) as {
            elements: OverpassElement[];
            osm3s?: Osm3sHeader;
            remark?: string;
        };
        // Free freshness reading: the answer already says how current its OSM
        // data is. Local only — a fallback answer describes overpass-api.de, not
        // the instance that might be wedged.
        if (target.local) recordLocalDataTimestamp(data.osm3s);
        // Overpass reports its own timeout and out-of-memory failures INSIDE a
        // 200, as a `remark` beside a truncated or empty `elements`. Taken at
        // face value that is a silently partial pool — and a non-empty one would
        // then sit in the cache for the full 30-day TTL. Treat it as a failed
        // attempt so the retry budget applies and the caller sees a reason.
        if (typeof data.remark === 'string' && data.remark.trim() !== '') {
            log('WARN', {
                event: 'overpass_remark',
                attempt,
                local: target.local,
                elements: Array.isArray(data.elements) ? data.elements.length : 0,
                remark: data.remark,
            });
            throw new OverpassIncompleteError(data.remark);
        }
        return data.elements;
    });
}

// 429 and 504 are the upstream asking us to come back later. They are retried
// like other failures but reported differently once the budget is spent.
function isPushback(err: Error): err is OverpassHttpError {
    return err instanceof OverpassHttpError && (err.status === 429 || err.status === 504);
}

// What a failed attempt means: whether it is evidence the local instance is down,
// and whether another attempt could go differently.
function failurePolicy(err: Error): { latchLocal: boolean; retry: boolean } {
    // A body over the cap will not shrink on retry, so stop rather than burn two
    // more Overpass slots. It is our bbox being too big, not
    // local being unhealthy.
    if (err instanceof BodyTooLargeError) return { latchLocal: false, retry: false };
    // A remark means the query was too big for its timeout, not that the
    // instance is unhealthy, and it would fail identically on the fallback.
    if (err instanceof OverpassIncompleteError) return { latchLocal: false, retry: true };
    if (err instanceof OverpassHttpError) {
        // A 4xx will not change on retry, so skip the status-endpoint fetches and
        // back-off sleeps. It would also fail identically against
        // the fallback, so latching would ship our bad query to a public server
        // and cost five minutes of local for nothing. 429 is the exception: a
        // slot/rate signal, retryable on the same target.
        const permanent = err.status >= 400 && err.status < 500 && err.status !== 429;
        return { latchLocal: err.status >= 500, retry: !permanent };
    }
    // A connection failure, a timeout or an unreadable answer.
    return { latchLocal: true, retry: true };
}

// POST `query` to the current target with the retry budget; returns
// data.elements. Every outbound Overpass query in this service goes through
// here — routing a query around it would put that traffic back on the public
// instance unconditionally, which is exactly what the local-first target
// exists to stop.
export async function runOverpassQuery(query: string): Promise<OverpassElement[]> {
    let lastErr: Error | null = null;
    // Kept apart from lastErr so that a failure with its own clear message wins
    // the terminal throw, and all-pushback exhaustion still names *which*
    // upstream condition exhausted us.
    let lastRetryStatus: number | null = null;
    // Whether the attempt just finished actually went to the public instance.
    // Only such an attempt can have produced a slot signal worth waiting on.
    let prevWasPublic = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Read fresh every attempt: an attempt that trips the latch sends the
        // *next* attempt of this same call to the public fallback.
        const target = currentTarget();
        if (attempt > 0) await paceRetry(attempt, target.local, prevWasPublic);
        prevWasPublic = !target.local;
        try {
            return await attemptQuery(target, query, attempt);
        } catch (e) {
            const err = e as Error;
            if (isPushback(err)) {
                lastRetryStatus = err.status;
            } else {
                lastErr = err;
                log('WARN', { event: 'overpass_attempt_failed', attempt, local: target.local, err: err.message });
            }
            const { latchLocal, retry } = failurePolicy(err);
            if (target.local && latchLocal) markLocalDown();
            if (!retry) throw err;
        }
    }
    throw lastErr ?? new Error(
        lastRetryStatus != null
            ? `overpass retries exhausted (http ${lastRetryStatus})`
            : 'overpass exhausted'
    );
}

// Returns the array of junction LatLng. Throws on hard failure.
export async function fetchJunctionsFromOverpass(bbox: Bbox, exclude: ExcludePreset): Promise<LatLng[]> {
    return parseJunctions(await runOverpassQuery(buildQuery(bbox, exclude)));
}

function parseJunctions(elements: OverpassElement[]): LatLng[] {
    const wayCount = new Map<number, number>();
    const coords = new Map<number, LatLng>();
    for (const el of elements) {
        if (el.type === 'way' && Array.isArray(el.nodes)) {
            for (const id of el.nodes) wayCount.set(id, (wayCount.get(id) ?? 0) + 1);
        } else if (el.type === 'node' && el.lat != null && el.lon != null) {
            coords.set(el.id, { lat: el.lat, lng: el.lon });
        }
    }
    const out: LatLng[] = [];
    for (const [id, count] of wayCount) {
        if (count < 2) continue;
        const c = coords.get(id);
        if (c) out.push(c);
    }
    return out;
}
