// Parse and validate /pois and /roads POST bodies into a checked anchor plus
// the query-kind selector.

import type { ExcludePreset } from '../overpass.js';
import { MAX_RADIUS_KM, type ParseFailure } from './parse-request.js';
import { filtersForTypes, type TypesSelector } from '../poi-catalog.js';

// Unlike the junctions anchor, `bbox` is NOT part of a pool request — the
// server derives the fetch bbox from the start and radius. minKm defaults to 0;
// maxKm is required.
export type PoolAnchor = { startLat: number; startLng: number; minKm: number; maxKm: number };

export type ParsedPoi = { ok: true; anchor: PoolAnchor; types: TypesSelector };
export type ParsedRoad = { ok: true; anchor: PoolAnchor; exclude: ExcludePreset };

// Numbers are the natural POST-JSON form, but the frontend has historically
// sent stringified values too, so accept either. Anything else (null, object,
// empty string, NaN) is absent.
function numberField(v: unknown): number | undefined {
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
}

function parseAnchor(o: Record<string, unknown>): { ok: true; anchor: PoolAnchor } | ParseFailure {
    const startLat = numberField(o.startLat);
    const startLng = numberField(o.startLng);
    const maxKm = numberField(o.maxKm);
    const minKm = o.minKm == null ? 0 : numberField(o.minKm);

    if (startLat === undefined || startLng === undefined) {
        return { ok: false, error: 'startLat and startLng are required' };
    }
    if (maxKm === undefined) return { ok: false, error: 'maxKm is required' };
    if (minKm === undefined) return { ok: false, error: 'minKm must be a number' };

    if (startLat < -90 || startLat > 90 || startLng < -180 || startLng > 180) {
        return { ok: false, error: 'startLat/startLng out of range' };
    }
    if (maxKm <= 0 || maxKm > MAX_RADIUS_KM) {
        return { ok: false, error: `maxKm must be in (0, ${MAX_RADIUS_KM}]` };
    }
    if (minKm < 0) return { ok: false, error: 'minKm must not be negative' };
    // An inverted or empty annulus can only ever return nothing, and would look
    // to the client like "no places nearby" rather than a bad request.
    if (minKm >= maxKm) return { ok: false, error: 'minKm must be less than maxKm' };

    return { ok: true, anchor: { startLat, startLng, minKm, maxKm } };
}

function asObject(body: unknown): Record<string, unknown> | null {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
}

export function parsePoiRequest(body: unknown): ParsedPoi | ParseFailure {
    const o = asObject(body);
    if (!o) return { ok: false, error: 'body must be a JSON object' };

    const anchor = parseAnchor(o);
    if (!anchor.ok) return anchor;

    // Keys only, never raw filter strings — see poi-catalog.ts. filtersForTypes
    // is the single validator so the route cannot accept a key the resolver
    // would later reject.
    const raw = o.types;
    const types: TypesSelector = raw === 'all' ? 'all' : (raw as string[]);
    const resolved = filtersForTypes(types);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    return { ok: true, anchor: anchor.anchor, types };
}

export function parseRoadRequest(body: unknown): ParsedRoad | ParseFailure {
    const o = asObject(body);
    if (!o) return { ok: false, error: 'body must be a JSON object' };

    const anchor = parseAnchor(o);
    if (!anchor.ok) return anchor;

    const raw = o.exclude ?? 'default';
    if (raw !== 'default' && raw !== 'winter') {
        return { ok: false, error: 'exclude must be "default" or "winter"' };
    }

    return { ok: true, anchor: anchor.anchor, exclude: raw };
}
