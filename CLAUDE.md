# CLAUDE.md

## Project Overview

**Wander** — a Finland-only static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map. Starts outside `bbox.js` `FINLAND_BBOX` are rejected after geocode (`resolveStart` in `location-input.js`) and when restoring a shared link (`restoreFromHash` in `share-link.js`, start and dest); walking routes go to self-hosted OSRM-foot (`https://mase.fi/api/osrm-fi`, `deploy/shelly-osrm/`), falling back to public FOSSGIS OSRM only when that is unreachable — see the degraded mode in step 4.

UI design system (colors, typography, components, layout) is documented in `DESIGN.md`.

The project was called `explorer` everywhere below the UI until 2026-09-01 — repo, checkout, systemd unit, system user, webroot, Postgres, URL. All of that is now `wander`. Two things deliberately still say `explorer`: **`docs/plans/`**, which records what was built under the name it had at the time and is never rewritten, and the **`/explorer` public URL**, which serves permanently alongside `/wander` because a cloud-backup bearer travels between devices as `/explorer/<username>#t=<token>`. The app reads either prefix and writes only `/wander/` (`parseUrlAccount` / `canonicalisePath` in `sync-init.js`).

## Architecture

Frontend is a vanilla static app, no build step. Source files served as-is from `/var/www/html/wander`. Script load order in `index.html` is dependency-significant (`defer`d). Dependency-bearing files declare that order in their header comment; `tests/helpers/load.js` `SCRIPT_DEPS` is the single ordered graph — don't reorder the script tags without checking it.

Dependencies run one way: `app.js` is the composition root and owns no feature — it wires modules and paints the first frame. Nothing calls back into it. The route on screen lives in `session-state.js` behind `getCurrentSession()`/`setCurrentSession()`, and every build runs through `withLoading` in `loading.js`, which is also the one-build-at-a-time mutex — the entry points (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) bypass the disabled generate button, so overlap is prevented there, not per-button.

Backend (cloud backup) lives in `server/` — Node 24 + Hono + Drizzle + Postgres on port 3700, exposed via nginx at `/wander/api/*`. systemd unit `wander-api.service` (runs as the `wander` system user, `ProtectHome` + `MemoryMax=512M`). DB `wander` (user `wander`). Migrations under `server/drizzle/`. Frontend tests: `pnpm test` at repo root; backend: `cd server && pnpm test`. **`tests/helpers/load.js` is the only way a test loads a repo-root browser script.** Loader, naming, sync harness, and the backend unit vs integration split: `tests/README.md`.

`junctions-cache/` is a separate Hono microservice and **the app's only Overpass client** — the browser never queries an Overpass instance directly. It serves three cached, start-anchored lookups: road junctions (`/junctions`, the smart-routing via snapping), POI candidates (`/pois`) and road candidates (`/roads`). The two pool endpoints do the annulus filtering and 45-candidate capping the frontend used to do, so a generate ships kilobytes instead of the 5.2 MB a 3.85 km road query used to put on the wire. Listens on `127.0.0.1:5001` (prod: `HOST=100.69.160.113`, `PORT=5001`), systemd unit `wander-junctions.service` (dedicated `wander-junctions` nologin user, `ProtectHome` + `MemoryMax=512M`). Deployed on **shelly** (not the VPS) at `/home/shelly/Projects/wander/junctions-cache` via the `shelly` git remote (`ssh://shelly/home/shelly/wander.git`); cache snapshot at `/var/lib/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` to it. Has its own `package.json`/tests — see `junctions-cache/README.md` for endpoints, cache modes, and deploy details. Unit install: `deploy/install-wander-junctions.sh`.

Its Overpass upstream is `wander-overpass.service`, a pinned `wiktorn/overpass-api` container on shelly holding the Geofabrik Finland extract on `127.0.0.1:5002`, refreshed hourly from Geofabrik diffs. Public `overpass-api.de` is a fallback only, reached behind a 5-minute local-down latch. See `deploy/shelly-overpass/README.md`.

**Auth model:** cloud-backup accounts use a hashed bearer token (issued once by `POST /accounts`; SHA-256 digest in `server/src/lib/token-hash.ts`, compared constant-time in `server/src/middleware/auth.ts`). Every read/write is authenticated; missing-account and wrong-token both 401. Writes are capped at 10,000 rows/section and 32 MiB stored jsonb/account; GET omits older geometry unless `?geometry=full` (413 above 8 MiB); `GET /:username/archive/:section` is the cursor-paged escape hatch for an archive past that 413. The client carries the token in the URL fragment and always confirms before adopting a link-sourced account. The bearer lives in origin-wide `localStorage` (`walk_cloud_backup`) — XSS anywhere on `https://mase.fi` is cloud-backup takeover (accepted same-origin trust). Full contract: `server/README.md`.

