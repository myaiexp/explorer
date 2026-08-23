// Parse and cap /junctions query/JSON-body parameters.

import type { Bbox, ExcludePreset } from '../overpass.js';

export const MAX_AREA_DEG2 = 4;     // hard cap on bbox area to prevent abuse (~ 444km × 222km in Finland)
export const MAX_RADIUS_KM = 50;    // sanity cap on start-anchored radius

export type Anchor = { startLat: number; startLng: number; maxKm: number };

export type JunctionsQuery = {
    bbox?: string;
    exclude?: string;
    startLat?: string;
    startLng?: string;
    maxKm?: string;
};

export type ParsedJunctionsQuery = {
    ok: true;
    bbox: Bbox;
    exclude: ExcludePreset;
    bboxLog: string;
    anchor: Anchor | null;
};

export type ParseFailure = { ok: false; error: string };

export type FieldsResult = { ok: true; fields: JunctionsQuery } | ParseFailure;

// Coerce a JSON body field into the string shape parseJunctionsQuery
// already accepts. Numbers are the natural POST-JSON form (the frontend
// sends them); empty string / null / nested objects are treated as absent.
function stringifyField(v: unknown): string | undefined {
    if (v == null) return undefined;
    if (typeof v === 'string') return v === '' ? undefined : v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return String(v);
    return undefined;
}

export function fieldsFromUnknown(body: unknown): FieldsResult {
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'body must be a JSON object' };
    }
    const o = body as Record<string, unknown>;
    return {
        ok: true,
        fields: {
            bbox: stringifyField(o.bbox),
            exclude: stringifyField(o.exclude),
            startLat: stringifyField(o.startLat),
            startLng: stringifyField(o.startLng),
            maxKm: stringifyField(o.maxKm),
        },
    };
}

export function parseJunctionsQuery(q: JunctionsQuery): ParsedJunctionsQuery | ParseFailure {
    const bboxStr = q.bbox;
    const excludeStr = q.exclude ?? 'default';
    const startLatStr = q.startLat;
    const startLngStr = q.startLng;
    const maxKmStr = q.maxKm;

    if (!bboxStr) return { ok: false, error: 'missing bbox' };
    if (excludeStr !== 'default' && excludeStr !== 'winter') {
        return { ok: false, error: 'exclude must be "default" or "winter"' };
    }
    const exclude = excludeStr;

    const parts = bboxStr.split(',').map(s => parseFloat(s));
    if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) {
        return { ok: false, error: 'bbox must be minLat,minLng,maxLat,maxLng' };
    }
    const [minLat, minLng, maxLat, maxLng] = parts as [number, number, number, number];
    if (minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180 || minLat >= maxLat || minLng >= maxLng) {
        return { ok: false, error: 'bbox out of range or inverted' };
    }
    if ((maxLat - minLat) * (maxLng - minLng) > MAX_AREA_DEG2) {
        return { ok: false, error: 'bbox too large' };
    }

    const bbox: Bbox = { minLat, minLng, maxLat, maxLng };
    const bboxLog = `${minLat.toFixed(4)},${minLng.toFixed(4)},${maxLat.toFixed(4)},${maxLng.toFixed(4)}`;

    // Anchor params are all-or-nothing: startLat, startLng and maxKm must be
    // supplied together. A partial set is a malformed request — silently falling
    // through to bbox mode would look like success while ignoring the intended
    // anchoring (audit #3159).
    const anchorEntries: [string, string | undefined][] = [
        ['startLat', startLatStr],
        ['startLng', startLngStr],
        ['maxKm', maxKmStr],
    ];
    const presentAnchorCount = anchorEntries.filter(([, v]) => v != null).length;
    if (presentAnchorCount > 0 && presentAnchorCount < anchorEntries.length) {
        const missing = anchorEntries.filter(([, v]) => v == null).map(([k]) => k);
        return {
            ok: false,
            error: `incomplete anchor: missing ${missing.join(', ')} (startLat, startLng, maxKm must be supplied together)`,
        };
    }

    if (startLatStr == null || startLngStr == null || maxKmStr == null) {
        return { ok: true, bbox, exclude, bboxLog, anchor: null };
    }

    const startLat = parseFloat(startLatStr);
    const startLng = parseFloat(startLngStr);
    const maxKm = parseFloat(maxKmStr);
    if (Number.isNaN(startLat) || Number.isNaN(startLng) || Number.isNaN(maxKm)) {
        return { ok: false, error: 'invalid startLat/startLng/maxKm' };
    }
    if (startLat < -90 || startLat > 90 || startLng < -180 || startLng > 180) {
        return { ok: false, error: 'startLat/startLng out of range' };
    }
    if (maxKm <= 0 || maxKm > MAX_RADIUS_KM) {
        return { ok: false, error: `maxKm must be in (0, ${MAX_RADIUS_KM}]` };
    }

    return { ok: true, bbox, exclude, bboxLog, anchor: { startLat, startLng, maxKm } };
}
