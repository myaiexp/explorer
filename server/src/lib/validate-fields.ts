// Scalar field validators + length/size bounds for cloud-backup row validation.
// Shared by the per-row PUT routes (sections.ts), bulk import (import.ts), and
// GET snapshot shaping so write caps and the read budget cannot drift.

// TWIN: visit-shape.js (idOrNull / isoDateOrNull / stringOrNull caps).
// tests/visit-shape-parity.test.js fails RED if these drift.
//
// Indexed/text-column length caps — generous for any real label/name, bounded so
// an authenticated client can't bloat indexes or rows with multi-MB strings.
export const MAX_LABEL_LEN = 500; // startLabel, poiCategory, tripMode, saved-location label/value
export const MAX_NAME_LEN = 2000; // destName (POI names are occasionally long)
export const MAX_DATE_LEN = 40; // ISO-8601 timestamps are ≤ ~29 chars

// Row ids become URL path segments (PUT /:username/<section>/:id) and PK
// columns. Mirror visit-shape.js idOrNull: RFC 3986 unreserved charset, 128-char
// cap, and reject dot-only segments ('.' / '..' survive percent-encoding and
// would be normalized away by the browser). Finding #7061 — import had no
// bound, so an authenticated client could persist arbitrarily large or
// punctuation-heavy ids.
export const MAX_ID_LEN = 128;
export const SAFE_ID = /^[A-Za-z0-9._~-]+$/;

// Serialized favorites JSONB payload cap (~0.5 MB) — favorites are small bookmark
// blobs; this stops an arbitrarily-large object being persisted as JSONB.
export const MAX_FAVORITE_PAYLOAD_LEN = 512_000;

// Total request-body cap for the per-row write chain (1 MiB) — rejects oversized
// bodies (including giant unknown keys) before JSON.parse holds them in memory.
// Headroom above the favorites payload cap and a max-size routeCoords trip.
export const MAX_WRITE_BODY_BYTES = 1_048_576;

// Bulk-import body cap (5 MiB) — full-account backups are legitimately larger
// than a single-row PUT, but still bounded so a flood of authenticated imports
// cannot pin multi-hundred-MB JSON blobs in process memory (audit #1343).
// Aligns roughly with typical browser localStorage ceilings the client backs up.
export const MAX_IMPORT_BODY_BYTES = 5 * 1_048_576;

// Per-section row cap — PUT insert and bulk import. Independent of body bytes,
// so a million tiny rows (or years of per-walk PUTs) still get rejected.
// Updates of an existing id are always allowed so a full account can still
// edit. Finding #7278: the per-row PUT used to have no count bound at all.
export const MAX_ROWS_PER_SECTION = 10_000;
export const MAX_IMPORT_ROWS_PER_SECTION = MAX_ROWS_PER_SECTION;

// Newest N visit/history rows on GET /:username keep full polylines; older ones
// are returned metadata-only so the init-path merge stays bounded. Twin of
// storage.js VISIT_GEOMETRY_KEEP. tests/geometry-keep-parity.test.js fails RED
// if these drift. The same window applies to favorite payloads:
// newest N keep the stored JSONB, older ones are rebuilt from FAVORITE_LIGHT_KEYS
// so a 10k × 512 KB fill cannot be serialized on the default GET. The DB still
// stores full rows (cloud is the archive). `?geometry=full` returns them only
// when the stored jsonb is under GET_SNAPSHOT_MAX_BYTES; otherwise 413.
export const GET_GEOMETRY_KEEP = 50;

// Uncompressed JSON-text budget for `?geometry=full`. Above this, GET 413s
// rather than JSON-encoding the archive (finding #7558). Default GET never
// consults this — it uses the keep window. 8 MiB is well under MemoryMax and
// still covers a small account's archive dump; the client never sends the flag.
export const GET_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

// Scalar bookmark fields copied into an older favorite's GET payload. Route
// geometry and any attacker-supplied blob keys stay in the DB and out of the
// default response. Generated SQL uses this list; do not add array/object keys.
export const FAVORITE_LIGHT_KEYS = [
  'date',
  'startLat',
  'startLng',
  'startLabel',
  'destLat',
  'destLng',
  'destName',
  'tripMode',
  'distance',
  'routeDistance',
  'routeDuration',
  'returnRouteDistance',
  'returnRouteDuration',
] as const;

// ISO-8601 date/datetime: requires the YYYY-MM-DD prefix AND a Date.parse-able
// value, length-capped so Date.parse is never handed a huge blob. Rejects
// 'DROP TABLE', malformed timestamps, and oversized strings before they reach the
// timestamptz column.
export function isIsoDate(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= MAX_DATE_LEN &&
    /^\d{4}-\d{2}-\d{2}/.test(v) &&
    !Number.isNaN(Date.parse(v))
  );
}

// A usable row id, or a 400 reason. Empty/non-string keeps the historical
// 'Missing required field: id' wording so PUT/import error bodies don't change
// for the cases they already rejected.
export function parseRowId(id: unknown): { error: string } | { id: string } {
  if (typeof id !== 'string' || !id) return { error: 'Missing required field: id' };
  if (id.length > MAX_ID_LEN) return { error: `id exceeds maximum length of ${MAX_ID_LEN}` };
  if (!SAFE_ID.test(id) || /^\.+$/.test(id)) return { error: 'id contains invalid characters' };
  return { id };
}

export function idError(id: unknown): string | null {
  const parsed = parseRowId(id);
  return 'error' in parsed ? parsed.error : null;
}

// True when v is a string longer than max. Non-strings are not "too long" — the
// caller separately decides whether a non-string is acceptable (→ null) or missing.
export function tooLong(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length > max;
}

// Serialized character length of a JSONB payload (0 for unserializable values like
// undefined). Used to cap the favorites payload size.
export function payloadLength(payload: unknown): number {
  const s = JSON.stringify(payload);
  return typeof s === 'string' ? s.length : 0;
}
