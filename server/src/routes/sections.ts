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
import { MAX_ROWS_PER_SECTION, MAX_WRITE_BODY_BYTES } from '../lib/validate-fields.js';
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

// Shared Hono app + db. Middleware is NOT in here — registerSection builds the
// write chain itself so the security order cannot be transposed at a call site.
interface SectionDeps {
  app: Hono;
  db: Db;
}

// Wires PUT (upsert) + DELETE for one section. The PUT body flow — JSON parse →
// isObject guard → buildRow → upsert — and the DELETE flow are identical across
// sections; only `table`/`path`/`buildRow` differ. The write-guard chain is
// constructed here (not passed in) so ip-limit → auth → username-limit lives in
// exactly one place: unauthenticated probes burn the IP bucket, not the owner's
// 60/min write budget. `auth` 401s when the account is missing, so both
// handlers can assume :username names an existing account — no re-check here.
function registerSection<T extends PgTable & { id: PgColumn; username: PgColumn }>(
  { app, db }: SectionDeps,
  { path, table, buildRow }: Section<T>
): void {
  // ip-limit → auth → username-limit. One tuple, spread on both verbs, so the
  // order cannot be restated differently on PUT vs DELETE.
  const writeGuards = [ipWriteRateLimit(), accountAuth(db), usernameWriteRateLimit()] as const;
  // bodyLimit only on PUT (DELETE carries no body) — rejects oversized bodies,
  // including giant unknown keys, before c.req.json() buffers them in memory.
  const writeBodyLimit = bodyLimit({
    maxSize: MAX_WRITE_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  });

  app.put(`/:username/${path}/:id`, ...writeGuards, writeBodyLimit, async (c) => {
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

    // Row-count gate on INSERT (finding #7278). Updates of an existing id are
    // always allowed so a full account can still edit. Lock the account row so
    // two concurrent new-id PUTs cannot both observe count < cap and both insert.
    const capError = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT 1 FROM accounts WHERE username = ${username} FOR UPDATE`);
      // `from(table)` can't see through the generic Section table — same
      // opacity as the insert/values cast below.
      const existing = await tx
        .select({ id: table.id })
        .from(table as unknown as typeof schema.visits)
        .where(and(eq(table.username, username), eq(table.id, id)));
      if (existing.length === 0) {
        const [counted] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(table as unknown as typeof schema.visits)
          .where(eq(table.username, username));
        if ((counted?.n ?? 0) >= MAX_ROWS_PER_SECTION) {
          return `section exceeds maximum of ${MAX_ROWS_PER_SECTION} rows`;
        }
      }
      await tx
        .insert(table)
        .values(built.row)
        .onConflictDoUpdate({
          target: [table.username, table.id],
          set: set as PgUpdateSetSource<T>,
        });
      return null;
    });
    if (capError) return c.json({ error: capError }, 409);

    return new Response(null, { status: 204 });
  });

  app.delete(`/:username/${path}/:id`, ...writeGuards, async (c) => {
    const username = c.req.param('username')!;
    const id = c.req.param('id')!;

    await db.delete(table).where(and(eq(table.id, id), eq(table.username, username)));

    return new Response(null, { status: 204 });
  });
}

export function sectionsRoutes(db: Db): Hono {
  const app = new Hono();
  const deps: SectionDeps = { app, db };

  // Each section delegates to the shared validator (lib/validate-rows.ts), which
  // returns { error } | { row }; the PUT handler surfaces the error string as its
  // 400 body. `id` comes from the path — for favorites that means `body` here
  // never carries the id, so the no-wrapper fallback stores exactly the body.
  registerSection(deps, {
    path: 'visits',
    table: schema.visits,
    buildRow: (id, username, body) => validateVisitRow(id, username, body),
  });

  registerSection(deps, {
    path: 'favorites',
    table: schema.favorites,
    buildRow: (id, username, body) => validateFavoriteRow(id, username, body),
  });

  registerSection(deps, {
    path: 'saved-locations',
    table: schema.savedLocations,
    buildRow: (id, username, body) => validateSavedLocationRow(id, username, body),
  });

  registerSection(deps, {
    path: 'history',
    table: schema.history,
    buildRow: (id, username, body) => validateTripRow(id, username, body),
  });

  return app;
}
