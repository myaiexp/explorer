// Scalar field validators + length/size bounds for cloud-backup row validation.
// Shared by the per-row PUT routes (sections.ts) and the bulk import (import.ts)
// so both endpoints reject the same malformed dates and oversized strings.

// Indexed/text-column length caps — generous for any real label/name, bounded so
// an authenticated client can't bloat indexes or rows with multi-MB strings.
export const MAX_LABEL_LEN = 500; // startLabel, poiCategory, tripMode, saved-location label/value
export const MAX_NAME_LEN = 2000; // destName (POI names are occasionally long)
export const MAX_DATE_LEN = 40; // ISO-8601 timestamps are ≤ ~29 chars

// Serialized favorites JSONB payload cap (~0.5 MB) — favorites are small bookmark
// blobs; this stops an arbitrarily-large object being persisted as JSONB.
export const MAX_FAVORITE_PAYLOAD_LEN = 512_000;

// Total request-body cap for the per-row write chain (1 MiB) — rejects oversized
// bodies (including giant unknown keys) before JSON.parse holds them in memory.
// Headroom above the favorites payload cap and a max-size routeCoords trip.
// NOT applied to bulk import, whose bodies are legitimately large (full backups).
export const MAX_WRITE_BODY_BYTES = 1_048_576;

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
