# CLAUDE.md

## Project Overview

**Wander** — a static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map.

UI design system (colors, typography, components, layout) is documented in `DESIGN.md`.

## Architecture

Frontend is a vanilla static app, no build step. Source files served as-is from `/var/www/html/explorer`. Script load order in `index.html` is dependency-significant (`defer`d); each JS file's own header comment states what it is "loaded after" — don't reorder the script tags without checking those headers.

Dependencies run one way: `app.js` is the composition root and owns no feature — it wires modules and paints the first frame. Nothing calls back into it. The route on screen lives in `session-state.js` behind `getCurrentSession()`/`setCurrentSession()`, and every build runs through `withLoading` in `loading.js`, which is also the one-build-at-a-time mutex — the entry points (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) bypass the disabled generate button, so overlap is prevented there, not per-button.

Backend (cloud backup) lives in `server/` — Node 24 + Hono + Drizzle + Postgres on port 3700, exposed via nginx at `/explorer/api/*`. systemd unit `explorer-api.service` (runs as the `explorer` system user, `ProtectHome` + `MemoryMax=512M`). DB `explorer` (user `explorer`). Migrations under `server/drizzle/`. Frontend tests: `pnpm test` at repo root; backend: `cd server && pnpm test`. **`tests/helpers/load.js` is the only way a test loads a repo-root browser script** — its `SCRIPT_DEPS` map is the single copy of index.html's load-order graph. Loader, naming, sync harness, and the backend unit vs integration split: `tests/README.md`.

`junctions-cache/` is a separate Hono microservice — a server-side Overpass cache for OSM road-junction lookups that powers the frontend's smart-routing path. Listens on `127.0.0.1:5001` (prod: `HOST=100.69.160.113`, `PORT=5001`), systemd unit `wander-junctions.service`, deployed on **shelly** (not the VPS) at `/home/shelly/Projects/explorer/junctions-cache` via the `shelly` git remote (`ssh://shelly/home/shelly/explorer.git`); cache snapshot at `/home/shelly/.local/state/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` to it. Has its own `package.json`/tests — see `junctions-cache/README.md` for endpoints, cache modes, and deploy details.

**Auth model:** cloud-backup accounts use a hashed bearer token (issued once by `POST /accounts`; SHA-256 digest in `server/src/lib/token-hash.ts`, compared constant-time in `server/src/middleware/auth.ts`). Every read/write is authenticated; missing-account and wrong-token both 401. Writes are capped at 10,000 rows/section; GET omits older geometry unless `?geometry=full` (413 above 8 MiB). The client carries the token in the URL fragment and always confirms before adopting a link-sourced account. Full contract: `server/README.md`.

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

**pnpm layout:** the repo is four independent pnpm projects — root (frontend test devDeps), `server/`, `junctions-cache/`, `tools/` — each with its own lockfile, installed separately by the deploy chain. Every one carries a `pnpm-workspace.yaml`, and every new sub-project must too: pnpm resolves its root by walking up to the nearest such file, so a sub-project without one is silently absorbed into the root install (`pnpm install` there installs the *root's* deps and skips the sub-project — no error, no lockfile, no `node_modules`). Overrides live in those files rather than a `pnpm` key in package.json because pnpm 11 no longer reads that key; both pins are security floors, so losing them is silent. `tests/pnpm-workspace-settings.test.js` guards both halves.

**Test DB safety:** the server suite calls `truncateAll()` in `beforeEach`, so it must never touch the prod `explorer` DB. `server/tests/test-db.ts` resolves the connection: it derives the DB name from `.env`'s `DATABASE_URL` (or an explicit `TEST_DATABASE_URL`), forces the name to `*_test`, and **hard-throws** unless it ends in `_test` — so a prod-pointing `.env` (Helm copies it into worktrees) can never be truncated. `server/vitest.config.ts` sets `fileParallelism: false` because every DB-backed file shares the one `explorer_test` DB and would otherwise race on truncate. To recreate the test DB on a fresh box: `createdb explorer_test` (owner `explorer`), then apply migrations against it (`DATABASE_URL=postgresql://explorer:…@localhost:5432/explorer_test pnpm db:migrate`).

Deploy with `deploy` — pushes to Forgejo, which triggers `forgejo-deploy` to: check out into `~/Projects/explorer`, build the server, run migrations, and rsync frontend assets to `/var/www/html/explorer`. The local `deploy` script then restarts `explorer-api.service`.

Canonical service and nginx config files live in `deploy/`: `nginx-explorer.conf`, `nginx-osrm-fi.conf`, `nginx-junctions.conf` (location in `sites-enabled/default`) plus `nginx-junctions-log-format.conf` (http-context `log_format` in `/etc/nginx/conf.d/` — not a server-block snippet), the `explorer-api.service` unit, `wander-junctions.service` (shelly), and `shelly-osrm/` (the self-hosted OSRM-foot service, refresh timer, and install script for the shelly box). The `junctions-cache` service is deployed separately (see its README). `deploy` restarts `explorer-api` but does not install the unit — after editing `deploy/explorer-api.service`, `sudo cp` it to `/etc/systemd/system/` and `daemon-reload`. The `explorer` system user (`nologin`, no home) is required; `ProtectHome` must stay `tmpfs` (not `yes`) so `BindReadOnlyPaths` of the server tree remains reachable.
