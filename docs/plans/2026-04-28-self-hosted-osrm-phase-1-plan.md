# Phase 1 — Self-Hosted OSRM-Foot for Finland — Implementation Plan

**Goal:** Stand up a Finland-only OSRM-foot instance on shelly, expose it via VPS nginx at `mase.fi/api/osrm-fi/`, and rewire the frontend to use it for in-Finland generates with transparent fallback to the public service.

**Architecture:** Three layers. (1) Shelly hosts the OSRM-foot service plus a weekly refresh timer that pulls fresh Finland OSM data from Geofabrik, preprocesses with the MLD pipeline, and atomically swaps via a symlink. (2) VPS nginx adds a `/api/osrm-fi/` location that proxies to shelly over Tailscale, matching the existing poe-trade/poe-crafting pattern. (3) Frontend gets a Finland bbox helper, a new endpoint constant, and a per-call try-self-hosted-then-public wrapper inside `fetchRouteThrough` and `snapToRoad`. **No retry/overlap/chirality work in this phase** — that's Phase 2. This phase is "the new endpoint exists and serves Finnish traffic; nothing else changes."

**Tech Stack:** OSRM-backend (MLD pipeline, foot profile), systemd (service + oneshot + timer), nginx, vanilla JS in `app.js`, vitest+jsdom for tests.

**Spec reference:** `docs/plans/2026-04-28-self-hosted-osrm-and-overlap-filter-design.md` (sections 3, 4.4, 4.5).

---

## File Structure

```
explorer repo:
  deploy/shelly-osrm/install.sh           ← one-time bootstrap (run via ssh shelly)
  deploy/shelly-osrm/osrm-foot.service    ← systemd unit (reference; copied by install.sh)
  deploy/shelly-osrm/osrm-refresh.sh      ← weekly refresh logic
  deploy/shelly-osrm/osrm-refresh.service ← refresh oneshot (reference)
  deploy/shelly-osrm/osrm-refresh.timer   ← weekly trigger (reference)
  deploy/nginx-osrm-fi.conf               ← nginx snippet to add to default
  app.js                                  ← modify: OSRM_FI_BASE, inFinland, bbox gate, fallback
  tests/in-finland.test.js                ← new

shelly (managed by install.sh, not in repo):
  /srv/osrm/finland/pbf/                  ← downloaded extracts
  /srv/osrm/finland/processed/<UTC>/      ← timestamped processed sets
  /srv/osrm/finland/processed/current     ← symlink to active set
  /etc/systemd/system/osrm-foot.service
  /etc/systemd/system/osrm-refresh.service
  /etc/systemd/system/osrm-refresh.timer
  /usr/local/bin/osrm-refresh             ← installed copy of osrm-refresh.sh

VPS:
  /etc/nginx/sites-enabled/default        ← +location /api/osrm-fi/
```

---

## Task 1: Shelly OSRM stack — service unit and bootstrap

**Files:**
- Create: `deploy/shelly-osrm/install.sh`
- Create: `deploy/shelly-osrm/osrm-foot.service`

**Contracts:**

`install.sh` — POSIX bash, `set -euo pipefail`, idempotent. Run via `ssh shelly 'bash -s' < deploy/shelly-osrm/install.sh`. Responsibilities:

1. Install `osrm-backend` (Arch AUR or pacman package; install.sh checks `command -v osrm-extract` first and skips if present). Also installs `wget` and `curl` if missing.
2. Create dedicated system user `osrm` (`useradd --system --no-create-home --shell /usr/sbin/nologin osrm`) — skip if exists.
3. Create directory tree under `/srv/osrm/finland/{pbf,processed}` owned by `osrm:osrm`.
4. Download `finland-latest.osm.pbf` from `https://download.geofabrik.de/europe/finland-latest.osm.pbf` into `/srv/osrm/finland/pbf/`.
5. Run preprocessing into a fresh timestamped dir under `/srv/osrm/finland/processed/<UTC>/`:
   - `osrm-extract -p /usr/share/osrm/profiles/foot.lua finland-latest.osm.pbf`
   - `osrm-partition finland-latest.osrm`
   - `osrm-customize finland-latest.osrm`
6. Symlink swap: `ln -sfn <UTC>/finland-latest.osrm /srv/osrm/finland/processed/current`.
7. Install systemd units: `cp osrm-foot.service /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl enable --now osrm-foot.service`.

