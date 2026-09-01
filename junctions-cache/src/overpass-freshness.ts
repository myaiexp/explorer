// How old the self-hosted Overpass instance's OSM data was the last time we
// asked it. Records only, never queries.
//
// wander-overpass keeps itself current by applying Geofabrik finland-updates
// diffs on an hourly timer, and the classic failure of that setup is the updater
// wedging while the instance keeps serving: queries succeed, data quietly rots,
// and nothing notices for months. Every Overpass answer carries an
// osm3s.timestamp_osm_base header saying how current its data is, so recording
// it off the queries we already make turns that into an observable number on
// /health.
//
// PASSIVE ON PURPOSE. /health is publicly reachable through the VPS proxy at
// /api/junctions/health, so probing Overpass from it would let any caller drive
// outbound load and — since every query in this service latches the target on
// failure — let a health check reroute production traffic to the public
// fallback. Instead observedAt reports when the reading was taken, so an
// operator can tell "the data is old" from "we have not asked lately".
//
// LOCAL ONLY. A public-fallback answer's timestamp describes overpass-api.de,
// not our instance, so recording it would report someone else's freshness as
// our own — exactly backwards while local is the thing that might be wedged.

// The osm3s header Overpass returns alongside `elements`. Optional throughout:
// a hand-rolled or mocked response may omit it, and a missing timestamp is
// "unknown", never an error.
export type Osm3sHeader = { timestamp_osm_base?: string };

let dataTimestampMs: number | null = null;   // parsed timestamp_osm_base
let dataTimestamp: string | null = null;     // the raw ISO string, as served
let observedAtMs: number | null = null;      // when we read it

// Record the data timestamp from a LOCAL Overpass answer. Ignores a missing or
// unparseable value rather than clearing what we already knew — an answer whose
// header we cannot read is no evidence about freshness either way.
export function recordLocalDataTimestamp(osm3s: Osm3sHeader | undefined): void {
    const raw = osm3s?.timestamp_osm_base;
    if (typeof raw !== 'string') return;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return;
    dataTimestamp = raw;
    dataTimestampMs = ms;
    observedAtMs = Date.now();
}

export type Freshness = {
    // Data timestamp the local instance last reported, and its age now. Null
    // until the first local answer since start-up.
    dataTimestamp: string | null;
    dataAgeSec: number | null;
    // When that reading was taken. A large observedAgeSec with a small
    // dataAgeSec means the number is simply old news, not that data is stale.
    observedAt: string | null;
    observedAgeSec: number | null;
};

export function getFreshness(): Freshness {
    const now = Date.now();
    return {
        dataTimestamp,
        dataAgeSec: dataTimestampMs === null ? null : Math.round((now - dataTimestampMs) / 1000),
        observedAt: observedAtMs === null ? null : new Date(observedAtMs).toISOString(),
        observedAgeSec: observedAtMs === null ? null : Math.round((now - observedAtMs) / 1000),
    };
}

// Test seam: clears the recording so module state doesn't leak between tests
// (twin of _resetLatch in overpass-target.ts).
export function _resetFreshness(): void {
    dataTimestampMs = null;
    dataTimestamp = null;
    observedAtMs = null;
}
