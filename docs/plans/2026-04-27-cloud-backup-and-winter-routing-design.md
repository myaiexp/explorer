# Cloud-Keyed User Backup + Winter Routing — Design

**Status:** Spec / pre-implementation
**Date:** 2026-04-27
**Scope:** Two independent subsystems shipped in one design pass. Plan + implementation will sequence them (A first; B is a small follow-on).

---

## Part 1 — Cloud-Keyed User Backup (Subsystem A)

### Purpose

Wander is currently 100% client-side. Visit history, favorites, and saved locations live in localStorage and vanish if the user clears site data. This subsystem mirrors the user's data to a server keyed by a generated username, so:

1. A localStorage wipe does not destroy years of route history.
2. The user can resume from a different device by visiting `mase.fi/explorer/<username>`.
3. The dataset becomes the substrate for a future preference-recommendation feature (out of scope here).

There is no traditional auth — the URL itself is the access token, like a Google Docs share link. Recovery from total client-side loss happens out-of-band: the user contacts Mase, who looks up their account in the DB.

### Non-goals

- Email/password auth
- Automated account recovery flows
- Multi-user route sharing or social features
- The recommendation engine itself (separate future project)
- Migrating *existing* localStorage visits to the enriched schema

### Architecture overview

```
┌──────────────────────┐       HTTPS        ┌────────────────────────────┐
│  Static frontend     │ ─────────────────▶ │  mase.fi nginx reverse     │
│  (existing app.js +  │                    │  proxy                      │
│  new sync layer)     │                    │  /explorer/api/* → :PORT   │
└──────────────────────┘                    └────────────┬───────────────┘
                                                          │
                                                          ▼
                                            ┌────────────────────────────┐
                                            │  explorer-api (new svc)    │
                                            │  Node + pnpm + Hono        │
                                            │  Drizzle → Postgres        │
                                            │  systemd unit on VPS        │
                                            └────────────┬───────────────┘
                                                          │
                                                          ▼
                                            ┌────────────────────────────┐
                                            │  Existing shared Postgres  │
                                            │  schema: explorer          │
                                            └────────────────────────────┘
```

- **Frontend:** stays static, no build step. Gains a small sync module (~250 lines target) bolted onto existing localStorage write paths.
- **Backend:** new standalone service. Lives in this repo under `server/` (or a peer directory — to be confirmed during plan phase based on existing project conventions).
- **DB:** existing shared Postgres on the VPS. New schema namespace `explorer`.
- **Reverse proxy:** nginx already serves `mase.fi/explorer/*` for the static site. Two changes required:
  1. Add `/explorer/api/*` → local service port (new `location` block, proxy_pass).
  2. **Static fallback for username paths.** `mase.fi/explorer/<username>` must serve `index.html` so the SPA can read `location.pathname`. Add `try_files $uri $uri/ /explorer/index.html;` (or equivalent) inside the existing `/explorer/` block. Without this, every shared-account URL 404s. This is a blocking prerequisite for the feature.

### Identity model

#### Username

- Format: `adjective-noun-NN` (e.g. `rugged-pine-42`).
- Server-generated using two curated wordlists (~1000 each) plus a 0–99 number suffix. Keyspace ≈ 10¹¹.
- Server owns collision detection — on collision, regenerate with a different number/word combo until unique. Loop bounded; in practice resolves in ≤2 tries.
- Username is the primary key for all per-user rows.

#### URL is the auth token

- `mase.fi/explorer/` → anonymous landing.
- `mase.fi/explorer/<username>` → loads that account's data.
- Anyone with the URL has full read/write access. This is the design — same model as a Google Docs share link.
- Implication: server enforces rate limits, but does not authenticate beyond username existence + (optional) IP/UA throttling.

#### Recovery

Out-of-band only. If a user contacts Mase saying "I lost everything", he can:
1. Search the DB by approximate creation date / IP / saved-location text.
2. Hand back the URL `mase.fi/explorer/<username>`.

This is intentional — no email column, no PII beyond what the user voluntarily put in saved locations.

