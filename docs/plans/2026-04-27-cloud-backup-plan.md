# Cloud-Keyed User Backup Implementation Plan

**Goal:** Mirror Wander's four high-value localStorage keys (visits, favorites, saved_locations, history) to a new server keyed by a generated `adjective-noun-NN` username, with consent-based opt-in, per-row sync, offline outbox, and out-of-band recovery.

**Architecture:** New standalone backend service (Node + pnpm + Hono + Drizzle) using the existing shared Postgres on the VPS. Frontend gains a self-contained sync module bolted onto existing localStorage write paths. nginx proxies `/explorer/api/*` to the service and serves `index.html` as fallback for `/explorer/<username>` URLs. Username doubles as the auth token (Google-Docs-share-link model); recovery is out-of-band via Mase reading the DB.

**Tech Stack:** Node 20+ • pnpm • Hono • Drizzle ORM • Postgres (existing) • Vitest • nginx (existing) • systemd. Frontend stays plain JS, no build step.

**Spec:** [docs/plans/2026-04-27-cloud-backup-and-winter-routing-design.md](./2026-04-27-cloud-backup-and-winter-routing-design.md), Subsystem A.

---

## File Structure

```
explorer/                                       # repo root
├── server/                                     # NEW — backend service
│   ├── package.json                            # pnpm; Hono, Drizzle, pg, vitest deps
│   ├── tsconfig.json
│   ├── drizzle.config.ts
│   ├── .env.example                            # DATABASE_URL, PORT
│   ├── src/
│   │   ├── index.ts                            # entry point; Hono app, listens on PORT
│   │   ├── db.ts                               # Drizzle client + schema re-export
│   │   ├── schema.ts                           # Drizzle table definitions
│   │   ├── username.ts                         # generator + collision retry
│   │   ├── routes/
│   │   │   ├── accounts.ts                     # POST /accounts, DELETE /:username
│   │   │   ├── fetch.ts                        # GET /:username
│   │   │   ├── import.ts                       # POST /:username/import
│   │   │   └── sections.ts                     # PUT/DELETE per-section (visits, favorites, saved-locations, history)
│   │   ├── middleware/
│   │   │   └── rate-limit.ts                   # in-memory token bucket
│   │   └── wordlists/
│   │       ├── adjectives.ts                   # ~1000 entries
│   │       └── nouns.ts                        # ~1000 entries
│   ├── drizzle/                                # generated migrations
│   └── tests/
│       ├── accounts.test.ts
│       ├── sections.test.ts
│       ├── fetch.test.ts
│       ├── import.test.ts
│       └── rate-limit.test.ts
├── sync.js                                     # NEW — frontend sync module (loaded from index.html)
├── app.js                                      # MODIFY — plumb sync calls into mutation paths
├── index.html                                  # MODIFY — script tag for sync.js, overflow-menu items
├── style.css                                   # MODIFY — toast variant, status-line styling
└── deploy/
    ├── nginx-explorer.conf                     # MODIFY/NEW — /explorer/api proxy + SPA fallback
    └── explorer-api.service                    # NEW — systemd unit
```

**Boundaries:**
- `server/` is fully independent; can be tested without the frontend.
- `sync.js` exposes a small global API (`ExplorerSync.{init, mutate, accept, decline, deleteAccount, getState}`) consumed by `app.js`. It owns localStorage cloud-backup state, the outbox, and all `fetch` calls. `app.js` does not call `fetch` to the new API directly.
- Schema enrichment (poiCategory/tripMode/destName) lands in `app.js` mutation sites; `sync.js` does not reshape data.

---

## Task 1: Backend scaffold + schema + migrations  [Mode: Direct]

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/drizzle.config.ts`, `server/.env.example`
- Create: `server/src/index.ts`, `server/src/db.ts`, `server/src/schema.ts`
- Create: `server/drizzle/0000_initial.sql` (generated)

**Contracts:**

`server/src/schema.ts` exports five Drizzle tables matching the design doc — column types and FK cascades exactly as specified. Field naming: snake_case in DB, camelCase in TS via Drizzle's column property names.

```ts
// schema.ts excerpt
export const accounts = pgTable('accounts', {
  username: text('username').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  ipFirstSeen: inet('ip_first_seen'),
});

