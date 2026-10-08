// Account-wide size, row, and paging budgets for cloud backup. Field-shape
// checks stay in validate-fields.ts; these numbers are what the write cap, the
// default GET window, and the archive page all have to agree on.

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

// Newest N visit/history rows on GET /:username keep full polylines; older ones
// are returned metadata-only so the init-path merge stays bounded. Twin of
// storage.js VISIT_GEOMETRY_KEEP. tests/geometry-keep-parity.test.js fails RED
// if these drift. The same window applies to favorite payloads:
// newest N keep the stored JSONB, older ones are rebuilt from FAVORITE_LIGHT_KEYS
// so a 10k × 512 KB fill cannot be serialized on the default GET. Writes are
// also bounded by MAX_STORED_BYTES (cloud is still the archive, not a multi-GB
// one). `?geometry=full` returns stored rows only when the jsonb is under
// GET_SNAPSHOT_MAX_BYTES; otherwise 413.
export const GET_GEOMETRY_KEEP = 50;

// Uncompressed JSON-text budget for `?geometry=full`. Above this, GET 413s
// rather than JSON-encoding the archive (finding #7558). Default GET never
// consults this — it uses the keep window. 8 MiB is well under MemoryMax and
// still covers a small account's archive dump; the client never sends the flag.
export const GET_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

// GET /:username/archive/:section — the cursor-paged escape hatch for an
// archive too big for `?geometry=full` (idea #3715). The 413 stays as the
// unbounded-dump backstop; this walks the same rows a bounded page at a time.
//
// Both bounds are load-bearing and neither subsumes the other. Rows alone do
// not bound memory: bulk import's 5 MiB body cap lets one visit carry megabytes
// of routeCoords, so 100 rows could be hundreds of MB. Bytes alone do not bound
// it either: saved_locations holds no jsonb at all, so its running byte total is
// zero and only the row count stops a 10k-row dump. A page is cut by whichever
// binds first, except that a page always returns at least one row — a single row
// larger than the budget must still be retrievable or the cursor stalls forever.
export const ARCHIVE_PAGE_DEFAULT_ROWS = 100;
export const ARCHIVE_PAGE_MAX_ROWS = 1_000;
// 2 MiB — a quarter of GET_SNAPSHOT_MAX_BYTES, so a maxed-out account
// (MAX_STORED_BYTES, 32 MiB) walks in ~16 pages, and several concurrent readers
// still sit far under the service's MemoryMax=512M.
export const ARCHIVE_PAGE_MAX_BYTES = 2 * 1024 * 1024;

// Per-account stored-jsonb budget (finding #7756). Same estimator GET uses
// (sum of octet_length(::text) on visits/history polylines + favorite payloads).
// Row × per-row caps still allow ~5 GiB of favorites JSONB; this is the disk
// bound. 32 MiB is larger than GET_SNAPSHOT_MAX_BYTES (cloud is the archive;
// default GET strips old geometry) and MAX_IMPORT_BODY_BYTES (a legitimate
// backup always fits). Growing PUTs/imports that would exceed it 409/400;
// shrinks and saved-location writes (no jsonb) still go through.
export const MAX_STORED_BYTES = 32 * 1024 * 1024;

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