`tools/` holds dev-only tooling (FIT round-trip validators, browser smoke-test page). Has its own `package.json` and `node_modules`; not referenced by `index.html` and not part of the deployed site.

**Core logic flow:**

1. User enters a starting location (address or lat/lng) and a max distance in km
2. Address inputs are geocoded via Nominatim; `resolveStart` then rejects a start outside `FINLAND_BBOX`
3. A destination is picked: a POI (categorized: nature, food, activity, culture, or `any POI` — the default), a random road point, or a fully random point. POI and road candidates come from `POST /api/junctions/{pois,roads}`, which returns at most 45 already-annulus-filtered candidates; `overpass.js` is two same-origin POSTs and holds no query building, retry loop or element parsing. It sends catalog KEYS (`"cafe"`, or `"all"` for any POI), never Overpass filter strings — a client that could name a filter could inject a query against our own instance, which is why `poi-types.js` ↔ `junctions-cache/src/poi-catalog.ts` is a parity-guarded twin. The candidate must sit closer than half the budget, since the walk is longer than the crow-flies distance out and back — `generate.js` divides by `ROUND_TRIP_SCALE` (2.6), or `ROUND_TRIP_SCALE_WIDE` (3.4) under the toggle in step 4
4. OSRM calculates a walking route. Round-trip always uses 3 geometric envelope vias per side (spread slider sets loop width). Round trips snap those vias to OSM junctions from junctions-cache (`buildJunctionLoop` in `osrm.js` — both chiralities, lower-overlap wins) and fall back to `buildLoop` on Overpass/OSRM failure; `buildLoop` snaps each via to the nearest road via OSRM nearest within `max(0.3 km, offsetKm·0.5)`. This is unconditional — the old `#smartRouting` toggle was removed once it had proven itself. See `junctions-cache/README.md`.

   **Avoid backtracking** (`#avoidBacktracking`, off by default) replaces the loop-shape constants, threaded like `winterMode`. The legacy pair is incoherent: the snap radius floors at 300 m while the envelope floors at 100 m, so for any trip under ~2.5 km at the default spread a via can be snapped further than the envelope displaced it — back across the start→dest line — collapsing both legs onto the same streets. The toggle adds `MIN_LOOP_OFFSET_KM` (0.3) to the spread-scaled offset instead of `max()`ing with it (a flat floor would swallow the bottom half of the slider; 0% and 25% already produce identical routes without it), ties the snap radius to half that offset, ranks candidates on `loopScore` (overlap **plus** budget overshoot — `findBestLoop` previously ignored the distance the user asked for) and picks destinations by the wider 3.4 divisor. Measured against live OSRM over 12 candidate pools: doubling-back 21%→10%, leg overlap 38%→15%, over-budget 5/12→1/12. It is a toggle so it can be A/B'd live, the way smart routing was before it became unconditional.

   **Degraded mode.** When self-hosted OSRM is unreachable, `osrm.js` latches for 5 minutes (`isSelfHostedDown`) and transparently retries against public FOSSGIS OSRM, serializing every public request ≥1.1 s apart to respect its fair-use cap — that pacing is internal and needs no caller cooperation. The latch also surfaces as a `degraded` mode flag from `readRouteBuildOptions`, threaded like `winterMode`: it skips via-snapping, junctions and candidate retries, cutting a generate from 8 requests to 2. A toast says so once per page load. Routes are rougher and slower, but real. Design: `docs/plans/2026-08-29-public-osrm-fallback-design.md`.
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
pnpm test              # vitest (runs against wander_test, never prod; waits for
                       # a sibling session's run — every worktree shares that DB)
pnpm db:reset:test     # rebuild wander_test from the migration chain
pnpm db:migrate        # PROD — guarded: refuses destructive DDL from a worktree
pnpm build             # tsc → dist/
```

Four independent pnpm lockfiles (root, `server/`, `junctions-cache/`, `tools/`) so pnpm does not hoist — layout, the silent-absorb trap, and the `*_test` hard-throw: `tests/README.md`. Only `server/` (forgejo-deploy) and `junctions-cache/` (shelly hook) are `pnpm install`ed on deploy; root and `tools/` are local/dev only.

Deploy with `deploy` (push → forgejo-deploy builds the server, migrates, copies frontend; local script restarts `wander-api`). Canonical nginx/systemd files, unit-install caveat, and `ProtectHome=tmpfs`: `deploy/README.md`. Junctions-cache deploys separately (`junctions-cache/README.md`).