export const visits = pgTable('visits', {
  id: text('id').primaryKey(),
  username: text('username').notNull().references(() => accounts.username, { onDelete: 'cascade' }),
  date: timestamp('date', { withTimezone: true }).notNull(),
  startLat: doublePrecision('start_lat').notNull(),
  startLng: doublePrecision('start_lng').notNull(),
  startLabel: text('start_label'),
  destLat: doublePrecision('dest_lat').notNull(),
  destLng: doublePrecision('dest_lng').notNull(),
  destName: text('dest_name'),
  poiCategory: text('poi_category'),
  tripMode: text('trip_mode'),
  distance: doublePrecision('distance').notNull(),
  routeCoords: jsonb('route_coords'),
  routeDuration: doublePrecision('route_duration'),
  returnRouteCoords: jsonb('return_route_coords'),
  returnRouteDuration: doublePrecision('return_route_duration'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// favorites, savedLocations, history follow the design doc shape
```

`server/src/index.ts` mounts middleware, routes, and listens on `process.env.PORT`. Schema namespace: tables live in the existing shared Postgres under schema `explorer` (set via Drizzle config or migration prefix).

**Constraints:**
- Use `drizzle-kit generate` then `drizzle-kit migrate` (no `push` — see CLAUDE.md non-interactive rule).
- Index `(username)` on every per-user table.
- All five tables in one migration.

**Verification:**
```bash
cd server && pnpm install && pnpm drizzle-kit generate && pnpm drizzle-kit migrate
psql "$DATABASE_URL" -c "\dt explorer.*"
# expect 5 tables: accounts, visits, favorites, saved_locations, history
```

**Commit after passing.**

---

## Task 2: Backend API — accounts, sections, fetch, import, delete  [Mode: Delegated]

**Files:**
- Create: `server/src/routes/accounts.ts`, `server/src/routes/fetch.ts`, `server/src/routes/import.ts`, `server/src/routes/sections.ts`
- Create: `server/src/username.ts`
- Create: `server/src/middleware/rate-limit.ts`
- Create: `server/src/wordlists/adjectives.ts`, `server/src/wordlists/nouns.ts`
- Modify: `server/src/index.ts` (mount routers)
- Test: `server/tests/accounts.test.ts`, `server/tests/sections.test.ts`, `server/tests/fetch.test.ts`, `server/tests/import.test.ts`, `server/tests/rate-limit.test.ts`

**Contracts:**

All endpoints return JSON, camelCase keys, `application/json` Content-Type. Errors are `{ error: string }` with appropriate status code.

```
POST   /explorer/api/accounts                        → 201 { username }
GET    /explorer/api/:username                       → 200 { visits[], favorites[], savedLocations[], history[] } | 404
POST   /explorer/api/:username/import                → 204 (transaction; replaces all four sections)
PUT    /explorer/api/:username/visits/:id            → 204 (upsert by id; 404 if user missing)
DELETE /explorer/api/:username/visits/:id            → 204
PUT    /explorer/api/:username/favorites/:id         → 204
DELETE /explorer/api/:username/favorites/:id         → 204
PUT    /explorer/api/:username/saved-locations/:id   → 204
DELETE /explorer/api/:username/saved-locations/:id   → 204
PUT    /explorer/api/:username/history/:id           → 204
DELETE /explorer/api/:username/history/:id           → 204
DELETE /explorer/api/:username                       → 204 (cascade)
```

`username.ts`:
```ts
export function generateUsername(): string;             // returns "adjective-noun-NN"
export async function createAccount(ip: string | null): Promise<string>;
// Tries up to 10 generations, INSERTs first non-collision, returns username.
// Throws RangeError after 10 collisions (vanishingly unlikely with 10^11 keyspace).
```

`rate-limit.ts`: in-memory token-bucket middleware (no Redis dependency). Three buckets:
- 60 writes/min per username (PUT/DELETE on per-section routes)
- 300 writes/min per IP
- 10 account creations/hour per IP (`POST /accounts`)

429 response includes `Retry-After` header in seconds.

The bucket store must export a `resetRateLimiter()` function used by tests; without it, the in-memory state from earlier tests bleeds into the "61st returns 429" assertion. Call it in a `beforeEach` in `rate-limit.test.ts`.

**Test Cases:**

```ts
// accounts.test.ts
test('POST /accounts returns a unique username and creates a row', async () => {
  const res = await app.request('/explorer/api/accounts', { method: 'POST' });
  expect(res.status).toBe(201);
  const { username } = await res.json();
  expect(username).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  const row = await db.select().from(accounts).where(eq(accounts.username, username));
  expect(row).toHaveLength(1);
});

test('POST /accounts retries on collision', async () => {
  // mock generateUsername to return same string twice, then a unique one
  // expect single row created with the unique value
});

test('DELETE /:username cascades to all child tables', async () => {
  const u = await createTestAccount();
  await insertTestVisit(u);
  await insertTestFavorite(u);
  await app.request(`/explorer/api/${u}`, { method: 'DELETE' });
  expect(await db.select().from(visits).where(eq(visits.username, u))).toHaveLength(0);
  expect(await db.select().from(favorites).where(eq(favorites.username, u))).toHaveLength(0);
});

// sections.test.ts
test('PUT visits/:id upserts (insert then update)', async () => {
  const u = await createTestAccount();
  const id = 'uuid-1';
  await app.request(`/explorer/api/${u}/visits/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ id, date: '2026-04-27T10:00:00Z', startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 5 }),
    headers: { 'content-type': 'application/json' },
  });
  await app.request(`/explorer/api/${u}/visits/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ id, date: '2026-04-27T10:00:00Z', startLat: 60, startLng: 25, destLat: 60.1, destLng: 25.1, distance: 7 /* changed */ }),
    headers: { 'content-type': 'application/json' },
  });
  const rows = await db.select().from(visits).where(eq(visits.id, id));
  expect(rows).toHaveLength(1);
  expect(rows[0].distance).toBe(7);
});

