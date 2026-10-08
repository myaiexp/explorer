// The octet_length(::text) fragments shared by the snapshot budget query and
// the archive page's running total. One binding so the two queries cannot
// drift on which columns count as stored jsonb.
export const ROUTE_PAIR_BYTES_SQL =
  'COALESCE(octet_length(route_coords::text), 0) + COALESCE(octet_length(return_route_coords::text), 0)';

export const FAVORITE_PAYLOAD_BYTES_SQL =
  'COALESCE(octet_length(payload::text), 0)';
