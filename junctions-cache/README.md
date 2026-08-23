# wander-junctions

Server-side cache for OSM road-junction lookups, fronting the public Overpass API. Used by the Wander frontend's smart-routing path.

## Run

```bash
pnpm install
pnpm dev                    # tsx watch src/index.ts
pnpm build && pnpm start    # production (`node dist/index.js`)
```

Layout mirrors the cloud-backup server: `src/app.ts` exports `createApp()` (routes only), `src/index.ts` owns `await loadCache()` + `serve()`, `src/lib/parse-request.ts` validates `/junctions` query/JSON-body params. `src/server.ts` is a one-line import of `index.ts` so a systemd unit still `ExecStart=`ing `dist/server.js` keeps working.

Listens on `127.0.0.1:5001` (override with `PORT`/`HOST`). Persists cache to `./data/cache.json` (override with `CACHE_PATH`).

The store is bounded so neither memory nor the JSON snapshot grows without limit: entries expire after `CACHE_TTL_MS` (default 30 days — a stale entry is refetched on the next read, not served forever), the entry count is capped at `CACHE_MAX_ENTRIES` (default 500), and the total junction count is capped at `CACHE_MAX_POINTS` (default 1,000,000). Eviction is oldest-`cachedAt`-first until both caps are satisfied; a single fetch larger than the point budget is kept (otherwise it would miss-loop). All three bounds are also applied when the snapshot is loaded at startup. Snapshot writes are debounced by `CACHE_SAVE_DEBOUNCE_MS` (default 2000 ms) so a burst of misses stringifies the store once, not per insert.

## Tests

```bash
pnpm test        # vitest (environment: 'node' in vitest.config.ts)
pnpm typecheck   # tsc over src + tests via tsconfig.test.json
```

`pnpm build` only compiles `src/**` (the base `tsconfig.json` include), so it never type-checks the test files — `pnpm typecheck` uses `tsconfig.test.json` to close that gap and catch unsafe casts/mocks in tests.

## Abuse controls

- **Per-IP rate limits** (token bucket, keyed on the TCP socket IP; forwarding headers are used only when the peer is a trusted proxy — nginx on loopback by default, or `TRUSTED_PROXIES`): `/junctions` 60/min, `/logs` 30/min, `/health` 120/min. Behind a trusted proxy the key is `X-Real-IP`, then the last `X-Forwarded-For` hop — never the client-supplied first hop (finding #7895). The production unit sets `TRUSTED_PROXIES=100.117.202.73` (the VPS Tailscale IPv4) so public traffic through nginx is keyed on the client, not shared as one VPS-IP bucket (finding #7754). Direct tailnet callers remain keyed on the real socket address, so a spoofed XFF cannot mint a new bucket.
- **Overpass response cap** (`OVERPASS_MAX_BYTES`, 32 MiB): the body is streamed and counted before `JSON.parse`, so a runaway dump cannot OOM the process (finding #7755). POST `/junctions` is capped at 16 kB to match nginx `client_max_body_size`.
- **Global Overpass concurrency cap** (`overpass-limit.ts`): at most 2 outbound Overpass fetches run at once (with a bounded wait queue; overflow → 502). In-flight dedup only collapses identical cache keys (bbox-keyed or start-anchored), so this is what stops a burst of *distinct* misses from fanning out into many parallel Overpass queries and getting the shared public instance banned. Start-anchored POSTs coalesce on `(start≈100m, ⌈maxKm⌉, exclude)`, not on the destination/response bbox — distinct destination bboxes from the same start share one inflight fetch.
- **`LOGS_TOKEN`** (env var): `/logs` is **closed by default** — it echoes anchored-lookup events that include the walker's `start` at ~110 m precision (≈ home) and roaming radius, and is publicly reachable via the VPS proxy at `/api/junctions/logs`. Set `LOGS_TOKEN` to reopen it behind an `Authorization: Bearer <LOGS_TOKEN>` (constant-time check); unset ⇒ `401`. journald (see [Logs](#logs)) is the primary, already-authenticated log path, so leaving it closed loses nothing operationally.

## Endpoint

```
POST /junctions          JSON body (see below)
GET  /junctions?bbox=<minLat,minLng,maxLat,maxLng>&exclude=default|winter
GET  /health
GET  /logs?n=<count>
```

Start/radius used to travel on the GET query string and land in nginx access logs at full JS precision (often home). They now go in the POST body so the request line has no coordinates (finding #7559). GET is bbox-only: any of `startLat`/`startLng`/`maxKm` on the query string 400s with "must be sent in the POST body".

POST body:

```json
{
    "bbox": "<minLat,minLng,maxLat,maxLng>",
    "exclude": "default | winter",
    "startLat": 62.24,
    "startLng": 25.75,
    "maxKm": 7
}
```

`startLat`/`startLng`/`maxKm` are optional as a set (all-or-nothing). Numbers or strings are accepted.

Two cache modes:

- **Start-anchored** (POST, when `startLat`/`startLng`/`maxKm` are all sent): one Overpass call per `(start≈100m, ⌈maxKm⌉, exclude)`. Server fetches `start ± maxKm` once, filters to `bbox` per response. Designed so re-rolls from the same start hit the cache regardless of destination.
- **Bbox-keyed** (GET, or POST without start params): one Overpass call per quantized requested bbox. Kept so a bbox-only curl still works.

Response:

```json
{
    "cache": "hit" | "miss" | "coalesced",
    "count": 1834,
    "total": 30412,
    "overpassMs": 2345,
    "junctions": [{ "lat": 62.123, "lng": 21.456 }, ...]
}
```

| `cache` | meaning | `overpassMs` |
| --- | --- | --- |
| `hit` | served from the in-memory store | omitted |
| `miss` | this request originated the Overpass fetch | wait including throttle-queue |
| `coalesced` | joined another request's in-flight Overpass fetch | this waiter's wait |

`total` is the size of the underlying cached set (anchored mode only); `count` is the filtered slice returned in `junctions`.

## Logs

One stdout line per request, captured by journald on shelly:

```
ssh shelly journalctl -u wander-junctions -f -o cat
```

Format: ISO timestamp + level + key=value pairs.

## Deploy

Lives at `/home/shelly/Projects/explorer/junctions-cache` on shelly (`WorkingDirectory` of `wander-junctions.service`; bare repo `ssh://shelly/home/shelly/explorer.git`). Canonical unit file: `deploy/wander-junctions.service` (`User=wander-junctions`, `ExecStart=/usr/bin/node dist/index.js`). Pushed via the `shelly` git remote — the post-receive hook checks out, runs `pnpm install --frozen-lockfile && pnpm build` when `junctions-cache/` changed, and restarts the unit. Persistent cache: `CACHE_PATH=/var/lib/wander-junctions/cache.json` (`StateDirectory`, not under `/home/shelly`). First-time unit install (dedicated nologin user, cache migrate, hardening): `deploy/install-wander-junctions.sh` on shelly. VPS nginx proxies `https://mase.fi/api/junctions/` → `100.69.160.113:5001`. Same-origin from `/explorer` — no CORS (the client is `POST /api/junctions/junctions` with a JSON body); the edge `limit_req` is the DoS control. Canonical nginx snippet: `deploy/nginx-junctions.conf` (path-only access log so a leftover GET query cannot persist coords).