test('PUT visits/:id on missing user returns 404', async () => {
  const res = await app.request('/explorer/api/no-such-user-99/visits/uuid-1', { method: 'PUT', body: '{}' });
  expect(res.status).toBe(404);
});

test('DELETE visits/:id removes only that row', async () => { /* ... */ });

// fetch.test.ts
test('GET /:username returns all four sections in camelCase', async () => {
  const u = await createTestAccount();
  await insertTestVisit(u);
  const res = await app.request(`/explorer/api/${u}`);
  const body = await res.json();
  expect(body).toHaveProperty('visits');
  expect(body).toHaveProperty('favorites');
  expect(body).toHaveProperty('savedLocations');
  expect(body).toHaveProperty('history');
  expect(body.visits[0]).toHaveProperty('startLat');  // camelCase
});

test('GET /:username on missing user returns 404', async () => { /* ... */ });

// import.test.ts
test('POST /:username/import replaces all sections atomically', async () => {
  const u = await createTestAccount();
  await insertTestVisit(u);
  const payload = { visits: [/* 3 new visits */], favorites: [], savedLocations: [], history: [] };
  await app.request(`/explorer/api/${u}/import`, { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
  const rows = await db.select().from(visits).where(eq(visits.username, u));
  expect(rows).toHaveLength(3);  // old visit replaced
});

test('POST /:username/import rolls back on partial failure', async () => {
  // payload with one valid visit and one missing required field
  // expect 400 and zero changes to DB
});

// rate-limit.test.ts
test('60 writes/min/username, 61st returns 429', async () => { /* ... */ });
test('429 includes Retry-After header', async () => { /* ... */ });
test('10 account creations/hour/IP, 11th returns 429', async () => { /* ... */ });
```

**Constraints:**
- Wire format is camelCase end-to-end. Drizzle column-to-property mapping handles snake_case ↔ camelCase.
- All write paths inside transactions where the operation has multiple statements (e.g. `import`).
- Missing-user check (`accounts` row exists) on every per-user endpoint before any write.
- Rate-limit middleware applied selectively: account creation has its own bucket; per-section writes share another.

**Verification:**
```bash
cd server && pnpm test
# expect: all tests green, coverage of all 11 endpoints + rate limits
```

**Commit after passing.**

---

## Task 3: Frontend sync engine (sync.js)  [Mode: Delegated]

**Files:**
- Create: `sync.js`
- Test: `tests/sync.test.js` (use vitest with jsdom or node — pick what already exists; if neither, add minimal vitest setup at repo root)

**Contracts:**

`sync.js` is a single non-module script (loaded via `<script src="sync.js">` in index.html, parsed *before* `app.js`). It exposes a single global:

```js
window.ExplorerSync = {
  // Lifecycle
  init(): Promise<void>,                         // call on page load; reads localStorage state, parses URL, performs any load-from-server. Returns a Promise that resolves once the initial load (if any) is done — tests await this. The Promise also resolves immediately for anonymous/declined states with nothing to fetch.
  getState(): { state: 'anonymous'|'accepted'|'declined', username: string|null, outboxLength: number },

  // Consent flow
  requestConsent(): Promise<'accepted'|'declined'>,  // shows toast, returns user's choice; called by app.js on first persistable action when state is 'anonymous'
  accept(): Promise<void>,                          // POST /accounts → bulk import → set username → rewriteUrl
  decline(): void,                                  // sets declined flag, no API calls
  deleteAccount(): Promise<void>,                   // DELETE /:username → clear flag → strip URL

  // Mutation API (called by app.js whenever localStorage changes)
  mutate(section: 'visits'|'favorites'|'savedLocations'|'history', op: 'put'|'delete', id: string, data?: object): void,

  // Internal but exposed for tests
  _outbox: { peek(): Entry[]; flush(): Promise<void> },
};
```

**Behavior contract:**

1. `init()`:
   - Reads `walk_cloud_backup` localStorage key. Possible shapes: `{ state: 'accepted', username: 'rugged-pine-42' }` | `{ state: 'declined' }` | absent.
   - Reads `location.pathname` for `/explorer/<username>` segment.
   - **No URL segment, no flag** → state is `anonymous`. No API calls.
   - **URL segment matches stored username** → state is `accepted`. Triggers a silent `GET /:username` → merge into localStorage if newer (by `updatedAt` per row, last-write-wins).
   - **URL segment, no flag, localStorage empty** → silent `GET /:username` → populate localStorage → set flag → state is `accepted`.
   - **URL segment, no flag, localStorage non-empty** → show blocking modal *"Loading account `X` — this will replace your current local data. [Continue / Cancel]"*. Continue → wipe four keys, GET, populate, set flag. Cancel → `history.replaceState(null, '', '/explorer/')`, state stays `anonymous`.
   - **URL segment differs from stored username** → same modal as above, but message is *"Switching to account `X` from `Y` — your local data will be replaced."*

2. `mutate(section, op, id, data?)`:
   - State is `anonymous` or `declined` → no-op (returns immediately).
   - State is `accepted` → enqueue `{ section, op, id, data, attempts: 0 }` to outbox, persist outbox to localStorage key `walk_sync_outbox`, kick flush.

3. Flush worker:
   - Pulls FIFO. For each entry: PUT or DELETE to `/explorer/api/:username/<section>/:id`. On 2xx → drop entry. On 429 → respect `Retry-After`, requeue. On 4xx (other) → drop entry, `console.warn`. On 5xx / network → exponential backoff: 1s, 2s, 4s, 8s, 16s, then 60s steady. Stays on the same entry until success or perma-fail.
   - Single in-flight at a time (no concurrent fetches per-tab).
   - Listens to `online` event to flush early after offline period.

4. `accept()`:
   - `POST /explorer/api/accounts` → `{ username }`.
   - Iterates `walk_saved_locations` and assigns UUID v4 `id` to any entry missing one (writes back to localStorage).
   - Builds full payload from current localStorage (visits, favorites, savedLocations, history).
   - `POST /:username/import` with payload.
   - On success: write `walk_cloud_backup = { state: 'accepted', username }`, `history.replaceState(null, '', '/explorer/' + username)`, fire a custom event `explorer-sync-state-change`.

5. `decline()`:
   - Write `walk_cloud_backup = { state: 'declined' }`. Done.

6. `deleteAccount()`:
   - `DELETE /:username`. On success: clear `walk_cloud_backup` flag, clear outbox, `history.replaceState(null, '', '/explorer/')`, fire `explorer-sync-state-change`.

**Test Cases:**

```js
// tests/sync.test.js
describe('ExplorerSync.init', () => {
  test('anonymous when no flag and no URL segment', () => {
    setLocation('/explorer/'); setLocalStorage({});
    ExplorerSync.init();
    expect(ExplorerSync.getState().state).toBe('anonymous');
  });

  test('accepted when flag matches URL segment', async () => {
    setLocation('/explorer/rugged-pine-42');
    setLocalStorage({ walk_cloud_backup: JSON.stringify({ state: 'accepted', username: 'rugged-pine-42' }) });
    mockFetch({ '/explorer/api/rugged-pine-42': { visits: [], favorites: [], savedLocations: [], history: [] } });
    await ExplorerSync.init();
    expect(ExplorerSync.getState()).toMatchObject({ state: 'accepted', username: 'rugged-pine-42' });
  });

  test('URL segment with empty localStorage auto-loads', async () => {
    setLocation('/explorer/rugged-pine-42');
    setLocalStorage({});
    mockFetch({ '/explorer/api/rugged-pine-42': { visits: [{ id: '1', /* ... */ }], favorites: [], savedLocations: [], history: [] } });
    await ExplorerSync.init();
    expect(JSON.parse(localStorage.getItem('walk_visits'))).toHaveLength(1);
  });

  test('URL segment with non-empty localStorage prompts confirm', async () => {
    setLocation('/explorer/rugged-pine-42');
    setLocalStorage({ walk_visits: '[{"id":"old"}]' });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await ExplorerSync.init();
    expect(confirmSpy).toHaveBeenCalled();
    expect(location.pathname).toBe('/explorer/');  // cancelled
    expect(JSON.parse(localStorage.getItem('walk_visits'))).toEqual([{id:'old'}]);
  });
});

describe('ExplorerSync.mutate', () => {
  test('no-op when anonymous', () => {
    setupAnonymous();
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    ExplorerSync.mutate('visits', 'put', 'uuid-1', { /* data */ });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('enqueues PUT when accepted', async () => {
    setupAccepted('rugged-pine-42');
    mockFetch({ 'PUT /explorer/api/rugged-pine-42/visits/uuid-1': { status: 204 } });
    ExplorerSync.mutate('visits', 'put', 'uuid-1', { id: 'uuid-1', /* ... */ });
    await flushPromises();
    expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toEqual([]);
  });

  test('outbox survives reload', () => {
    setupAccepted('rugged-pine-42');
    mockFetchOffline();
    ExplorerSync.mutate('visits', 'put', 'uuid-1', { /* data */ });
    expect(JSON.parse(localStorage.getItem('walk_sync_outbox'))).toHaveLength(1);
  });

  test('respects Retry-After on 429', async () => { /* ... */ });

  test('drops entry on 4xx (not 429)', async () => { /* ... */ });
});

describe('ExplorerSync.accept', () => {
  test('generates UUIDs for legacy saved_locations missing id', async () => {
    setLocalStorage({ walk_saved_locations: '[{"label":"home","value":"Home St 1"}]' });
    mockFetch({ 'POST /explorer/api/accounts': { username: 'rugged-pine-42' }, 'POST /explorer/api/rugged-pine-42/import': { status: 204 } });
    await ExplorerSync.accept();
    const stored = JSON.parse(localStorage.getItem('walk_saved_locations'));
    expect(stored[0]).toHaveProperty('id');
    expect(stored[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('rewrites URL on success', async () => { /* ... */ });

  test('does not write flag if import fails', async () => { /* ... */ });
});
```

**Constraints:**
- No external dependencies. Plain JS, fetch, localStorage, history. UUIDs via `crypto.randomUUID()`.
- `init()` returns a Promise resolved when the initial load completes (or immediately for anonymous/declined states with no work to do). `app.js` does not need to `await` it for normal operation, but tests do.
- All state transitions fire `explorer-sync-state-change` custom event so app.js can re-render the overflow menu.

**Verification:**
```bash
cd /home/mase/helm/worktrees/explorer/b3d451b8 && pnpm vitest run tests/sync.test.js
# expect: all tests green
```

**Commit after passing.**

---

## Task 4: Frontend integration — wire sync into app.js mutation paths  [Mode: Delegated]

**Files:**
- Modify: `app.js` (mutation sites for visits, favorites, saved_locations, history; visit-object schema enrichment; UUID switch)
- Modify: `index.html` (script tag for sync.js *before* app.js)

**Contracts:**

The four mutation sites in `app.js` gain an `ExplorerSync.mutate` call after the localStorage write. Each existing function changes minimally:

```js
// markAsVisited (~app.js:1311)
function markAsVisited() {
    if (!currentSession) return;
    // ...existing logic, but:
    const visit = {
        id: crypto.randomUUID(),                              // CHANGED from Date.now()
        date: new Date().toISOString(),
        startLat: currentSession.startLat,
        // ...existing fields
        destName: currentSession.destName || null,            // ADDED
        poiCategory: currentSession.poiCategory || null,      // ADDED
        tripMode: currentSession.tripMode,                    // ADDED
    };
    visits.push(visit);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visits));
    ExplorerSync.mutate('visits', 'put', visit.id, visit);    // ADDED

    // Triggers consent toast on first ever persist
    if (ExplorerSync.getState().state === 'anonymous') {
        ExplorerSync.requestConsent();
    }
    // ...
}

// markAsVisited undo path:
ExplorerSync.mutate('visits', 'delete', currentSession.visitId);  // ADDED before localStorage write

// toggleSaveLocation (~app.js:144) — when adding:
const newLoc = { id: crypto.randomUUID(), label: label || input, value: input };  // ADDED id
saved.push(newLoc);
localStorage.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(saved));
ExplorerSync.mutate('savedLocations', 'put', newLoc.id, newLoc);
// when removing:
const removed = saved[existing];
saved.splice(existing, 1);
localStorage.setItem(...);
ExplorerSync.mutate('savedLocations', 'delete', removed.id);

// deleteSavedLocation (~app.js:170) — same delete pattern with removed.id

// favorites (search for FAVORITES_KEY writes around line 1454, 1473) — same pattern.
//   IMPORTANT: toggleFavorite's remove branch currently does `favs.splice(idx, 1)` and
//   discards the removed item. Capture id first:
//       const removed = favs[idx];
//       favs.splice(idx, 1);
//       localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
//       ExplorerSync.mutate('favorites', 'delete', removed.id);
// history saveToHistory (~app.js:1912) — switch id to crypto.randomUUID(), add ExplorerSync.mutate('history', 'put', entry.id, entry)
// deleteHistoryEntry — need to capture id BEFORE splice, then ExplorerSync.mutate('history', 'delete', id)
```

`currentSession` (the in-flight generation state) gains the new fields:

```js
// wherever currentSession is built (search for "currentSession = " — multiple sites)
currentSession = {
    // ...existing fields
    destName: ...,        // resolved POI name from Overpass, or geocoded address, or "Random point"
    poiCategory: ...,     // selected POI category key (the locationTypeSelect value), or null for road/random destinations
    tripMode: ...,        // 'round' | 'one-way' from radio buttons
};
```

**Test Cases:**

End-to-end smoke via laxi (manual run; not vitest). Document in the task notes:

```bash
# Acceptance scenarios for laxi:
# 1. Cold start, mark a visit:
#    - Open localhost:8080/explorer/
#    - Generate route, click "Mark as visited"
#    - Assert: toast appears with Accept/Decline
#    - Click Accept
#    - Assert: URL becomes /explorer/<username>
#    - Reload page, assert visit still there from server (clear localStorage first)
#
# 2. Decline path:
#    - Same as above but click Decline
#    - Mark another visit; assert no toast, no API calls (network panel)
#    - Assert localStorage walk_cloud_backup === {state:'declined'}
#
# 3. Multi-device:
#    - Profile A accepts, marks visit X
#    - Open same URL in Profile B with empty localStorage; assert X loads
#    - Profile B marks visit Y; reload Profile A; assert Y appears
```

Unit-level tests where feasible (covered by Task 3's sync tests; this task is integration glue).

**Constraints:**
- All localStorage write sites for the four backed-up keys must call `ExplorerSync.mutate`. Grep `localStorage.setItem(STORAGE_KEY|FAVORITES_KEY|HISTORY_KEY|SAVED_LOCATIONS_KEY` to enumerate them; current count from spec exploration: ~10 sites. Missing one = silent data divergence.
- `currentSession.poiCategory` source: read from `document.getElementById('locationTypeSelect').value` at session-build time, not at mark-visit time (the select can be changed between generation and marking).
- `currentSession.destName` source: when destination is a POI, use the POI's `name` tag from Overpass; for road points, set `null`; for random points, set `null`. Geocoded reverse-lookup is *not* required.
- Existing visit/favorite/saved-location/history records keep numeric `Date.now()` IDs. Schema accepts both formats. Do not migrate.
- Loading order in index.html: `sync.js` before `app.js`. `app.js` calls `ExplorerSync.init()` exactly once near current init sites (`renderVisitedLayer()` neighborhood at app.js:2050).

**Verification:**
```bash
# Check no localStorage write site for the four keys is missing the sync call:
grep -nE "localStorage\.setItem\((STORAGE_KEY|FAVORITES_KEY|HISTORY_KEY|SAVED_LOCATIONS_KEY)" /home/mase/helm/worktrees/explorer/b3d451b8/app.js
# For each match, verify a nearby ExplorerSync.mutate exists.

# Manual smoke per scenarios above. Type-check fine since this is plain JS.
```

**Commit after passing.**

---

## Task 5: Frontend UI — toast, overflow-menu items, status line  [Mode: Delegated]

**Files:**
- Modify: `index.html` (overflow menu items: status line, Enable cloud backup, Delete cloud data)
- Modify: `style.css` (toast variant with two buttons; status-line styling)
- Modify: `app.js` (or extract a small `sync-ui.js`) — toast renderer, overflow-menu state syncing via `explorer-sync-state-change` event

**Contracts:**

`index.html` overflow menu (currently app.js:24-30) gains three slots, conditionally visible. Built statically in markup (no innerHTML assembly):

```html
<div class="overflow-menu" id="overflowMenu">
    <div class="overflow-status" id="syncStatus" style="display:none">
        <span>Account:</span> <span id="syncUsername"></span>
    </div>
    <button type="button" id="enableCloudBackupBtn" onclick="ExplorerSync.requestConsent()" style="display:none">
        Enable cloud backup
    </button>
    <button type="button" id="deleteCloudDataBtn" onclick="confirmDeleteCloudData()" style="display:none">
        Delete cloud data
    </button>
    <!-- existing buttons unchanged -->
</div>
```

The username is rendered via `textContent` (not innerHTML) when state changes:

```js
document.getElementById('syncUsername').textContent = state.username;
```

State → visibility mapping:

| state | syncStatus | enableCloudBackupBtn | deleteCloudDataBtn |
|---|---|---|---|
| anonymous | hidden | visible | hidden |
| declined | hidden | visible | hidden |
| accepted | visible (shows username) | hidden | visible |

Listener: `window.addEventListener('explorer-sync-state-change', updateSyncMenu)` — recomputes the three styles.

**Toast component** (in `style.css` + small JS renderer):

Two new classes: `.toast-consent` (multi-line, two buttons), `.toast-info` (existing single-line variant). The renderer accepts:

```js
function showConsentToast(): Promise<'accepted'|'declined'>;
// Renders a toast at bottom-center (per existing toast pattern), with copy:
//   "Wander can save your visits, saved locations, and favorites
//    to a database on mase.fi so they survive clearing your browser."
//   [Accept]  [Decline]
// Returns user's choice. Auto-dismiss after 30s = treated as Decline.
//
// IMPLEMENTATION NOTE: build the toast via document.createElement + textContent
// for the message and button labels — never assign innerHTML from variables.
```

`confirmDeleteCloudData()` (in app.js):
```js
async function confirmDeleteCloudData() {
    if (!confirm('Delete your cloud data permanently? Your local data will be kept.')) return;
    await ExplorerSync.deleteAccount();
    showSuccess('Cloud data deleted.');
}
```

**Test Cases:**

Manual via laxi:

```bash
# 1. Overflow menu state syncing:
#    - Cold start (anonymous): open menu, expect "Enable cloud backup" visible, no status, no delete
#    - Accept consent: expect status "Account: rugged-pine-42" visible, delete visible, enable hidden
#    - Click Delete cloud data: confirm; expect status hidden, enable visible
#
# 2. Toast presentation:
#    - First mark-as-visited: toast appears, focusable, both buttons clickable
#    - Decline: toast disappears, never shows again on subsequent marks
#
# 3. Re-opt-in path:
#    - Decline once
#    - Click "Enable cloud backup" in overflow menu
#    - Same toast appears; Accept this time → URL rewrites
```

If a vitest jsdom setup exists from Task 3, also:

```js
test('updateSyncMenu toggles visibility based on state', () => {
  // Render the menu via DOM APIs (no innerHTML), then dispatch state change.
  buildMenuFixture();  // appendChild-based helper, defined in test setup
  ExplorerSync._setState({ state: 'accepted', username: 'rugged-pine-42' });
  window.dispatchEvent(new CustomEvent('explorer-sync-state-change'));
  expect(document.getElementById('syncStatus').style.display).not.toBe('none');
  expect(document.getElementById('enableCloudBackupBtn').style.display).toBe('none');
  expect(document.getElementById('deleteCloudDataBtn').style.display).not.toBe('none');
});
```

**Constraints:**
- Use existing toast styling as a base (search style.css for existing toast/notification rules).
- Status line renders username in a code-style span (monospaced) for readability.
- "Enable cloud backup" and "Delete cloud data" must remain in the overflow menu, not the main panel — Mase explicitly placed them there.
- Toast `[Accept]` button has primary styling, `[Decline]` is secondary. Match existing button conventions.
- **No innerHTML assignment from runtime data.** Build dynamic content with `document.createElement` + `textContent` / `appendChild` (matches the existing `escapeHtml` discipline in app.js). Username strings come from the server; treating them as HTML risks XSS even though server validates the format.

**Verification:**
- Manual scenarios above pass.
- `pnpm vitest run` (if applicable) green.

**Commit after passing.**

---

## Task 6: Deploy — nginx config + systemd unit  [Mode: Direct]

**Files:**
- Modify: existing nginx config for `mase.fi` (likely on the VPS, not in this repo — confirm location at execution time; could also be a `deploy/nginx-explorer.conf` snippet)
- Create: `deploy/explorer-api.service` (systemd unit) — or directly install on VPS
- Modify: `deploy/` README or scripts/post-deploy.sh if applicable

**Contracts:**

nginx changes inside the existing `mase.fi` server block:

```nginx
# /explorer/api/* → backend service
location /explorer/api/ {
    proxy_pass http://127.0.0.1:PORT/explorer/api/;   # PORT to be assigned, likely 9760+ range
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# /explorer/<username> → serve index.html (SPA fallback)
location /explorer/ {
    alias /var/www/explorer/;
    try_files $uri $uri/ /explorer/index.html;
}
```

`deploy/explorer-api.service`:

```ini
[Unit]
Description=Explorer API (Wander cloud backup)
After=network.target postgresql.service

[Service]
Type=simple
User=mase
WorkingDirectory=/home/mase/Projects/explorer/server
EnvironmentFile=/home/mase/Projects/explorer/server/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

(Adjust `User`, paths, and `Restart` policy to match other services on the VPS — check an existing systemd unit before finalizing.)

**Test Cases:**

```bash
# nginx:
sudo nginx -t                           # config valid
curl -fsS https://mase.fi/explorer/    # serves index.html
curl -fsS https://mase.fi/explorer/no-such-username   # also serves index.html (SPA fallback)
curl -fsS https://mase.fi/explorer/api/accounts -X POST   # 201 with {username}

# systemd:
sudo systemctl status explorer-api      # active (running)
sudo journalctl -u explorer-api -n 50   # no crash loop
```

**Constraints:**
- Use existing port allocation pattern (check `helm project list` ports).
- DATABASE_URL points at existing shared Postgres with explorer schema permissions.
- Service must restart on file changes via existing `deploy` workflow (see CLAUDE.md). Confirm the post-deploy hook (`scripts/post-deploy.sh`) builds + restarts.

**Verification:**
```bash
deploy
curl -fsS -X POST https://mase.fi/explorer/api/accounts | jq .
# expect {"username": "..."}
```

**Commit after passing.**

---

## Sequencing

Tasks should run roughly in order, but **Tasks 1–2 (backend) and Tasks 3–5 (frontend)** are independent and can run in parallel — backend correctness is validated by its own tests; frontend correctness is validated against the documented contract in this plan.

- Task 1 → blocks Task 2 (schema before endpoints)
- Task 2 → blocks Task 6 (need a working backend to test deploy against, though scaffold can deploy first)
- Task 3 → blocks Task 4 (sync API before integration)
- Task 4 → blocks Task 5 (mutation paths before UI status)
- Task 6 last (touches infra; depends on backend bundling cleanly)

---

## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A tasks (1, 6): Opus implements directly
- Mode B tasks (2, 3, 4, 5): Dispatched to subagents
