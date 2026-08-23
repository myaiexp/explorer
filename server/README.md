# explorer-api

Cloud-backup API for Wander. Hono + Drizzle + Postgres, served on port 3700
and exposed via nginx at `/explorer/api/*`. Production runs Node 24
(`/usr/bin/node` in `deploy/explorer-api.service`).

```bash
pnpm install
pnpm dev               # tsx watch src/index.ts
pnpm test              # vitest against explorer_test, never prod
pnpm build             # tsc → dist/
```

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
- Default `GET /:username` omits visit/history polylines and favorite route
  geometry older than the newest 50 (`GET_GEOMETRY_KEEP`). The DB still stores
  full rows — cloud is the archive.
- `?geometry=full` returns the archive only when stored jsonb is under 8 MiB
  (`GET_SNAPSHOT_MAX_BYTES`); otherwise 413, so Node never JSON-encodes a
  multi-GB fill.

Caps and validators live in `src/lib/validate-fields.ts` /
`src/lib/validate-rows.ts`.

## Client contract

`sync.js` stores the token in the `walk_cloud_backup` consent record and
carries it in the URL **fragment** (`/explorer/<username>#t=<token>`) so the
private link works cross-device while keeping the secret out of server
logs/Referer. The overflow menu's "Copy backup link" button
(`copyBackupLink` in `cloud-backup-ui.js`) copies that full link.

`localStorage` is origin-scoped (`https://mase.fi`), not path-scoped, so any
script running on this origin (`/games`, `/porssi`, the site root, …) can
read `walk_cloud_backup`. `/explorer`'s CSP does not apply to those
responses. That is the browser same-origin trust boundary, not a gap in the
token design: the client must hold the plaintext so "Copy backup link" can
put it in the fragment, and the API stores only a SHA-256 digest so it
cannot re-issue. A `Path=/explorer` cookie would keep sibling tabs from
*reading* the token but would send it on every `/explorer/*` request (access
logs) and is still writable from the rest of the origin (cookie tossing). A
dedicated origin (`explorer.mase.fi`) would isolate storage, but personal
apps stay on `mase.fi/<name>/` by policy. Treat XSS anywhere on
`https://mase.fi` as full cloud-backup takeover.

Opening a link-sourced account on a device that isn't already bound to it (no
stored consent record for that username) always prompts a `window.confirm`
before adopting it — even on a fresh/empty browser — so a shared link can't
silently bind a visitor's browser to a foreign account and harvest their
future walks.
