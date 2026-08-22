// Section CRUD routes — one generic PUT (upsert) + DELETE factory over the
// four user-scoped tables (visits / favorites / saved-locations / history).
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq, and, sql } from 'drizzle-orm';
import type { PgTable, PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../db.js';
import { schema } from '../db.js';
import { ipWriteRateLimit, usernameWriteRateLimit } from '../middleware/rate-limit.js';
import { accountAuth } from '../middleware/auth.js';
import { isObject, type AnyRecord } from '../lib/type-guards.js';
import { MAX_WRITE_BODY_BYTES } from '../lib/validate-fields.js';
import {
  validateTripRow,
  validateVisitRow,
  validateFavoriteRow,
  validateSavedLocationRow,
} from '../lib/validate-rows.js';

// A section's domain rule: turn a validated object body into the row to upsert,
// or a 400 error message. `id`/`username` come from the path.
type BuildRow<T extends PgTable> = (
  id: string,
  username: string,
  body: AnyRecord
) => { error: string } | { row: T['$inferInsert'] };

interface Section<T extends PgTable & { id: PgColumn; username: PgColumn }> {
  path: string;
  table: T;
  buildRow: BuildRow<T>;
}

// Wires PUT (upsert) + DELETE for one section. The PUT body flow — JSON parse →
// isObject guard → buildRow → upsert — and the DELETE flow are identical across
// sections; only `table`/`path`/`buildRow` differ. Order is ip-limit → auth →
// username-limit: unauthenticated probes burn the IP bucket, not the owner's
// 60/min write budget. `auth` 401s when the account is missing, so both
// handlers can assume :username names an existing account — no re-check here.
function registerSection<T extends PgTable & { id: PgColumn; username: PgColumn }>(
  app: Hono,
  db: Db,
  ipRl: ReturnType<typeof ipWriteRateLimit>,
  auth: ReturnType<typeof accountAuth>,
  userRl: ReturnType<typeof usernameWriteRateLimit>,
  writeBodyLimit: ReturnType<typeof bodyLimit>,
  { path, table, buildRow }: Section<T>
): void {
  // bodyLimit only on PUT (DELETE carries no body) — rejects oversized bodies,
  // including giant unknown keys, before c.req.json() buffers them in memory.
  app.put(`/:username/${path}/:id`, ipRl, auth, userRl, writeBodyLimit, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
    if (!isObject(body)) return c.json({ error: 'Body must be an object' }, 400);

    const built = buildRow(id, username, body);
    if ('error' in built) return c.json({ error: built.error }, 400);

    // Upsert scoped to the OWNER: the conflict target is the composite PK
    // (username, id), so a PUT of an id that already exists under a DIFFERENT
    // account inserts a fresh row under the caller instead of rewriting the
    // other account's row (audit #4832/#4855). The conflict set updates every
    // column except the PK keys (username, id) — derived from the row itself, so
    // there's no second hand-maintained field list to drift from buildRow — plus
    // a fresh updatedAt (buildRow omits it), which the client's last-write-wins
    // merge in sync-sections.js orders by. now() keeps the update on the same DB
    // clock as the insert default. (The generic row type is opaque to TS at this
    // boundary, hence the localized casts.)
    const { id: _id, username: _username, ...cols } = built.row as AnyRecord;
    const set = { ...cols, updatedAt: sql`now()` };
    await db
      .insert(table)
      .values(built.row)
      .onConflictDoUpdate({
        target: [table.username, table.id],
        set: set as PgUpdateSetSource<T>,
      });

    return new Response(null, { status: 204 });
  });

  app.delete(`/:username/${path}/:id`, ipRl, auth, userRl, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    await db.delete(table).where(and(eq(table.id, id), eq(table.username, username)));

    return new Response(null, { status: 204 });
  });
}

export function sectionsRoutes(db: Db): Hono {
  const app = new Hono();
  const ipRl = ipWriteRateLimit();
  const auth = accountAuth(db);
  const userRl = usernameWriteRateLimit();
  const writeBodyLimit = bodyLimit({
    maxSize: MAX_WRITE_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

  // Each section delegates to the shared validator (lib/validate-rows.ts), which
  // returns { error } | { row }; the PUT handler surfaces the error string as its
  // 400 body. `id` comes from the path — for favorites that means `body` here
  // never carries the id, so the no-wrapper fallback stores exactly the body.
  registerSection(app, db, ipRl, auth, userRl, writeBodyLimit, {
    path: 'visits',
    table: schema.visits,
    buildRow: (id, username, body) => validateVisitRow(id, username, body),
  });

  registerSection(app, db, ipRl, auth, userRl, writeBodyLimit, {
    path: 'favorites',
    table: schema.favorites,
    buildRow: (id, username, body) => validateFavoriteRow(id, username, body),
  });

  registerSection(app, db, ipRl, auth, userRl, writeBodyLimit, {
    path: 'saved-locations',
    table: schema.savedLocations,
    buildRow: (id, username, body) => validateSavedLocationRow(id, username, body),
  });

  registerSection(app, db, ipRl, auth, userRl, writeBodyLimit, {
    path: 'history',
    table: schema.history,
    buildRow: (id, username, body) => validateTripRow(id, username, body),
  });

  return app;
}
