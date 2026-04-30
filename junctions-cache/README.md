# wander-junctions

Server-side cache for OSM road-junction lookups, fronting the public Overpass API. Used by the Wander frontend's smart-routing path.

## Run

```bash
pnpm install
pnpm dev                    # tsx watch
pnpm build && pnpm start    # production
```

Listens on `127.0.0.1:5001` (override with `PORT`). Persists cache to `./data/cache.json` (override with `CACHE_PATH`).

## Endpoint

```
GET /junctions?bbox=<minLat,minLng,maxLat,maxLng>&exclude=default|winter
GET /health
```

Response:

```json
{
    "cache": "hit" | "miss",
    "count": 1834,
    "overpassMs": 2345,
    "junctions": [{ "lat": 62.123, "lng": 21.456 }, ...]
}
```

## Logs

One stdout line per request, captured by journald on shelly:

```
ssh shelly journalctl -u wander-junctions -f -o cat
```

Format: ISO timestamp + level + key=value pairs.

## Deploy

Lives at `/srv/wander-junctions/junctions-cache` on shelly. Pushed via the `shelly` git remote — the bare repo's `post-receive` hook checks out, runs `pnpm install --frozen-lockfile && pnpm build`, and restarts `wander-junctions.service`. VPS nginx proxies `https://mase.fi/api/junctions/` → `100.69.160.113:5001`.
