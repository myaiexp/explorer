// Geometry-aware visit/history reads for GET /:username
import { and, desc, eq, getTableColumns, notInArray } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { GET_GEOMETRY_KEEP } from './validate-fields.js';

type TripTable = typeof schema.visits | typeof schema.history;

// Newest GET_GEOMETRY_KEEP rows (by date, id tie-break) keep their polylines;
// older rows are selected without the jsonb columns so Node never buffers
// historical geometry on the init-path GET. `fullGeometry` is `?geometry=full`
// — the cloud archive, gated by GET_SNAPSHOT_MAX_BYTES at the route so this
// helper is not reached for an oversized dump.
export async function selectTripSection(
  db: Db,
  table: TripTable,
  username: string,
  fullGeometry: boolean,
) {
  const whereUser = eq(table.username, username);
  if (fullGeometry) {
    return db.select().from(table).where(whereUser);
  }

  const newest = await db
    .select()
    .from(table)
    .where(whereUser)
    .orderBy(desc(table.date), desc(table.id))
    .limit(GET_GEOMETRY_KEEP);

  if (newest.length < GET_GEOMETRY_KEEP) return newest;

  const { routeCoords: _rc, returnRouteCoords: _rrc, ...light } = getTableColumns(table);
  const older = await db
    .select(light)
    .from(table)
    .where(and(whereUser, notInArray(table.id, newest.map((r) => r.id))));

  return [
    ...newest,
    ...older.map((r) => ({ ...r, routeCoords: null, returnRouteCoords: null })),
  ];
}
