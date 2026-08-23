# CLAUDE.md

## Project Overview

**Wander** — a Finland-only static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map. Starts outside `bbox.js` `FINLAND_BBOX` are rejected after geocode (`resolveStart` in `location-input.js`) and when restoring a shared link (`restoreFromHash` in `share-link.js`, start and dest); walking routes go to self-hosted OSRM-foot (`https://mase.fi/api/osrm-fi`, `deploy/shelly-osrm/`), not public OSRM.

UI design system (colors, typography, components, layout) is documented in `DESIGN.md`.

## Architecture

Frontend is a vanilla static app, no build step. Source files served as-is from `/var/www/html/explorer`. Script load order in `index.html` is dependency-significant (`defer`d). Dependency-bearing files declare that order in their header comment; `tests/helpers/load.js` `SCRIPT_DEPS` is the single ordered graph — don't reorder the script tags without checking it.

Dependencies run one way: `app.js` is the composition root and owns no feature — it wires modules and paints the first frame. Nothing calls back into it. The route on screen lives in `session-state.js` behind `getCurrentSession()`/`setCurrentSession()`, and every build runs through `withLoading` in `loading.js`, which is also the one-build-at-a-time mutex — the entry points (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) bypass the disabled generate button, so overlap is prevented there, not per-button.

Backend (cloud backup) lives in `server/` — Node 24 + Hono + Drizzle + Postgres on port 3700, exposed via nginx at `/explorer/api/*`. systemd unit `explorer-api.service` (runs as the `explorer` system user, `ProtectHome` + `MemoryMax=512M`). DB `explorer` (user `explorer`). Migrations under `server/drizzle/`. Frontend tests: `pnpm test` at repo root; backend: `cd server && pnpm test`. **`tests/helpers/load.js` is the only way a test loads a repo-root browser script.** Loader, naming, sync harness, and the backend unit vs integration split: `tests/README.md`.

`junctions-cache/` is a separate Hono microservice — a server-side Overpass cache for OSM road-junction lookups that powers the frontend's smart-routing path. Listens on `127.0.0.1:5001` (prod: `HOST=100.69.160.113`, `PORT=5001`), systemd unit `wander-junctions.service` (dedicated `wander-junctions` nologin user, `ProtectHome` + `MemoryMax=512M`). Deployed on **shelly** (not the VPS) at `/home/shelly/Projects/explorer/junctions-cache` via the `shelly` git remote (`ssh://shelly/home/shelly/explorer.git`); cache snapshot at `/var/lib/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` to it. Has its own `package.json`/tests — see `junctions-cache/README.md` for endpoints, cache modes, and deploy details. Unit install: `deploy/install-wander-junctions.sh`.

**Auth model:** cloud-backup accounts use a hashed bearer token (issued once by `POST /accounts`; SHA-256 digest in `server/src/lib/token-hash.ts`, compared constant-time in `server/src/middleware/auth.ts`). Every read/write is authenticated; missing-account and wrong-token both 401. Writes are capped at 10,000 rows/section and 32 MiB stored jsonb/account; GET omits older geometry unless `?geometry=full` (413 above 8 MiB). The client carries the token in the URL fragment and always confirms before adopting a link-sourced account. The bearer lives in origin-wide `localStorage` (`walk_cloud_backup`) — XSS anywhere on `https://mase.fi` is cloud-backup takeover (accepted same-origin trust). Full contract: `server/README.md`.

`tools/` holds dev-only tooling (FIT round-trip validators, browser smoke-test page). Has its own `package.json` and `node_modules`; not referenced by `index.html` and not part of the deployed site.

**Core logic flow:**

1. User enters a starting location (address or lat/lng) and a max distance in km
2. Address inputs are geocoded via Nominatim; `resolveStart` then rejects a start outside `FINLAND_BBOX`
3. A destination is picked: random POI from Overpass (categorized: nature, food, activity, culture, or "any"), random road point, or fully random point
4. OSRM calculates a walking route. Round-trip always uses 3 geometric envelope vias per side (spread slider sets loop width). Default (`buildLoop` in `osrm.js`) snaps each via to the nearest road via OSRM nearest within `max(0.3 km, offsetKm·0.5)`. Smart routing (`#smartRouting` in `index.html`) snaps those same vias to OSM junctions from junctions-cache (`buildJunctionLoop` — both chiralities, lower-overlap wins) and falls back to `buildLoop` on Overpass/OSRM failure. See `junctions-cache/README.md`.
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

Four independent pnpm lockfiles (root, `server/`, `junctions-cache/`, `tools/`) so pnpm does not hoist — layout, the silent-absorb trap, and the `*_test` hard-throw: `tests/README.md`. Only `server/` (forgejo-deploy) and `junctions-cache/` (shelly hook) are `pnpm install`ed on deploy; root and `tools/` are local/dev only.

Deploy with `deploy` (push → forgejo-deploy builds the server, migrates, copies frontend; local script restarts `explorer-api`). Canonical nginx/systemd files, unit-install caveat, and `ProtectHome=tmpfs`: `deploy/README.md`. Junctions-cache deploys separately (`junctions-cache/README.md`).
