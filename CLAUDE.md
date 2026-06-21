# CLAUDE.md

## Project Overview

**Wander** — a static web app for generating random walking/exploration destinations. Pick a starting location and radius, get a random POI or point, see a routed round-trip or one-way path on a Leaflet map.

## Architecture

Frontend is a vanilla static app, no build step. Source files served as-is from `/var/www/html/explorer`, in `index.html` `defer` load order:

- `index.html` — structure
- `style.css` — styles
- `geo-utils.js` — canonical Haversine distance, km + meters (pure, globalThis-exposed; loaded first — used by geometry.js, fit-encoder.js, loop-quality.js, screening.js, novelty.js, app.js)
- `geometry.js` — pure geometry: calculateDistance (haversineKm alias), bearingRad, envelopeOffsetPoint, generateRandomPointAnnulus, computeSpreadParams (globalThis-exposed; loaded after geo-utils.js)
- `fit-encoder.js` — Garmin FIT course-file encoder (used by `exportFIT()` in app.js)
- `sync.js` — cloud-backup sync engine (outbox + per-row upserts to `/explorer/api`)
- `bbox.js` — Finland bounding box helpers (pure, globalThis-exposed)
- `loop-quality.js` — loop overlap detection (pure, globalThis-exposed)
- `novelty.js` — novelty ranking helpers (pure, globalThis-exposed)
- `screening.js` — water-aware reachability filtering (pure, globalThis-exposed)
- `overpass.js` — Overpass querying: queryOverpass, fetchPOIsInRadius, fetchRoadsInRadius (+ sleep, HIGHWAY_EXCLUDE_*; no DOM, globalThis-exposed; loaded after geometry.js)
- `osrm.js` — OSRM routing + loop building: tryOsrm/fetchRouteThrough/tryNearest/snapToRoad/screeningTableFn + buildLoopSetup/buildLoop/buildJunctionLoop/buildOneWay/fetchCorridorJunctions/snapToJunction/pickBetterLoop (DOM-free — callers pass a precomputed spread; globalThis-exposed; loaded after geometry.js + loop-quality.js)
- `storage.js` — localStorage accessors: readStoredArray + getVisits/getSavedLocations/getFavorites/getHistory and their keys (globalThis-exposed)
- `route-dispatch.js` — route-build dispatch by trip mode (globalThis-exposed; calls buildOneWay/buildJunctionLoop/buildLoop from osrm.js)
- `toast.js` — transient #notification toast (globalThis-exposed; showToast + showError/showSuccess/showWarning wrappers)
- `app.js` — main application logic (orchestration, DOM, Leaflet; consumes the geometry/overpass/osrm/storage modules as globals)

Backend (cloud backup) lives in `server/` — Node 20 + Hono + Drizzle + Postgres on port 3700, exposed via nginx at `/explorer/api/*`. systemd unit `explorer-api.service`. DB `explorer` (user `explorer`). Migrations under `server/drizzle/`. Static frontend tests at repo root use vitest + jsdom (`pnpm vitest run tests/sync.test.js`); backend tests run with `cd server && pnpm test`.

**Auth model:** each account has a high-entropy secret `token` (32 random bytes, base64url) issued by `POST /accounts` (the only time it's returned). Every read/write — `GET /:username`, the section PUT/DELETE routes, `POST /:username/import`, `DELETE /:username` — requires `Authorization: Bearer <token>` (verified constant-time in `middleware/auth.ts`). The human-readable username is only a public handle, not a credential. Missing-account and wrong-token both return an identical `401` so the endpoint can't be used to enumerate usernames; `GET /:username` is also IP rate-limited (60/min). The client (`sync.js`) stores the token in the `walk_cloud_backup` consent record and carries it in the URL **fragment** (`/explorer/<username>#t=<token>`) so the private link works cross-device while keeping the secret out of server logs/Referer. The overflow menu's "Copy backup link" button copies that full link. Opening a link-sourced account on a device that isn't already bound to it (no stored consent record for that username) always prompts a `window.confirm` before adopting it — even on a fresh/empty browser — so a shared link can't silently bind a visitor's browser to a foreign account and harvest their future walks.

`tools/` holds dev-only tooling (FIT round-trip validators, browser smoke-test page). Has its own `package.json` and `node_modules`; not referenced by `index.html` and not part of the deployed site.

**Core logic flow:**

1. User enters a starting location (address or lat/lng) and a max distance in km
2. Address inputs are geocoded via Nominatim
3. A destination is picked: random POI from Overpass (categorized: nature, food, activity, culture, or "any"), random road point, or fully random point
4. OSRM calculates a walking route; round-trip mode builds a loop by generating 3 geometric envelope vias per side, snapping each independently to the nearest road via OSRM nearest within `max(0.3 km, offsetKm·0.5)`, then routing through them (spread slider controls loop width)
5. Result shown on Leaflet map with markers, route polylines, elevation profile chart, distance/duration badges, Google Maps directions link

**Key features:** saved locations, favorites/bookmarks, visit history with map overlay, GPX export, Garmin FIT export (course file with turn cues from OSRM steps), route sharing via URL, "Surprise me" button, Overpass rate-limit handling with retry logic, XSS protection on URL parameters, localStorage persistence of all settings.

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
pnpm test              # vitest
pnpm build             # tsc → dist/
```

Deploy with `deploy` — pushes to Forgejo, which triggers `forgejo-deploy` to: check out into `~/Projects/explorer`, build the server, run migrations, and rsync frontend assets to `/var/www/html/explorer`. The local `deploy` script then restarts `explorer-api.service`.