### Consent and per-browser opt-in

The first time the user takes a persistable action (mark visit, save location, favorite a route), this flow runs:

1. **Local write happens immediately.** The action is never blocked on consent.
2. **Toast appears once:** *"Wander can save your data (visits, saved locations, favorites) to a database on mase.fi so it survives clearing your browser. — [Accept] [Decline]"*
3. **Accept path:**
   - `POST /api/explorer/accounts` → server returns `{ username }`.
   - Frontend stores `walk_cloud_backup: { state: 'accepted', username }` in localStorage.
   - URL rewrites to `mase.fi/explorer/<username>` via `history.replaceState`.
   - Bulk-upload of current localStorage via `POST /api/explorer/:username/import`.
   - Sync becomes ongoing (per-row, see below).
4. **Decline path:**
   - localStorage gets `walk_cloud_backup: { state: 'declined' }`.
   - No URL change. No API calls ever.
   - Toast never re-appears automatically.
5. **Re-opt-in:** A "Enable cloud backup" entry in the overflow menu (top-bar `…` button) re-runs the consent flow, regardless of declined state.

The decision is **per-browser** (localStorage scope). Accepting on phone, declining on laptop is supported and expected.

### URL-load behaviour

When the page loads, the frontend reads `location.pathname`:

- **No username segment** → behave as today; consent toast may fire on first persist.
- **Username segment, localStorage empty** → `GET /api/explorer/:username`, populate localStorage, app starts up.
- **Username segment, localStorage matches** (already accepted with same username) → silent re-sync.
- **Username segment, localStorage has *different* state** (different username, or anonymous-with-data, or declined) → blocking confirm dialog:
  *"Loading account `rugged-pine-42` — this will replace your current local data. [Continue] [Cancel]"*
  - Continue → wipe relevant localStorage keys, fetch from server, set username flag, redirect URL.
  - Cancel → strip the username from URL via `history.replaceState`, keep current state.

### Data scope: what gets backed up

Four high-value localStorage keys mirror to the server:

| Key | Server table | Loss impact | Privacy notes |
|---|---|---|---|
| `walk_visits` | `explorer.visits` | High — irreplaceable | Coords; benign |
| `walk_saved_locations` | `explorer.saved_locations` | High | May contain home/work addresses |
| `walk_favorites` | `explorer.favorites` | Medium | Coords; benign |
| `walk_history` | `explorer.history` | Medium | Coords; benign |

`walk_settings` (slider values, last typed location text) is **excluded** — easy to re-pick, not worth a sync round-trip.

### Visit schema enrichment

For the recommendation engine to ever work, new visits need richer context. From subsystem A onward, the visit row gains:

- `poi_category` — string, the OSM-category key the user picked (`park`, `cafe`, `nature_reserve`, `forest`, etc., or `null` for road-point / random-point destinations).
- `trip_mode` — `'round'` or `'one-way'`.
- `dest_name` — display name of the destination (e.g. resolved POI name or address).

Old visits stay lean. No migration. The recommender (when built) will operate on whatever fields are populated.

These same fields are added to the *client-side* visit object in `markAsVisited` so the data flows symmetrically.

### Sync model: per-row upsert with offline outbox

Each persistable mutation in the client does two things:

1. Write to localStorage (immediate, never blocked).
2. Enqueue an API call: `PUT /api/explorer/:username/<section>/:id` (or `DELETE`).

The outbox is a small array in localStorage (`walk_sync_outbox`). On every mutation:

- If online and outbox is empty → fire the call directly.
- If offline or outbox non-empty → push to outbox, kick a flush worker.

The flush worker drains the outbox FIFO, retrying with exponential backoff on network failure. Successful entries are removed; permanently-failed entries (4xx other than 429) are dropped after surfacing a console warning. The outbox survives page reloads.

This per-row model is multi-device-safe by construction: two devices marking different visits cannot clobber each other, because each PUT is keyed by row ID.

#### Initial bulk upload (on Accept)

