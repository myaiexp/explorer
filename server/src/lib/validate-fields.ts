// Scalar field validators + length/size bounds for cloud-backup row validation.
// Shared by the per-row PUT routes (sections.ts) and the bulk import (import.ts)
// so both endpoints reject the same malformed dates and oversized strings.

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

// Per-section row cap on bulk import — independent of body bytes, so a million
// tiny rows still get rejected before the validate/collect loop allocates them.
export const MAX_IMPORT_ROWS_PER_SECTION = 10_000;

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
