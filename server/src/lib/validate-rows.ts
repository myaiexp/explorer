// Single source of truth for cloud-backup row validation + normalization.
// Both the per-row PUT routes (sections.ts) and the bulk import (import.ts) run
// these: sections surfaces the { error } string as its 400 body; import maps any
// error to a generic 'Invalid <section> row' 400. Any new column or validation
// rule is added here once, instead of drifting across the two route modules.
import { schema } from '../db.js';
import {
  assertRouteCoords,
  RouteCoordsError,
  LAT_MIN,
  LAT_MAX,
  LNG_MIN,
  LNG_MAX,
} from './route-coords.js';
import type { AnyRecord } from './type-guards.js';
import {
  MAX_LABEL_LEN,
  MAX_NAME_LEN,
  MAX_FAVORITE_PAYLOAD_LEN,
  isIsoDate,
  tooLong,
  payloadLength,
  parseRowId,
} from './validate-fields.js';

// A validated + normalized row ready to upsert, or a human-readable 400 reason.
export type RowResult<T> = { error: string } | { row: T };

// Scalar lat/lng: same finite + WGS-84 bounds as assertRouteCoords, so a PUT
// cannot persist a start/dest the client latOrNull/lngOrNull would drop
// (finding #7775). Non-number keeps the historical "Missing required field"
// wording; non-finite and out-of-range get their own reasons.
function parseCoord(
  name: string,
  value: unknown,
  lo: number,
  hi: number
): { error: string } | { value: number } {
  if (typeof value !== 'number') return { error: `Missing required field: ${name}` };
  if (!Number.isFinite(value)) return { error: `${name} must be a finite number` };
  if (value < lo || value > hi) return { error: `${name} out of range [${lo}, ${hi}]` };
  return { value };
}

// visits and history share this trip shape (history IS the trip shape; visits
// grafts poiCategory on top). `id`/`username` are supplied by the caller — path
// params for the per-row PUT, the row's own id for bulk import — never read from
// `body`. assertRouteCoords is folded in here so both call sites validate coord
// blobs through one path (no repeated try/catch at the route layer).
export function validateTripRow(
  id: unknown,
  username: string,
  body: AnyRecord
): RowResult<typeof schema.history.$inferInsert> {
  const parsedId = parseRowId(id);
  if ('error' in parsedId) return parsedId;
  const { date, distance } = body;
  if (typeof date !== 'string' || !date) return { error: 'Missing required field: date' };
  if (!isIsoDate(date)) return { error: 'date must be an ISO-8601 timestamp' };
  const startLat = parseCoord('startLat', body.startLat, LAT_MIN, LAT_MAX);
  if ('error' in startLat) return startLat;
  const startLng = parseCoord('startLng', body.startLng, LNG_MIN, LNG_MAX);
  if ('error' in startLng) return startLng;
  const destLat = parseCoord('destLat', body.destLat, LAT_MIN, LAT_MAX);
  if ('error' in destLat) return destLat;
  const destLng = parseCoord('destLng', body.destLng, LNG_MIN, LNG_MAX);
  if ('error' in destLng) return destLng;
  if (typeof distance !== 'number') return { error: 'Missing required field: distance' };
  if (!Number.isFinite(distance)) return { error: 'distance must be a finite number' };
  if (distance < 0) return { error: 'distance cannot be negative' };
  if (tooLong(body.startLabel, MAX_LABEL_LEN))
    return { error: `startLabel exceeds maximum length of ${MAX_LABEL_LEN}` };
  if (tooLong(body.destName, MAX_NAME_LEN))
    return { error: `destName exceeds maximum length of ${MAX_NAME_LEN}` };
  if (tooLong(body.tripMode, MAX_LABEL_LEN))
    return { error: `tripMode exceeds maximum length of ${MAX_LABEL_LEN}` };

  try {
    assertRouteCoords(body.routeCoords, 'routeCoords');
    assertRouteCoords(body.returnRouteCoords, 'returnRouteCoords');
  } catch (e) {
    if (e instanceof RouteCoordsError) return { error: e.message };
    throw e;
  }

  return {
    row: {
      id: parsedId.id,
      username,
      date,
      startLat: startLat.value,
      startLng: startLng.value,
      startLabel: typeof body.startLabel === 'string' ? body.startLabel : null,
      destLat: destLat.value,
      destLng: destLng.value,
      destName: typeof body.destName === 'string' ? body.destName : null,
      tripMode: typeof body.tripMode === 'string' ? body.tripMode : null,
      distance,
      routeCoords: body.routeCoords !== undefined ? body.routeCoords : null,
      routeDuration: typeof body.routeDuration === 'number' ? body.routeDuration : null,
      returnRouteCoords: body.returnRouteCoords !== undefined ? body.returnRouteCoords : null,
      returnRouteDuration:
        typeof body.returnRouteDuration === 'number' ? body.returnRouteDuration : null,
    },
  };
}

// Visits are the trip shape plus a poiCategory column.
export function validateVisitRow(
  id: unknown,
  username: string,
  body: AnyRecord
): RowResult<typeof schema.visits.$inferInsert> {
  if (tooLong(body.poiCategory, MAX_LABEL_LEN))
    return { error: `poiCategory exceeds maximum length of ${MAX_LABEL_LEN}` };
  const base = validateTripRow(id, username, body);
  if ('error' in base) return base;
  return {
    row: {
      ...base.row,
      poiCategory: typeof body.poiCategory === 'string' ? body.poiCategory : null,
    },
  };
}

// `source` is the favorite object as received: the wrapped shape { id, payload }
// or the client's flat favorite (no payload key → the object itself is stored as
// the JSONB payload; #2065). A present-but-null payload is malformed and rejected
// (favorites.payload is NOT NULL). `id` comes from the caller, not from `source`.
export function validateFavoriteRow(
  id: unknown,
  username: string,
  source: AnyRecord
): RowResult<typeof schema.favorites.$inferInsert> {
  const parsedId = parseRowId(id);
  if ('error' in parsedId) return parsedId;
  const payload = 'payload' in source ? source.payload : source;
  if (payload === undefined || payload === null) return { error: 'Missing required field: payload' };
  // JSONB will accept an array or a string, but the client unwraps payload as
  // an object and the list renderer toFixed's destLat. A 204 of [] / "x" is a
  // row the UI cannot draw and that used to abort first paint (#7307).
  if (typeof payload !== 'object' || Array.isArray(payload))
    return { error: 'payload must be an object' };
  if (payloadLength(payload) > MAX_FAVORITE_PAYLOAD_LEN)
    return { error: `payload exceeds maximum size of ${MAX_FAVORITE_PAYLOAD_LEN}` };
  return { row: { id: parsedId.id, username, payload } };
}

export function validateSavedLocationRow(
  id: unknown,
  username: string,
  body: AnyRecord
): RowResult<typeof schema.savedLocations.$inferInsert> {
  const parsedId = parseRowId(id);
  if ('error' in parsedId) return parsedId;
  const { label, value } = body;
  if (typeof label !== 'string') return { error: 'Missing required field: label' };
  if (typeof value !== 'string') return { error: 'Missing required field: value' };
  if (label.length > MAX_LABEL_LEN)
    return { error: `label exceeds maximum length of ${MAX_LABEL_LEN}` };
  if (value.length > MAX_LABEL_LEN)
    return { error: `value exceeds maximum length of ${MAX_LABEL_LEN}` };
  return { row: { id: parsedId.id, username, label, value } };
}