Special case for the moment of consent: the user may already have hundreds of localStorage visits. Instead of enqueueing each as a separate PUT, the Accept handler calls `POST /api/explorer/:username/import` with the entire dataset in one body, server inserts in a transaction.

#### Multi-tab same browser

The browser `storage` event fires across tabs in the same origin. Each tab listens and refreshes its in-memory state when localStorage changes. No server-side push needed — and irrelevant for cross-device, where pull-on-load is the contract.

### API surface

Base path: `/explorer/api` (matches the nginx proxy rule in the architecture diagram). All paths below are relative to that base. JSON wire format is **camelCase** end-to-end — client objects are sent as-is, and Drizzle's `pgTable` column definitions map snake_case DB columns to camelCase JS properties on the way in/out. No client-side renaming.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/accounts` | Create new account. Returns `{ username }`. |
| `GET` | `/:username` | Bulk fetch all sections for that user. Returns `{ visits, favorites, saved_locations, history }`. |
| `POST` | `/:username/import` | Bulk replace all sections (used at Accept). Body: same shape as GET response. |
| `PUT` | `/:username/visits/:id` | Upsert one visit. |
| `DELETE` | `/:username/visits/:id` | Delete one visit. |
| `PUT` | `/:username/favorites/:id` | Upsert one favorite. |
| `DELETE` | `/:username/favorites/:id` | Delete one favorite. |
| `PUT` | `/:username/saved-locations/:id` | Upsert one saved location. |
| `DELETE` | `/:username/saved-locations/:id` | Delete one saved location. |
| `PUT` | `/:username/history/:id` | Upsert one history entry. |
| `DELETE` | `/:username/history/:id` | Delete one history entry. |
| `DELETE` | `/:username` | Hard-delete the entire account and all rows. Used by "Delete cloud data" button. |

All write endpoints validate that `:username` exists; `404` if not. `429` returned when rate limit hit.

### Database schema

```
explorer.accounts
  username           text PRIMARY KEY      -- "rugged-pine-42"
  created_at         timestamptz NOT NULL
  ip_first_seen      inet                  -- nullable, for rate-limit and lookup-by-IP

explorer.visits
  id                       text PRIMARY KEY  -- client-supplied UUID v4
  username                 text NOT NULL REFERENCES explorer.accounts(username) ON DELETE CASCADE
  date                     timestamptz NOT NULL
  start_lat                double precision NOT NULL
  start_lng                double precision NOT NULL
  start_label              text
  dest_lat                 double precision NOT NULL
  dest_lng                 double precision NOT NULL
  dest_name                text
  poi_category             text
  trip_mode                text   -- 'round' | 'one-way' | null (legacy)
  distance                 double precision NOT NULL
  route_coords             jsonb
  route_duration           double precision
  return_route_coords      jsonb
  return_route_duration    double precision
  updated_at               timestamptz NOT NULL DEFAULT now()
  INDEX (username)

explorer.favorites
  id           text PRIMARY KEY
  username     text NOT NULL REFERENCES explorer.accounts(username) ON DELETE CASCADE
  payload      jsonb NOT NULL    -- whatever shape the client stores; opaque to server
  updated_at   timestamptz NOT NULL DEFAULT now()
  INDEX (username)

explorer.saved_locations
  id           text PRIMARY KEY  -- client-supplied; for legacy entries that lack id, generate one on first sync
  username     text NOT NULL REFERENCES explorer.accounts(username) ON DELETE CASCADE
  label        text NOT NULL
  value        text NOT NULL
  updated_at   timestamptz NOT NULL DEFAULT now()
  INDEX (username)

explorer.history
  id                       text PRIMARY KEY
  username                 text NOT NULL REFERENCES explorer.accounts(username) ON DELETE CASCADE
  -- same fields as visits except created via auto-history (capped at 20 client-side)
  date                     timestamptz NOT NULL
  start_lat                double precision NOT NULL
  start_lng                double precision NOT NULL
  start_label              text
  dest_lat                 double precision NOT NULL
  dest_lng                 double precision NOT NULL
  dest_name                text
  trip_mode                text
  distance                 double precision NOT NULL
  route_coords             jsonb
  route_duration           double precision
  return_route_coords      jsonb
  return_route_duration    double precision
  updated_at               timestamptz NOT NULL DEFAULT now()
  INDEX (username)
```

