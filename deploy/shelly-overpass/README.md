# Self-hosted Overpass on shelly

`wander-overpass.service` runs a pinned `wiktorn/overpass-api` container holding
the Geofabrik Finland extract, serving the Overpass interpreter on
`127.0.0.1:5002`. It is the upstream for `junctions-cache` — the only consumer.

Design and rationale: `docs/plans/2026-08-31-self-hosted-overpass-design.md`.

## Install

```bash
scp -r deploy/shelly-overpass shelly:/tmp/
ssh shelly 'bash /tmp/shelly-overpass/install.sh'
```

The script reads `wander-overpass.service` from beside itself, so it cannot be
piped in over `bash -s` — stdin leaves `BASH_SOURCE` unset. Copying the whole
directory keeps the unit single-sourced from the repo instead of duplicated
into a heredoc.

Idempotent. It pulls the image (retrying past shelly's intermittent registry
failures), creates `/srv/overpass/db`, installs + enables the unit, and returns
as soon as the unit is active. **It does not wait for the import.**

## The import

A first start downloads the Finland pbf, converts it to bz2 with `osmium cat`,
and builds the osm3s indexes. That runs for hours and consumes a few GB. During
the window the interpreter answers nothing useful; `junctions-cache` latches
its local-down flag and serves every query from public Overpass instead, so
Wander keeps working.

Watch it:

```bash
ssh shelly 'journalctl -fu wander-overpass'
```

Done when this returns JSON carrying an `osm3s.timestamp_osm_base`:

```bash
ssh shelly 'curl -s "http://127.0.0.1:5002/api/interpreter?data=[out:json];node(1);out;"'
```

## Freshness

`OVERPASS_DIFF_URL` points at Geofabrik's `finland-updates/`, refreshed daily
and public (no OAuth). The container applies diffs every hour
(`OVERPASS_UPDATE_SLEEP=3600`), so there is no re-import and no outage window.

## Settings that matter

| Setting | Why |
| --- | --- |
| `wiktorn/overpass-api:v0.7.62.11` | Pinned. The volume holds a multi-hour import; an unpinned pull that changes the DB format on restart is a re-import, not a restart. |
| `OVERPASS_META=no` | The public Geofabrik extract carries no metadata and Wander reads no changeset/user. Halves disk and import time. |
| `OVERPASS_USE_AREAS=false` | Wander never issues an `area` query. Area generation would burn background CPU forever for output nothing reads. |
| `OVERPASS_STOP_AFTER_INIT=false` | The image stops after init by default; under systemd it must keep serving. |
| `-p 127.0.0.1:5002:80` | Loopback only. `junctions-cache` is native on this host; nothing needs the tailnet. Port 5002 because 5000 is `osrm-foot` and 5001 is `wander-junctions`. |
| `ExecStartPre=-docker rm -f` | A crash or unclean shutdown leaves the named container behind and every later `docker run --name` fails with "name already in use". |

The `ExecStart` quoting is load-bearing: systemd only treats a quote as a quote
when it opens an item, so `OVERPASS_PLANET_PREPROCESS` is written as
`-e "VAR=value"`, not `-e VAR='value'`. The latter would pass the quote
characters through to docker.

## Operations

```bash
ssh shelly 'systemctl status wander-overpass --no-pager'
ssh shelly 'sudo systemctl restart wander-overpass'   # safe; the DB persists in /srv/overpass/db
ssh shelly 'du -sh /srv/overpass/db'
```

Stopping the container is a supported test: `junctions-cache` falls back to
public Overpass within one request and latches for 5 minutes.

Wiping `/srv/overpass/db` forces a full re-import. Do it only to recover from a
corrupt database.
