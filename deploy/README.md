# Deploy

Canonical nginx snippets, systemd units, and the shelly OSRM-foot tree for Wander.

`deploy` pushes to Forgejo, which triggers `forgejo-deploy` to: check out into `~/Projects/explorer`, run `pnpm install --frozen-lockfile && pnpm build` in `server/` (the only VPS `pnpm install`), apply migrations, and rsync top-level `*.html`/`*.js`/`*.css` (skipping `vitest.*`) to `/var/www/html/explorer` with `--delete` so leftover non-assets (CLAUDE.md, `docs/`, `tools/`) cannot stay public from an older full-tree copy (finding #7758), replacing `__COMMIT__` with the short SHA. The local `deploy` script then restarts `explorer-api.service`. Root and `tools/` are never installed on deploy. Junctions-cache deploys separately via the `shelly` git remote — see `junctions-cache/README.md`.

## Config files in this directory

- `nginx-explorer.conf` — `/explorer` SPA (`try_files` so `/explorer/<username>` serves `index.html`) plus `/explorer/api/` proxy to port 3700. Location snippet for `sites-enabled/default`. Its `Referrer-Policy` must keep sending an origin (`strict-origin`): OSM's tile servers answer a Referer-less request from a Firefox-family browser with a "403r Access blocked" tile at HTTP 200, so `no-referrer` turned the map into grey warning squares with nothing in the console. Chrome is waved through on its client hints, so this only reproduces on Firefox/Fennec. `map-view.js` also pins `referrerPolicy` on the OSM layer itself, which survives live-vhost drift; `tests/nginx-security.test.js` pins the snippet.
- `nginx-osrm-fi.conf` — `/api/osrm-fi/` proxy to shelly's Finland OSRM-foot over Tailscale. Same-origin from `/explorer`; no CORS.
- `nginx-junctions.conf` — `/api/junctions/` location in `sites-enabled/default`.
- `nginx-junctions-log-format.conf` — http-context `log_format` in `/etc/nginx/conf.d/` (not a server-block snippet). Path-only access log so a leftover GET query cannot persist coords.
- `explorer-api.service` — VPS unit for the cloud-backup API.
- `wander-junctions.service` — shelly unit for junctions-cache (dedicated `wander-junctions` user, cache under `/var/lib/wander-junctions`).
- `install-wander-junctions.sh` — idempotent shelly installer for that unit + user (finding #7755 / #7754).
- `check-unit-drift.sh` — diffs every committed unit against the copy installed on its `# deploy-host:`. Run by `scripts/post-deploy.sh`; pinned by `tests/unit-drift.test.js`.
- `shelly-osrm/` — self-hosted OSRM-foot service, refresh timer, and install script for the shelly box.
- `shelly-overpass/` — self-hosted Overpass API (pinned `wiktorn/overpass-api` container over the Geofabrik Finland extract) on shelly's `127.0.0.1:5002`, the upstream `wander-junctions` queries before falling back to public Overpass. Unit + installer + its own README. Loopback-only: junctions-cache runs natively on that host and is the sole consumer.

## Unit install

**A unit change is not deployed until you install it, and `check-unit-drift.sh` is what tells you.** `wander-junctions.service` ran on shelly for months as the old pre-#7755 unit — no dedicated user, cache still under `/home/shelly` — while `junctions-cache/tests/wander-junctions-service.test.ts` asserted the hardened shape and passed every run. Both were true: the test reads the *repo* copy, and `deploy` restarts a unit but never installs it. A test that reads a repo file proves the intent, never the deployment (idea #4018).

So `scripts/post-deploy.sh` runs `check-unit-drift.sh` on every deploy: it diffs each `*.service`/`*.timer` under `deploy/` against `/etc/systemd/system/` on the host that unit's own `# deploy-host:` header names (`local` = VPS, otherwise an ssh destination). A unit added later joins the check automatically; one with no header **fails** rather than being skipped, since opt-in would reproduce the same silence. DRIFT and MISSING fail the hook; an unreachable host only warns, because ssh being down is not evidence about drift. It reports — installing stays deliberate, since a unit change usually wants its installer (users, state migration).

`deploy` restarts `explorer-api` but does not install the unit — after editing `explorer-api.service`, `sudo cp` it to `/etc/systemd/system/` and `daemon-reload`. The `explorer` system user (`nologin`, no home) is required; `ProtectHome` must stay `tmpfs` (not `yes`) so `BindReadOnlyPaths` of the server tree remains reachable. Isolation is pinned by `server/tests/explorer-api-service.test.ts`.

`wander-junctions.service` is the same shape on shelly: `deploy` / the post-receive hook restarts the unit but does not install it. After editing the unit, run `deploy/install-wander-junctions.sh` on shelly (creates the nologin user, migrates the cache out of `/home/shelly`, `daemon-reload`s). Isolation and `TRUSTED_PROXIES=100.117.202.73` (so nginx `X-Real-IP` / last XFF hop is the per-IP key) are pinned by `junctions-cache/tests/wander-junctions-service.test.ts`. It also sets `OVERPASS_URL`/`OVERPASS_FALLBACK_URL`; both match the code defaults and are stated so the unit says where the service sends traffic.

`wander-overpass.service` installs with `scp -r deploy/shelly-overpass shelly:/tmp/ && ssh shelly 'bash /tmp/shelly-overpass/install.sh'` — copied rather than piped through `bash -s`, because the script reads the unit file from beside itself and stdin leaves `BASH_SOURCE` unset. It returns as soon as the unit is up; the initial import runs for tens of minutes inside the container and junctions-cache's fallback covers that window.