**ID strategy:** all client-supplied IDs are switched from `Date.now()` to UUID v4 so two devices marking visits in the same millisecond cannot collide. Existing localStorage records keep their numeric IDs; the schema accepts `text` so both formats coexist.

**Saved-location IDs:** `walk_saved_locations` entries today are `{ label, value }` only — no `id` field. At the moment of Accept, the client iterates the existing array, generates a UUID v4 for each entry, writes the IDs back to localStorage, and includes them in the `POST /import` payload. Server treats `id` as required. For new saves after this feature ships, `toggleSaveLocation` generates a UUID at insert time.

**Foreign key cascade:** `DELETE /:username` cascades to all child tables, so account deletion is one statement.

### Rate limiting

Per-IP and per-username, soft limits — implemented in Hono middleware:

- 60 writes/min per username
- 300 writes/min per IP (covers a single user across multiple browsers)
- `POST /accounts` is more restricted: 10/hour per IP

Exceeded → 429 with `Retry-After`. Client outbox respects the header.

### UI changes

#### Top bar (overflow menu)

The existing three-dots overflow menu (index.html:21) gains:

- **Status line at top** (read-only): `Account: rugged-pine-42` — present whenever cloud backup is active. Hidden if anonymous or declined.
- **"Enable cloud backup"** button — visible only when not currently accepted. Triggers consent flow.
- **"Delete cloud data"** button — visible only when accepted. Confirms, then `DELETE /:username`, clears the local cloud-backup flag, and `history.replaceState`s the URL back to `mase.fi/explorer/` (stripping the username so the next reload doesn't re-enter the deleted-account flow). localStorage rows are kept; the user simply unlinks from cloud.

#### First-persist toast

Plain top-or-bottom toast with two buttons. Same visual language as existing success/error toasts.

### Error handling

| Failure | Behaviour |
|---|---|
| Offline / network error during PUT | Outbox retains entry, retried on next online or next mutation |
| `404` on PUT (account deleted server-side) | Wipe local cloud-backup flag, drop username from URL, show toast: "Cloud backup was disabled remotely." |
| `409` on `POST /accounts` | Server side handles internally by retrying with bumped suffix; client never sees this |
| `429` rate-limited | Outbox respects `Retry-After`; if no header, exponential backoff |
| 5xx | Outbox retains; backoff |
| Bulk import partial failure | Server runs in transaction; either all-or-nothing per request |
| Confirm dialog cancelled (URL load scenario 3) | URL stripped, local state untouched |

### Testing

- **Migrations:** Drizzle migrations applied on deploy; `migrate` (not `push`) to keep non-interactive.
- **API:** vitest + supertest hitting an isolated test schema in the same Postgres. Cover: create-fetch-update-delete per section, bulk import, account deletion cascades, rate-limit responses, 404 handling.
- **Frontend sync layer:** vitest unit tests on the outbox state machine with a mocked fetch.
- **End-to-end smoke:** laxi script runs the consent flow on local dev — first-persist triggers toast, Accept rewrites URL, bulk import fires, follow-up persist enqueues a PUT.
- **Multi-device manual check:** two browser profiles, accept the same URL on both, verify a visit added on one appears on the other after reload.

### Privacy / security notes

- Consent toast copy explicitly names what's stored and where ("on mase.fi"). No surprise persistence.
- Saved locations may contain home/work addresses — this is not new (already in localStorage), but moving them server-side raises the trust bar. The explicit consent step covers it.
- "Delete cloud data" provides a self-service erasure path.
- Public repo: do not commit DB connection strings; read from `.env`.

### Out-of-scope follow-ups

(Captured to ideation backlog separately.)

- Recommendation engine using `visits.poi_category` + completion data.
- Optional email recovery for users who want stronger guarantees.
- Migration script to enrich legacy visits via reverse-lookup against Overpass.

---

## Part 2 — Winter vs Summer Routing (Subsystem B)

### Purpose

The OSRM walking profile (`routed-foot`) treats forest paths and tracks identically year-round. In Finnish winter, those routes are often unwalked snow. Existing "smart routing" (`buildSmartLoop` / `selectRoadVias`) snaps loop vias to *any* road from Overpass — including paths and tracks.

Winter mode biases that snapping toward roads that are typically plowed: residential, tertiary, secondary, primary, etc. — and away from paths/tracks/footways through forests.

### Non-goals (this iteration)

- POI category filtering (don't auto-skip `forest` / `nature_reserve` POIs in winter).
- POI category warnings.
- Winter-specific OSRM profile (would require a self-hosted OSRM with a custom profile).
- Use of municipal plowing datasets (idea logged for later).
- Auto-detecting winter by month.

### Architecture

Pure client-side, no backend involvement. Hooks into the existing smart-routing seam.

### Components

- New `winterMode` checkbox in the controls panel, near the existing smart-routing toggle.
- Setting persisted in `walk_settings` (already excluded from cloud sync, but that is the right call — winter mode is a UX preference, not user data).
- The actual seam is the two Overpass query functions: `fetchRoadsInCorridor` (app.js:485, used by `buildSmartLoop`) and `fetchRoadsInRadius` (app.js:462, used for the road-point destination type). Both build an Overpass `way["highway"]` query — winter mode tightens that query's `highway!~` exclusion list.

### Behaviour

When `winterMode` is true:

- `fetchRoadsInCorridor` and `fetchRoadsInRadius` use a tighter exclusion list. Today's filter excludes `motorway|motorway_link|trunk|trunk_link|service|steps`; winter mode also excludes `path|track|footway|bridleway|cycleway|pedestrian`. Effectively only `residential|unclassified|tertiary|secondary|primary|living_street` (and similar) ways come back from Overpass.
- `selectRoadVias` therefore only sees roads from that filtered set when picking snap candidates.
- If no qualifying roads are in the corridor → existing fallback to geometric vias kicks in.

When `winterMode` is true but smart routing is **off**: the toggle has no effect on routing today, because smart-routing is what consumes the corridor roads. (Future enhancement could also filter the random-road *destination* type independently, but for v1 winter mode is gated on smart routing.)

When `winterMode` is false: behaviour is identical to today.

**Known limitation — `fetchNearestRoadSnaps`:** `buildSmartLoop` also uses OSRM's nearest-waypoint endpoint to refine via positions (`fetchNearestRoadSnaps`, app.js:551). That endpoint snaps to whatever the OSRM `routed-foot` profile considers a walkable way — including paths and tracks — and it cannot be filtered by highway tag. So a via that's been snapped to a Overpass-filtered road may then drift back toward a path during OSRM nearest refinement. This is a best-effort feature; full elimination of forest-path routing would require self-hosting an OSRM with a winter-aware profile (logged as deferred idea).

### UI

Single labelled checkbox: `Winter mode (avoid forest paths)` — placed adjacent to the existing smart-routing checkbox in the controls panel.

Tooltip on hover: *"Routes prefer plowed roads instead of forest paths and tracks. Useful in winter."*

### Failure modes

- No qualifying roads near a via → already handled, falls back to geometric via.
- Overpass timeout → already handled, falls back to non-smart routing.

### Testing

- Manual: run a generation in a known mixed-terrain area (e.g. starting near a forest edge) with winter mode on, confirm the loop avoids `path`/`track` ways.
- Unit: filter function with a mock Overpass response containing both road types, assert paths are excluded.

---

## Sequencing

Implementation plan will sequence these as:

1. Subsystem A end-to-end (backend service stood up, frontend sync layer, UI changes, deploy).
2. Subsystem B (small client-only change) as a second commit/PR.

Both ship as part of this design's plan, but they are independently shippable.
