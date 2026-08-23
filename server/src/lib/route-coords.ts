// Pure validator for routeCoords / returnRouteCoords blobs — bounds shape, size, and coordinate ranges.

// TWIN: visit-shape.js MAX_ROUTE_COORDS. tests/visit-shape-parity.test.js fails
// RED if the two copies drift.
//
// ≈ 100 km of dense GPS sampling. Caps the JSON blob size so a malicious or buggy
// client cannot persist arbitrarily-large arrays that pressure memory on GET /:username.
export const MAX_ROUTE_COORDS = 5000;

// Inclusive WGS-84 bounds. Scalar trip fields (startLat/…) use the same
// numbers via validate-rows.ts so a PUT cannot persist a coord the polyline
// validator would reject. TWIN of visit-shape.js latOrNull / lngOrNull.
export const LAT_MIN = -90;
export const LAT_MAX = 90;
export const LNG_MIN = -180;
export const LNG_MAX = 180;

export class RouteCoordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteCoordsError';
  }
}

// Coordinates are stored as [lat, lng] pairs (see app.js: geometry.coordinates.map(([lng, lat]) => [lat, lng])).
// null/undefined pass — the caller decides whether to persist null.
export function assertRouteCoords(
  value: unknown,
  fieldName: string
): asserts value is [number, number][] | null | undefined {
  if (value === null || value === undefined) return;

  if (!Array.isArray(value)) {
    throw new RouteCoordsError(`${fieldName} must be an array of [lat, lng] pairs`);
  }
  if (value.length > MAX_ROUTE_COORDS) {
    throw new RouteCoordsError(`${fieldName} exceeds maximum of ${MAX_ROUTE_COORDS} points`);
  }

  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new RouteCoordsError(`${fieldName} entries must be [lat, lng] pairs`);
    }
    const [lat, lng] = pair;
    if (typeof lat !== 'number' || !Number.isFinite(lat) || typeof lng !== 'number' || !Number.isFinite(lng)) {
      throw new RouteCoordsError(`${fieldName} entries must be pairs of finite numbers`);
    }
    if (lat < LAT_MIN || lat > LAT_MAX) {
      throw new RouteCoordsError(`${fieldName} latitude out of range [${LAT_MIN}, ${LAT_MAX}]`);
    }
    if (lng < LNG_MIN || lng > LNG_MAX) {
      throw new RouteCoordsError(`${fieldName} longitude out of range [${LNG_MIN}, ${LNG_MAX}]`);
    }
  }
}
