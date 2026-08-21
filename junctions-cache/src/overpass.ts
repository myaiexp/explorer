// Overpass query + retry with timeout.

import { log } from './log.js';

const OVERPASS_URL    = 'https://overpass-api.de/api/interpreter';
const OVERPASS_STATUS = 'https://overpass-api.de/api/status';
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export type LatLng = { lat: number; lng: number };

// TWIN: explorer/overpass.js carries the same HIGHWAY_EXCLUDE presets and the
// same status-parse + retry loop (queryOverpass there / fetchJunctionsFromOverpass
// here). Deliberately independent — separate deployables (this ships to shelly,
// that serves as a raw static asset), so there is no build step to share a
// constant through. These exclude strings MUST stay byte-identical to the
// frontend's or server-cached junctions stop matching what a direct frontend
// Overpass call would compute. explorer/tests/overpass-exclude-parity.test.js
// fails RED if the two copies drift.
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

async function getStatusWaitSec(): Promise<number> {
    try {
        const r = await fetchWithTimeout(OVERPASS_STATUS, {}, 5_000);
        const text = await r.text();
        const m = text.match(/Slot available after: .+, in (\d+) seconds/);
        return m && m[1] ? Math.min(parseInt(m[1], 10) + 2, 60) : 15;
    } catch {
        return 15;
    }
}

// Returns the array of junction LatLng. Throws on hard failure.
export async function fetchJunctionsFromOverpass(bbox: Bbox, exclude: ExcludePreset): Promise<LatLng[]> {
    const query = buildQuery(bbox, exclude);
    let lastErr: Error | null = null;
    // Track the last retryable status (429/504) so an all-retries-exhausted
    // failure surfaces *which* upstream condition exhausted us rather than the
    // generic 'overpass exhausted' — the 429/504 branch `continue`s and would
    // otherwise leave lastErr null, swallowing the status (audit #3158).
    let lastRetryStatus: number | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            const wait = await getStatusWaitSec();
            log('WARN', { event: 'overpass_retry', attempt, wait_sec: wait });
            await sleep(wait * 1000);
        }
        try {
            const res = await fetchWithTimeout(OVERPASS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'wander-junctions/0.1 (mase@tuta.com)'
                },
                body: 'data=' + encodeURIComponent(query)
            }, ATTEMPT_TIMEOUT_MS);
            if (res.status === 429 || res.status === 504) {
                lastRetryStatus = res.status;
                continue;
            }
            if (!res.ok) throw new Error(`overpass http ${res.status}`);
            const data = await res.json() as { elements: Array<{ type: string; nodes?: number[]; id: number; lat?: number; lon?: number }> };
            return parseJunctions(data.elements);
        } catch (e) {
            lastErr = e as Error;
            log('WARN', { event: 'overpass_attempt_failed', attempt, err: lastErr.message });
            // Non-transient client errors (4xx except 429, which continues above)
            // won't change on retry — rethrow immediately so we don't burn two more
            // status-endpoint fetches + back-off sleeps (idea #1601).
            const m = lastErr.message.match(/^overpass http (\d+)$/);
            if (m) {
                const code = parseInt(m[1]!, 10);
                if (code >= 400 && code < 500) throw lastErr;
            }
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

function parseJunctions(elements: Array<{ type: string; nodes?: number[]; id: number; lat?: number; lon?: number }>): LatLng[] {
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
