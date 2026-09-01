# wander-api

Cloud-backup API for Wander. Hono + Drizzle + Postgres, served on port 3700
and exposed via nginx at `/wander/api/*`. Production runs Node 24
(`/usr/bin/node` in `deploy/wander-api.service`).

```bash
pnpm install
pnpm dev               # tsx watch src/index.ts
pnpm test              # vitest against wander_test, never prod
pnpm db:reset:test     # rebuild wander_test from the migration chain
pnpm build             # tsc → dist/
```

`pnpm db:migrate` targets `.env`'s `DATABASE_URL` — production — so it is
guarded (`scripts/db-migrate.ts`): from a worktree it **refuses** a pending
migration containing destructive DDL (drop, rename, truncate, `SET NOT NULL`,
a type change) and points at `deploy`, which runs drizzle-kit from
`~/Projects/wander` moments after the push lands. Additive DDL still applies
straight from a worktree. `--force` overrides. The policy is two pure modules,
`src/lib/migrate-guard.ts` and `src/lib/destructive-ddl.ts`, both unit-tested
against this repo's own migrations.

Use `db:reset:test` for the test DB; it resolves the same guarded `*_test` URL
the suite uses, so it cannot point at prod.

`src/app.ts` is the factory (`createApp(db)`). `src/index.ts` opens Postgres
and `serve()`s. pnpm layout, DB safety, and the unit vs integration split:
`tests/README.md`. Deploy/systemd: `deploy/README.md`.

## Auth model

Each account has a high-entropy secret `token` (32 random bytes, base64url)
issued by `POST /accounts` — the only time the plaintext is returned. The DB
stores a SHA-256 hex digest (`src/lib/token-hash.ts`); a dump of
`accounts.token` is not a reusable credential. Auth hashes the presented bearer
and compares constant-time (`src/middleware/auth.ts`), so pasting a stolen hash
back as `Authorization` fails.

Every read/write requires `Authorization: Bearer <token>` (or the
`X-Account-Token` fallback header):

- `GET /:username` — four-section snapshot
- section PUT/DELETE — visits, favorites, saved-locations, history
- `POST /:username/import` — bulk restore
- `DELETE /:username` — wipe the account

`POST /accounts` and `GET /api/health` are unauthenticated.
`POST /accounts` is rate-limited at 10 creations/hour/IP.

The human-readable username is only a public handle, not a credential.
Missing-account and wrong-token both return an identical `401`, so the
endpoint cannot be used to enumerate usernames. `GET /:username` and
`DELETE /:username` share an IP token-bucket of 60/min (`readRateLimit`) so
failed-auth probing is throttled before the Postgres lookup.

## Caps

- Per-section PUT inserts and bulk import are capped at 10,000 rows
  (`MAX_ROWS_PER_SECTION`). Updates of an existing id are always allowed.
- Per-account stored jsonb is capped at 32 MiB (`MAX_STORED_BYTES`, same
  `octet_length` estimator as GET). Growing PUTs 409, growing imports 400;
  shrinks and saved-location writes still go through. Finding #7756: row ×
  per-row caps alone allowed ~5 GiB of favorites JSONB.
- Default `GET /:username` omits visit/history polylines and favorite route
  geometry older than the newest 50 (`GET_GEOMETRY_KEEP`). The DB still stores
  full rows up to `MAX_STORED_BYTES` — cloud is the archive.
- `?geometry=full` returns the archive only when stored jsonb is under 8 MiB
  (`GET_SNAPSHOT_MAX_BYTES`); otherwise 413, so Node never JSON-encodes a
  fill above the dump cap.

## Archive recovery

`GET /:username/archive/:section` walks an account too big for
`?geometry=full` one bounded page at a time — the 413 stays as the
unbounded-dump backstop. Archive recovery only; the frontend never calls it.

```
GET /api/<username>/archive/<visits|history|favorites|savedLocations>
    ?limit=<1..1000, default 100>&cursor=<opaque>
→ 200 { section, rows: [...], nextCursor: string|null }
```

Rows come back newest-first with stored geometry intact, keyset-paged on
(sort column, id) — `date` for visits/history, `updatedAt` for the other two.
Follow `nextCursor` until it is null; a cursor is opaque and only valid as
returned (a hand-built one 400s rather than reaching the `::timestamptz` cast).

A page is cut by whichever of two bounds binds first, and both are needed:
rows alone do not bound memory (import's 5 MiB body cap lets one visit carry
megabytes of `routeCoords`), and bytes alone do not either (`saved_locations`
holds no jsonb, so only the row count stops a 10k-row dump). The byte total is
summed in Postgres — the row that would blow `ARCHIVE_PAGE_MAX_BYTES` (2 MiB)
is never serialized into Node. A page always returns at least one row, so a
single row above the budget is still retrievable instead of stalling the walk.

Caps and validators live in `src/lib/validate-fields.ts` /
`src/lib/validate-rows.ts`. Trip-row scalar coords (`startLat` / `startLng` /
`destLat` / `destLng`) must be finite and inside the same WGS-84 bounds as
`routeCoords` (`[-90, 90]` / `[-180, 180]`); `distance` must be finite and
≥ 0. Finding #7775: `typeof === 'number'` used to accept lat 999 and Infinity.

## Client contract

`sync.js` stores the token in the `walk_cloud_backup` consent record and
carries it in the URL **fragment** (`/wander/<username>#t=<token>`) so the
private link works cross-device while keeping the secret out of server
logs/Referer. The overflow menu's "Copy backup link" button
(`copyBackupLink` in `cloud-backup-ui.js`) copies that full link.

`localStorage` is origin-scoped (`https://mase.fi`), not path-scoped, so any
script running on this origin (`/games`, `/porssi`, the site root, …) can
read `walk_cloud_backup`. `/wander`'s CSP does not apply to those
responses. That is the browser same-origin trust boundary, not a gap in the
token design: the client must hold the plaintext so "Copy backup link" can
put it in the fragment, and the API stores only a SHA-256 digest so it
cannot re-issue. A `Path=/wander` cookie would keep sibling tabs from
*reading* the token but would send it on every `/wander/*` request (access
logs) and is still writable from the rest of the origin (cookie tossing). A
dedicated origin (`wander.mase.fi`) would isolate storage, but personal
apps stay on `mase.fi/<name>/` by policy. Treat XSS anywhere on
`https://mase.fi` as full cloud-backup takeover.

Opening a link-sourced account on a device that isn't already bound to it (no
stored consent record for that username) always prompts a `window.confirm`
before adopting it — even on a fresh/empty browser — so a shared link can't
silently bind a visitor's browser to a foreign account and harvest their
future walks.