`osrm-foot.service` — systemd unit:
- `User=osrm`, `Group=osrm`
- `ExecStart=/usr/bin/osrm-routed --algorithm mld --ip 100.69.160.113 --port 5000 /srv/osrm/finland/processed/current`
- `Restart=always`, `RestartSec=10`
- `After=network-online.target`, `Wants=network-online.target` (Tailscale IP needs network up)
- `WantedBy=multi-user.target`

> **Implementer note:** verify the listen-IP flag name against the installed osrm-backend version before committing. Recent OSRM releases use `--ip` (alias `-i`); some older builds and forks use `--host`. Run `osrm-routed --help | grep -E '\-\-(ip|host)'` once on shelly and use the actual flag.

**Constraints:**
- Service binds to Tailscale IP `100.69.160.113`, NOT `0.0.0.0`. UFW unchanged.
- Idempotency: rerunning `install.sh` after a successful first run must be a no-op (skip user creation if exists, skip pacman if package present, skip preprocessing if `current` symlink already valid — controlled by an `--update-data` flag if you want to force).
- The `current` symlink is the ONLY thing the service reads from; refresh task will rewrite this symlink atomically.

**Test Cases:**

Manual verification (no automated test for shelly-side infra — it's environment-coupled):

```bash
# 1. From VPS, after install.sh completes:
curl -sS http://100.69.160.113:5000/route/v1/foot/24.9384,60.1699\;24.9405,60.1717\?overview=full | jq '.code'
# Expected: "Ok"

# 2. Service status:
ssh shelly 'systemctl is-active osrm-foot.service'
# Expected: active

# 3. Bind verification — should ONLY listen on Tailscale IP, not 0.0.0.0:
ssh shelly 'ss -tlnp | grep 5000'
# Expected: 100.69.160.113:5000 (no 0.0.0.0:5000 line)

# 4. Idempotency: rerun install.sh
ssh shelly 'bash -s' < deploy/shelly-osrm/install.sh
# Expected: exits 0, no errors, no duplicate user/dirs/units
```

**Verification:** Manual checks pass.

**[Mode: Direct]**

**Commit after passing.**

---

## Task 2: Shelly refresh timer — weekly OSM data update

**Files:**
- Create: `deploy/shelly-osrm/osrm-refresh.sh`
- Create: `deploy/shelly-osrm/osrm-refresh.service`
- Create: `deploy/shelly-osrm/osrm-refresh.timer`
- Modify: `deploy/shelly-osrm/install.sh` (also install the refresh trio, enable timer)

**Contracts:**

`osrm-refresh.sh` — POSIX bash, `set -euo pipefail`. Runs as the `osrm` user. Steps:

1. Download fresh `finland-latest.osm.pbf` into `/srv/osrm/finland/pbf/staging.osm.pbf` (separate filename; only renamed on successful preprocessing).
2. Create new timestamped dir: `STAGING=/srv/osrm/finland/processed/$(date -u +%Y%m%dT%H%M%SZ)`.
3. Inside `$STAGING`, run extract → partition → customize against the staging pbf. If any step fails, `rm -rf $STAGING`, `rm staging.osm.pbf`, exit non-zero (logged to journal).
4. On success: `mv staging.osm.pbf finland-latest.osm.pbf`, `ln -sfn $STAGING_BASENAME current` in the processed dir, `systemctl restart osrm-foot.service` via sudoers entry (or run as root via the service unit).
5. GC: list timestamped dirs sorted by name, keep newest 2, `rm -rf` the rest.

`osrm-refresh.service` — Type=oneshot, `User=root`, `ExecStart=/usr/local/bin/osrm-refresh`. **Decision: run the entire script as root, no sudoers entry.** The script uses `runuser -u osrm -- <cmd>` to drop privileges for the data-work commands (download, extract, partition, customize, symlink swap, GC). The final `systemctl restart osrm-foot.service` runs as root directly. This avoids creating a sudoers rule and keeps all privilege transitions in one file.

`osrm-refresh.timer` — `OnCalendar=Sun 03:00:00`, `Persistent=true` (so a missed run on reboot still happens), `Unit=osrm-refresh.service`.

**Constraints:**
- Atomicity: the active service keeps running on whatever `current` points to. The symlink swap is the cutover point. If preprocessing fails partway, service is undisturbed.
- Disk discipline: GC keeps exactly 2 most recent timestamped dirs (the active one + the previous, in case of rollback). With ~5 GB per set, that's ~10 GB max under `/srv/osrm/finland/processed/`.
- Log to journal: every step echoed; failure is captured by systemd journal automatically.

**Test Cases:**

Manual:

```bash
# 1. Trigger refresh manually:
ssh shelly 'sudo systemctl start osrm-refresh.service'

# 2. Watch journal:
ssh shelly 'journalctl -u osrm-refresh.service -f'
# Expected: "Downloading...", "Extracting...", "Partitioning...", "Customizing...", "Restarting osrm-foot...", "Done."

# 3. Verify symlink updated:
ssh shelly 'ls -la /srv/osrm/finland/processed/current'
# Expected: symlink to a freshly timestamped dir

# 4. Verify service still serves routes after restart:
curl -sS http://100.69.160.113:5000/route/v1/foot/24.9384,60.1699\;24.9405,60.1717 | jq '.code'
# Expected: "Ok"

# 5. Verify timer scheduled:
ssh shelly 'systemctl list-timers osrm-refresh.timer'
# Expected: shows next run within ~7 days

# 6. Failure simulation — corrupt the pbf URL temporarily:
# (manual; skip if confident)
```

**Verification:** Manual checks pass.

**[Mode: Direct]**

**Commit after passing.**

---

## Task 3: VPS nginx exposure

**Files:**
- Create: `deploy/nginx-osrm-fi.conf` (snippet, for documentation + reapplying after nginx wipes)
- Modify: `/etc/nginx/sites-enabled/default` (live config)

**Contracts:**

Add a new location block alongside the existing `/api/poe/...` blocks:

```nginx
location /api/osrm-fi/ {
    proxy_pass http://100.69.160.113:5000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    add_header Access-Control-Allow-Origin * always;
    add_header Access-Control-Allow-Methods "GET, OPTIONS" always;

    if ($request_method = OPTIONS) {
        add_header Access-Control-Max-Age 3600 always;
        return 204;
    }
}
```

`deploy/nginx-osrm-fi.conf` is a checked-in copy of this snippet for reference (matches `deploy/nginx-explorer.conf` pattern).

**Constraints:**
- Trailing slashes matter: location ends in `/`, proxy_pass ends in `/` — strips the `/api/osrm-fi` prefix before forwarding. So `mase.fi/api/osrm-fi/route/v1/foot/...` → `100.69.160.113:5000/route/v1/foot/...`.
- CORS: explicit `Access-Control-Allow-Origin: *` because OSRM doesn't set CORS headers itself. `OPTIONS` preflight handled at nginx, doesn't reach OSRM.
- Reload, don't restart: `sudo nginx -t && sudo systemctl reload nginx`.

**Test Cases:**

```bash
# 1. From outside:
curl -sS 'https://mase.fi/api/osrm-fi/route/v1/foot/24.9384,60.1699;24.9405,60.1717?overview=full' | jq '.code'
# Expected: "Ok"

# 2. CORS preflight:
curl -sS -X OPTIONS -H "Origin: https://mase.fi" -H "Access-Control-Request-Method: GET" \
    'https://mase.fi/api/osrm-fi/route/v1/foot/0,0;0,0' -i | head -20
# Expected: 204 with Access-Control-Allow-Origin: * header

# 3. CORS actual request:
curl -sS -H "Origin: https://mase.fi" 'https://mase.fi/api/osrm-fi/route/v1/foot/24.9384,60.1699;24.9405,60.1717' -i | grep -i 'access-control'
# Expected: Access-Control-Allow-Origin: *
```

**Verification:** All three curls pass.

**[Mode: Direct]**

**Commit after passing.**

---

## Task 4: Frontend rewire — bbox gate + transparent fallback

**Files:**
- Create: `bbox.js` (new tiny script — pure helpers, testable in isolation)
- Modify: `index.html` (add `<script src="bbox.js"></script>` before `app.js`)
- Modify: `app.js` (around the OSRM block at app.js:466)
- Create: `tests/in-finland.test.js`

**Why a separate `bbox.js`:** `app.js` references the Leaflet global `L` and DOM elements at parse time (lines 32+, 1727+), so it cannot be fully evaluated in jsdom without heavy stubbing. The bbox helpers are pure and DOM-free; extracting them to a separate file keeps them cleanly testable. Cost is one extra `<script>` tag and one extra HTTP request (negligible — file is ~15 lines).

**Contracts:**

`bbox.js` — non-module browser script. Sets `window.inFinland`, `window.allInFinland`, `window.FINLAND_BBOX`. No DOM access, no other globals required. Loaded via `<script src="bbox.js">` before `app.js` in `index.html`.

```js
// Finland bbox helpers for routing endpoint selection.
// Loaded before app.js; helpers are referenced as bare names from app.js.

const FINLAND_BBOX = { minLng: 19.0, maxLng: 32.0, minLat: 59.0, maxLat: 71.0 };

// Loose bbox covering Finnish territory + Åland. Generous on edges so border
// routes (Tornio, Utsjoki) stay on self-hosted; OSM data coverage is the
// real filter — out-of-data queries fall back automatically.
function inFinland(lat, lng) {
    return lat >= FINLAND_BBOX.minLat && lat <= FINLAND_BBOX.maxLat
        && lng >= FINLAND_BBOX.minLng && lng <= FINLAND_BBOX.maxLng;
}

function allInFinland(waypoints) {
    return waypoints.every(p => inFinland(p.lat, p.lng));
}
```

Add to `app.js`:

```js
// Self-hosted OSRM-foot for Finland. Outside Finland, fall back to public.
const OSRM_FI_BASE     = 'https://mase.fi/api/osrm-fi/route/v1/foot';
const OSRM_FI_NEAREST  = 'https://mase.fi/api/osrm-fi/nearest/v1/foot';
const OSRM_PUBLIC_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving';
const OSRM_PUBLIC_NEAREST = 'https://routing.openstreetmap.de/routed-foot/nearest/v1/driving';
```

(Note: `inFinland` and `allInFinland` come from `bbox.js`, loaded before `app.js`.)

Modify `fetchRouteThrough(waypoints)`:

```js
async function fetchRouteThrough(waypoints) {
    const coordStr = waypoints.map(p => `${p.lng},${p.lat}`).join(';');
    const query = `${coordStr}?overview=full&geometries=geojson&steps=true&continue_straight=true`;
    const useSelfHosted = allInFinland(waypoints);

    // Try self-hosted first (no throttle) when in Finland
    if (useSelfHosted) {
        const result = await tryOsrm(`${OSRM_FI_BASE}/${query}`);
        if (result) return result;
        // fall through to public on failure
    }

    // Public path — throttle, no fallback (already the last resort)
    await sleep(requestDelay);
    return tryOsrm(`${OSRM_PUBLIC_BASE}/${query}`);
}

// Internal: fetch + parse OSRM response. Returns null on any failure.
async function tryOsrm(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.routes || data.routes.length === 0) return null;
        const r = data.routes[0];
        const steps = r.legs ? r.legs.flatMap(leg => leg.steps || []) : null;
        return {
            coords: r.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
            duration: r.duration,
            distance: r.distance,
            steps
        };
    } catch { return null; }
}
```

Replace `snapToRoad(via, maxKm)`:

```js
async function snapToRoad(via, maxKm = 0.5) {
    const useSelfHosted = inFinland(via.lat, via.lng);

    if (useSelfHosted) {
        const snapped = await tryNearest(`${OSRM_FI_NEAREST}/${via.lng},${via.lat}?number=1`);
        if (snapped) {
            const dist = calculateDistance(via.lat, via.lng, snapped.lat, snapped.lng);
            if (dist <= maxKm) return snapped;
            return via; // self-hosted snap was too far, accept original
        }
        // self-hosted failed (network/5xx), fall through to public
    }

    await sleep(requestDelay);
    const snapped = await tryNearest(`${OSRM_PUBLIC_NEAREST}/${via.lng},${via.lat}?number=1`);
    if (!snapped) return via;
    const dist = calculateDistance(via.lat, via.lng, snapped.lat, snapped.lng);
    return dist <= maxKm ? snapped : via;
}

// Internal: OSRM /nearest call. Returns {lat, lng} or null on any failure.
async function tryNearest(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data.waypoints || !data.waypoints.length) return null;
        return { lat: data.waypoints[0].location[1], lng: data.waypoints[0].location[0] };
    } catch { return null; }
}
```

Notes:
- The current `nearestBase = OSRM_BASE.replace('/route/', '/nearest/')` string-replace trick (app.js:521) is removed. Both endpoints are explicit constants now (`OSRM_FI_NEAREST`, `OSRM_PUBLIC_NEAREST`) — no implicit derivation that could silently break on future renames.
- `maxKm` semantics preserved: snap is accepted only if within `maxKm`, else original via is returned.
- Self-hosted "snapped too far" case (rare) does NOT fall through to public — that would make the public path the dominant one for marginal snaps. Accept the original via as today's behavior does on borderline cases.

**Test Cases (`tests/in-finland.test.js`):**

Load `bbox.js` (NOT `app.js`) using the same browser-script-loading pattern as `tests/sync.test.js`. `bbox.js` is small and has no DOM/Leaflet dependencies, so it parses cleanly in jsdom. Test cases:

```js
import { describe, test, expect } from 'vitest';
// (loading boilerplate per tests/sync.test.js)

describe('inFinland bbox helper', () => {
    test('Helsinki is inside', () => {
        expect(inFinland(60.1699, 24.9384)).toBe(true);
    });

    test('Mariehamn (Åland) is inside', () => {
        expect(inFinland(60.0971, 19.9348)).toBe(true);
    });

    test('Utsjoki (north) is inside', () => {
        expect(inFinland(69.9089, 27.0287)).toBe(true);
    });

    test('Tornio (FI/SE border) is inside', () => {
        expect(inFinland(65.8482, 24.1465)).toBe(true);
    });

    test('Stockholm is outside (lng < 19)', () => {
        expect(inFinland(59.3293, 18.0686)).toBe(false);
    });

    test('Oslo is outside', () => {
        expect(inFinland(59.9139, 10.7522)).toBe(false);
    });

    test('exact minLat boundary (59.0) is inside', () => {
        expect(inFinland(59.0, 24.0)).toBe(true);
    });

    test('just below minLat is outside', () => {
        expect(inFinland(58.999, 24.0)).toBe(false);
    });

    test('just past maxLng is outside', () => {
        expect(inFinland(60.0, 32.001)).toBe(false);
    });
});

describe('allInFinland', () => {
    test('all waypoints in Finland → true', () => {
        expect(allInFinland([
            {lat: 60.17, lng: 24.94},
            {lat: 60.20, lng: 24.99},
        ])).toBe(true);
    });

    test('one waypoint outside → false', () => {
        expect(allInFinland([
            {lat: 60.17, lng: 24.94},
            {lat: 59.33, lng: 18.07},
        ])).toBe(false);
    });

    test('empty array → true (vacuous)', () => {
        expect(allInFinland([])).toBe(true);
    });
});
```

**Note on Tallinn-area edge case:** the loose bbox catches Tallinn (lat 59.44, inside [59, 71]; lng 24.75, inside [19, 32]). Recommendation: keep the loose bbox; the fallback path handles it correctly when the self-hosted OSRM (which has no Estonian data) returns no-route. A tighter bbox would also exclude legitimate south-coast Finnish queries near the Estonia ferry routes.

**Constraints:**
- `OSRM_BASE` constant is removed; replaced by the four explicit constants (`OSRM_FI_BASE`, `OSRM_FI_NEAREST`, `OSRM_PUBLIC_BASE`, `OSRM_PUBLIC_NEAREST`). Grep `app.js` for any remaining `OSRM_BASE` reference and remove — only `fetchRouteThrough` and `snapToRoad` should use these constants.
- The closure-scoped degradation flag from spec section 4.5 is **not** in this phase — it's a Phase 2 retry-sequence concern. Phase 1 lets each call decide independently.
- `requestDelay` throttle is bypassed for self-hosted calls (the whole point of self-hosting). Public-fallback calls keep the existing throttle.
- `bbox.js` must be loaded by `index.html` BEFORE `app.js` — otherwise `inFinland` is undefined when `app.js` parses. Verify the script tag order after the index.html edit.

**Verification:**

```bash
pnpm vitest run tests/in-finland.test.js
# Expected: all tests pass

# Manual browser verification:
# 1. Load https://mase.fi/explorer (after deploy)
# 2. Generate a route in Helsinki — DevTools Network tab shows /api/osrm-fi/... calls
# 3. Generate a route from a non-Finnish coordinate (manually edit input or use the
#    pick-on-map mode set somewhere outside the bbox) — Network tab shows
#    routing.openstreetmap.de calls
# 4. Stop osrm-foot on shelly: ssh shelly 'sudo systemctl stop osrm-foot'
#    Generate a route in Helsinki — Network tab shows initial /api/osrm-fi/ 502, then
#    falls back to routing.openstreetmap.de. Route still rendered.
#    Restart: ssh shelly 'sudo systemctl start osrm-foot'
```

**[Mode: Direct]**

**Commit after passing.**

---

## Out of Scope (deferred to Phase 2)

- Both-chirality routing in `buildLoop` / `buildJunctionLoop`
- `loopOverlapFraction` utility
- N-candidate retry in `generateDestination`
- Soft warning chip for exhausted retries
- Closure-scoped self-hosted degradation flag

These all assume Phase 1 is in production and validated.

---

## Execution
**Skill:** Subagent Dev (if included in your instructions)
- Mode A tasks: Opus implements directly
- Mode B tasks: Dispatched to subagents

All four tasks are Mode A — config files, systemd boilerplate, well-defined frontend changes. No creative coding decisions left to make beyond what the contracts already specify. The shelly-side install.sh is the most complex piece, but it's straightforward sequential bash; no architectural choices remain.
