// Overpass query + retry with timeout, local-first with public fallback.

import { log } from './log.js';
import { BodyTooLargeError, readTextCapped } from './lib/read-capped.js';
import { currentTarget, markLocalDown, STATUS_URL } from './overpass-target.js';
import { recordLocalDataTimestamp, type Osm3sHeader } from './overpass-freshness.js';

const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
// Hard cap before JSON.parse so a runaway Overpass dump cannot OOM the
// process (finding #7755). 32 MiB is above a typical walk-bbox response
// and well under MemoryMax=512M.
export const OVERPASS_MAX_BYTES = 32 * 1024 * 1024;

export type LatLng = { lat: number; lng: number };

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

// The road-filter presets. NO LONGER A TWIN: explorer/overpass.js used to carry
// byte-identical HIGHWAY_EXCLUDE_DEFAULT / _WINTER copies plus its own
// status-parse + retry loop, kept in lockstep by
// explorer/tests/overpass-exclude-parity.test.js. The frontend now POSTs /pois
// and /roads and names a preset by keyword ('default' | 'winter'), so this is
// the single copy and that parity test is gone with its twin. Do not
// reintroduce a client-side copy: a client that can only name a preset cannot
// inject a filter into our own Overpass instance. (The live twin that remains
// is poi-catalog.ts ↔ explorer/poi-types.js.)
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

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        return await fetch(url, { ...init, signal: ctl.signal });
    } finally {
        clearTimeout(timer);
    }
}

// Public-only. Parses the public instance's slot-availability body; the local
// instance has no slot concept, so a local retry must never come through here
// (a 60 s sleep for a local hiccup is a wrecked request).
async function getStatusWaitSec(): Promise<number> {
    try {
        const r = await fetchWithTimeout(STATUS_URL, {}, 5_000);
        const text = await r.text();
        const m = text.match(/Slot available after: .+, in (\d+) seconds/);
        return m && m[1] ? Math.min(parseInt(m[1], 10) + 2, 60) : 15;
    } catch {
        return 15;
    }
}

// POST `query` to the current target with the retry budget; returns
// data.elements. Every outbound Overpass query in this service goes through
// here — routing a query around it would put that traffic back on the public
// instance unconditionally, which is exactly what the local-first target
// exists to stop.
export async function runOverpassQuery(query: string): Promise<OverpassElement[]> {
    let lastErr: Error | null = null;
    // Track the last retryable status (429/504) so an all-retries-exhausted
    // failure surfaces *which* upstream condition exhausted us rather than the
    // generic 'overpass exhausted' — the 429/504 branch `continue`s and would
    // otherwise leave lastErr null, swallowing the status (audit #3158).
    let lastRetryStatus: number | null = null;
    // Whether the attempt just finished actually went to the public instance.
    // Only such an attempt can have produced a slot signal worth waiting on.
    let prevWasPublic = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        // Read fresh every attempt: an attempt that trips the latch sends the
        // *next* attempt of this same call to the public fallback.
        const target = currentTarget();
        if (attempt > 0) {
            // The slot probe exists to honour the PUBLIC instance's back-off,
            // so it runs only when public itself just pushed back. Two cases it
            // deliberately skips:
            //   - a local retry: there are no slots to wait for, and a 15–60 s
            //     sleep would turn a momentary local hiccup into a wrecked
            //     request;
            //   - the local→public handover: local failing carries no slot
            //     signal, and probing there would stall the FIRST request of
            //     every latch window by 15 s. That window is exactly when
            //     self-hosted Overpass is down, so the fallback would be
            //     visibly slow precisely when it is load-bearing.
            const wait = (!target.local && prevWasPublic) ? await getStatusWaitSec() : 0;
            log('WARN', { event: 'overpass_retry', attempt, wait_sec: wait, local: target.local });
            if (wait > 0) await sleep(wait * 1000);
        }
        prevWasPublic = !target.local;
        try {
            const res = await fetchWithTimeout(target.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'wander-junctions/0.1 (mase@tuta.com)'
                },
                body: 'data=' + encodeURIComponent(query)
            }, ATTEMPT_TIMEOUT_MS);
            if (res.status === 429 || res.status === 504) {
                lastRetryStatus = res.status;
                // 504 is a 5xx: local gateway-timed-out is a local fault, so it
                // latches (and the retry lands on public). 429 is not — it is a
                // slot/rate signal, retryable on the same target.
                if (target.local && res.status === 504) markLocalDown();
                continue;
            }
            if (!res.ok) throw new Error(`overpass http ${res.status}`);
            const text = await readTextCapped(
                res.body,
                OVERPASS_MAX_BYTES,
                'overpass',
                res.headers.get('content-length'),
            );
            const data = JSON.parse(text) as { elements: OverpassElement[]; osm3s?: Osm3sHeader };
            // Free freshness reading: the answer already says how current its
            // OSM data is. Local only — a fallback answer describes
            // overpass-api.de, not the instance that might be wedged.
            if (target.local) recordLocalDataTimestamp(data.osm3s);
            return data.elements;
        } catch (e) {
            lastErr = e as Error;
            log('WARN', { event: 'overpass_attempt_failed', attempt, local: target.local, err: lastErr.message });
            // A body already over the cap will not shrink on retry — fail now
            // rather than burning two more Overpass slots (finding #7755). Note
            // this precedes the latch: an oversized response is our bbox being
            // too big, not local being unhealthy.
            if (lastErr instanceof BodyTooLargeError) throw lastErr;
            const m = lastErr.message.match(/^overpass http (\d+)$/);
            const code = m ? parseInt(m[1]!, 10) : null;
            // Local is down for connection failures/timeouts (code === null) and
            // 5xx — but NOT 4xx: a malformed query fails identically against the
            // fallback, so latching would ship our bad query to a public server
            // and cost us five minutes of local for nothing.
            if (target.local && (code === null || code >= 500)) markLocalDown();
            // Non-transient client errors (4xx except 429, which continues above)
            // won't change on retry — rethrow immediately so we don't burn two more
            // status-endpoint fetches + back-off sleeps (idea #1601).
            if (code !== null && code >= 400 && code < 500) throw lastErr;
        }
    }
    // A caught exception (e.g. http 400, network/timeout) already carries a clear
    // message, so prefer it; otherwise every attempt was a retryable 429/504 and
    // we surface that status explicitly instead of swallowing it.
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
