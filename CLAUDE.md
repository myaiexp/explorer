# CLAUDE.md

## Project Overview

**Wander** — a static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map.

UI design system (colors, typography, components, layout) is documented in `DESIGN.md`.

## Architecture

Frontend is a vanilla static app, no build step. Source files served as-is from `/var/www/html/explorer`. Script load order in `index.html` is dependency-significant (`defer`d); each JS file's own header comment states what it is "loaded after" — don't reorder the script tags without checking those headers.

Dependencies run one way: `app.js` is the composition root and owns no feature — it wires modules and paints the first frame. Nothing calls back into it. The route on screen lives in `session-state.js` behind `getCurrentSession()`/`setCurrentSession()`, and every build runs through `withLoading` in `loading.js`, which is also the one-build-at-a-time mutex — the entry points (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) bypass the disabled generate button, so overlap is prevented there, not per-button.

Backend (cloud backup) lives in `server/` — Node 20 + Hono + Drizzle + Postgres on port 3700, exposed via nginx at `/explorer/api/*`. systemd unit `explorer-api.service`. DB `explorer` (user `explorer`). Migrations under `server/drizzle/`. Static frontend tests at repo root use vitest + jsdom — run the whole suite with `pnpm test` (root `test` script is `vitest run`, covering every `tests/*.test.js`); backend tests run with `cd server && pnpm test`. Backend test layout follows one convention: **colocated `src/**/*.unit.test.ts`** are pure/fake-Db unit tests (no Postgres), while **`server/tests/*.test.ts`** are real-DB integration tests that truncate `explorer_test`. The `.unit.` marker keeps same-named unit/integration pairs (e.g. `sections`, `import`) distinct at a glance.

`junctions-cache/` is a separate Hono microservice — a server-side Overpass cache for OSM road-junction lookups that powers the frontend's smart-routing path. Listens on `127.0.0.1:5001` (prod binds `HOST=100.69.160.113:5001`), systemd unit `wander-junctions.service`, deployed on **shelly** (not the VPS) at `/home/shelly/Projects/explorer/junctions-cache` via the `shelly` git remote (`ssh://shelly/home/shelly/explorer.git`); cache snapshot at `/home/shelly/.local/state/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` to it. Has its own `package.json`/tests — see `junctions-cache/README.md` for endpoints, cache modes, and deploy details.

**Auth model:** each account has a high-entropy secret `token` (32 random bytes, base64url) issued by `POST /accounts` (the only time it's returned). Every read/write — `GET /:username`, the section PUT/DELETE routes, `POST /:username/import`, `DELETE /:username` — requires `Authorization: Bearer <token>` (verified constant-time in `middleware/auth.ts`). The human-readable username is only a public handle, not a credential. Missing-account and wrong-token both return an identical `401` so the endpoint can't be used to enumerate usernames; `GET /:username` is also IP rate-limited (60/min). The client (`sync.js`) stores the token in the `walk_cloud_backup` consent record and carries it in the URL **fragment** (`/explorer/<username>#t=<token>`) so the private link works cross-device while keeping the secret out of server logs/Referer. The overflow menu's "Copy backup link" button copies that full link. Opening a link-sourced account on a device that isn't already bound to it (no stored consent record for that username) always prompts a `window.confirm` before adopting it — even on a fresh/empty browser — so a shared link can't silently bind a visitor's browser to a foreign account and harvest their future walks.

`tools/` holds dev-only tooling (FIT round-trip validators, browser smoke-test page). Has its own `package.json` and `node_modules`; not referenced by `index.html` and not part of the deployed site.

**Core logic flow:**

1. User enters a starting location (address or lat/lng) and a max distance in km
2. Address inputs are geocoded via Nominatim
3. A destination is picked: random POI from Overpass (categorized: nature, food, activity, culture, or "any"), random road point, or fully random point
4. OSRM calculates a walking route; round-trip mode builds a loop by generating 3 geometric envelope vias per side, snapping each independently to the nearest road via OSRM nearest within `max(0.3 km, offsetKm·0.5)`, then routing through them (spread slider controls loop width)
5. Result shown on Leaflet map with markers, route polylines, elevation profile chart, distance/duration badges, Google Maps directions link

## Development

Frontend (no build step):

```bash
python3 -m http.server 8080
```

Backend:

```bash
cd server
pnpm install
pnpm dev               # tsx watch
pnpm test              # vitest (runs against explorer_test, never prod)
pnpm build             # tsc → dist/
```

**Test DB safety:** the server suite calls `truncateAll()` in `beforeEach`, so it must never touch the prod `explorer` DB. `tests/test-db.ts` resolves the connection: it derives the DB name from `.env`'s `DATABASE_URL` (or an explicit `TEST_DATABASE_URL`), forces the name to `*_test`, and **hard-throws** unless it ends in `_test` — so a prod-pointing `.env` (Helm copies it into worktrees) can never be truncated. `vitest.config.ts` sets `fileParallelism: false` because every DB-backed file shares the one `explorer_test` DB and would otherwise race on truncate. To recreate the test DB on a fresh box: `createdb explorer_test` (owner `explorer`), then apply migrations against it (`DATABASE_URL=postgresql://explorer:…@localhost:5432/explorer_test pnpm db:migrate`).

Deploy with `deploy` — pushes to Forgejo, which triggers `forgejo-deploy` to: check out into `~/Projects/explorer`, build the server, run migrations, and rsync frontend assets to `/var/www/html/explorer`. The local `deploy` script then restarts `explorer-api.service`.

Canonical service and nginx config files live in `deploy/`: `nginx-explorer.conf`, `nginx-osrm-fi.conf`, the `explorer-api.service` unit, and `shelly-osrm/` (the self-hosted OSRM-foot service, refresh timer, and install script for the shelly box). The `junctions-cache` service is deployed separately (see its README).
