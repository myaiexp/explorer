// Geometry-aware favorites reads for GET /:username
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { FAVORITE_LIGHT_KEYS, GET_GEOMETRY_KEEP } from './validate-fields.js';

// jsonb_build_object pairs from the bookmark-key whitelist. Keys are a fixed
// const array (no user input), so sql.raw is the join, not a query parameter.
const LIGHT_PAYLOAD_SQL = sql.raw(
  `jsonb_strip_nulls(jsonb_build_object(${FAVORITE_LIGHT_KEYS.map((k) => `'${k}', payload->'${k}'`).join(', ')}))`,
);

// Newest GET_GEOMETRY_KEEP favorites (by updatedAt, id tie-break) keep their
// stored JSONB; older rows are selected with only FAVORITE_LIGHT_KEYS so Node
// never buffers a 10k × 512 KB fill on the init-path GET. `fullGeometry` is
// `?geometry=full` — the cloud archive, gated by GET_SNAPSHOT_MAX_BYTES at the
// route so this helper is not reached for an oversized dump.
export async function selectFavoriteSection(db: Db, username: string, fullGeometry: boolean) {
  const whereUser = eq(schema.favorites.username, username);
  if (fullGeometry) {
    return db.select().from(schema.favorites).where(whereUser);
  }

  const newest = await db
    .select()
    .from(schema.favorites)
    .where(whereUser)
    .orderBy(desc(schema.favorites.updatedAt), desc(schema.favorites.id))
    .limit(GET_GEOMETRY_KEEP);

  if (newest.length < GET_GEOMETRY_KEEP) return newest;

  const older = await db
    .select({
      id: schema.favorites.id,
      username: schema.favorites.username,
      updatedAt: schema.favorites.updatedAt,
      payload: sql`${LIGHT_PAYLOAD_SQL}`.as('payload'),
    })
    .from(schema.favorites)
    .where(and(whereUser, notInArray(schema.favorites.id, newest.map((r) => r.id))));

  return [...newest, ...older];
}
