# Architecture

How Wander's four parts fit together, and what one Generate does from input to map. CLAUDE.md is the map; this is the depth behind it.

## Frontend

A vanilla static app with no build step. The repo-root `*.html`/`*.js`/`*.css` files and `fonts/` are served as-is from `/var/www/html/wander` (the copy rule is in `deploy/README.md`).

- **Script order.** Every script is a classic `defer`d `<script>` in `index.html`; each assigns its public names onto `globalThis` and reads its collaborators back off it. Load order is therefore dependency-significant. Dependency-bearing files declare their order in their header comment, and `SCRIPT_DEPS` (`tests/helpers/script-deps.js`) is the single ordered graph — check it before reordering a script tag.
- **One-way dependencies.** `app.js` is the composition root and owns no feature: it wires modules and paints the first frame, and nothing calls back into it.
- **Session state.** The route on screen lives in `session-state.js` behind `getCurrentSession()` / `setCurrentSession()`.
- **The build mutex.** Every route build runs through `withLoading` in `loading.js`, which is also the one-build-at-a-time mutex. The entry points (Enter, Ctrl+Enter, surprise, pick-on-map, the spread slider) bypass the disabled generate button, so overlap is prevented in `withLoading`, not per button.
- **Finland only.** Starts outside `bbox.js` `FINLAND_BBOX` are rejected after geocode (`resolveStart` in `location-input.js`) and when restoring a shared link (`restoreFromHash` in `share-link.js`, start and dest).
- **Styles.** `docs/design.md` is the design system (colors, typography, components, layout). The stylesheet is split by region into top-level `style-*.css` files (base → panel → controls → result → modals); `index.html` links them in that order, and the cascade depends on it. They stay top-level because deploy copies only top-level `*.css`.

## Cloud-backup API (`server/`)

Node 24 + Hono + Drizzle + Postgres, exposed via nginx at `/wander/api/*` over the socket-activated `/run/wander-api.sock` (0660 root:www-data — the only path on which it trusts `X-Real-IP`). systemd unit `wander-api.service` runs as the `wander` system user with `ProtectHome` + `MemoryMax=512M` and serves the built `dist/`. DB `wander` (user `wander`); the connection string is `DATABASE_URL` in `server/.env`. Migrations live under `server/drizzle/`.

**Auth model.** Accounts use a hashed bearer token, issued once by `POST /api/accounts`; the SHA-256 digest is in `server/src/lib/token-hash.ts` and compared constant-time in `server/src/middleware/auth.ts`. Every read and write is authenticated; a missing account and a wrong token both return 401. Writes are capped at 10,000 rows/section and 32 MiB stored jsonb/account. GET omits older geometry unless `?geometry=full` (413 above 8 MiB); `GET /api/:username/archive/:section` is the cursor-paged escape hatch for an archive past that 413.

The client carries the token in the URL fragment and always confirms before adopting a link-sourced account. The bearer lives in origin-wide `localStorage` (`walk_cloud_backup`), so XSS anywhere on `https://mase.fi` is cloud-backup takeover — accepted same-origin trust. Full contract: `server/README.md`.

## Candidate and junction lookups (`junctions-cache/`)

A separate Hono microservice and **the app's only Overpass client** — the browser never queries an Overpass instance directly. It serves three cached, start-anchored lookups: road junctions (`/junctions`, for via snapping), POI candidates (`/pois`) and road candidates (`/roads`). The two pool endpoints do the annulus filtering and 45-candidate capping server-side, so a generate ships kilobytes instead of the 5.2 MB a 3.85 km road query used to put on the wire.

It runs on **shelly**, not the VPS: `wander-junctions.service` (dedicated `wander-junctions` nologin user, `ProtectHome` + `MemoryMax=512M`) listening on `HOST=100.69.160.113`, `PORT=5001` (default `127.0.0.1:5001`), checked out at `/home/shelly/Projects/wander/junctions-cache` from the `shelly` git remote (`ssh://shelly/home/shelly/wander.git`). The cache snapshot is `/var/lib/wander-junctions/cache.json`. VPS nginx proxies `https://mase.fi/api/junctions/` to it. Endpoints, cache modes and deploy: `junctions-cache/README.md`; unit install: `deploy/install-wander-junctions.sh`.

Its Overpass upstream is `wander-overpass.service`, a pinned `wiktorn/overpass-api` container on shelly holding the Geofabrik Finland extract on `127.0.0.1:5002`, refreshed hourly from Geofabrik diffs. Public `overpass-api.de` is a fallback only, reached behind a 5-minute local-down latch. See `deploy/shelly-overpass/README.md`.

## Routing (OSRM)

Walking routes go to self-hosted OSRM-foot at `https://mase.fi/api/osrm-fi` (`deploy/shelly-osrm/`), falling back to public FOSSGIS OSRM only when that is unreachable (degraded mode, below).

## One Generate, end to end

1. The user enters a starting location (address or lat/lng) and a max distance in km — or a walking time in minutes, which `time-budget.js` converts to that km at 5 km/h.
2. Address inputs are geocoded via Nominatim; `resolveStart` then rejects a start outside `FINLAND_BBOX`.
3. `resolveCandidatePool` (`destination-resolve.js`) picks a destination pool: a POI (nature, food, activity, culture, or `any POI` — the default), a random road point, or a fully random point. POI and road pools come from junctions-cache `/pois` and `/roads` through `overpass.js`, which sends catalog keys only. `generate.js` shrinks the straight-line radius by `ROUND_TRIP_SCALE`, since the walk is longer than the crow-flies distance out and back.
4. `screenCandidatePool` (`destination-resolve.js` → `screening.js`) drops water-locked candidates with one OSRM `/table` call. The original two-stage nearest+route design is `docs/plans/2026-04-30-water-aware-candidate-screening-design.md` (a record, not rewritten).
5. OSRM builds the walk. Round trips run `findBestLoop` → `buildJunctionLoop` (envelope vias snapped to junctions-cache junctions, both chiralities), falling back to `buildLoop` (vias snapped with OSRM nearest); one-way is a single route. Loop shape, the spread slider and the `#avoidBacktracking` toggle (off by default, kept as a toggle for live A/B) are explained in the "Loop envelope constants" comments in `geometry.js`; the measurements are in commit `99e11f6`.
6. The result is drawn on the Leaflet map with markers, route polylines, the elevation profile chart, distance/duration badges and a Google Maps directions link.

### Degraded mode

When self-hosted OSRM is unreachable, `osrm.js` latches for 5 minutes (`isSelfHostedDown`) and retries against public FOSSGIS OSRM, paced ≥1.1 s apart. The latch also sets `degraded` in `readRouteBuildOptions`, which skips via-snapping, junctions and candidate retries: a round trip becomes the screening `/table` plus two unsnapped route calls, and bypasses `findBestLoop` entirely (its retry budget is unchanged). A toast says so once per page load. Original design: `docs/plans/2026-08-29-public-osrm-fallback-design.md` (a record, not rewritten).
