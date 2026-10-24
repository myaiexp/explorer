# Self-hosted OSRM-foot on shelly

`osrm-foot.service` serves foot routing for Finland on `100.69.160.113:5000`
(tailnet), proxied by the VPS at `https://mase.fi/api/osrm-fi/`. Weekly
`osrm-refresh.timer` (Sun 03:00) rebuilds the graph from Geofabrik.

## Binary and data move together

osrm-routed loads only a set built by its own major.minor
(`FingerPrint::IsDataCompatible`; 26.10 on a 26.8 set exits 8 on
`osrm_fingerprint.meta`). When the binary was the AUR `osrm-backend` package,
pacman (shelly's 04:00 `omarchy-auto-update`) or a reboot could start a newer
binary on last Sunday's graph and crash-loop it. Sunday's refresh could not
repair that, because it extracts before restarting and a reboot never gets that
far. The package was held with `IgnorePkg`, and every boost-libs bump needed a
local rebuild.

osrm-backend now runs from the official image, pinned in exactly one place:
`IMAGE=` in `osrm-refresh.sh`. Each refresh:

1. builds a timestamped set under `/srv/osrm/finland/processed/` with that
   image, by digest;
2. trial-loads it (`osrm-routed --trial=1`) with the same user, read-only mount
   and dropped caps the unit uses;
3. writes `osrm.env` into the set **last**: `OSRM_IMAGE` (digest),
   `OSRM_IMAGE_PIN` (tag), `OSRM_SET`, `OSRM_USER`;
4. swaps `current` atomically, restarts `osrm-foot`, and smoke-tests a route,
   rolling back to the previous stamped set if that fails;
5. keeps two stamped sets (current + rollback) and deletes everything else,
   including sets left without a stamp by a killed run. Since that would also
   delete a concurrent run's staging set, a second refresh exits 75 while
   `/srv/osrm/finland/.refresh.lock` is held.

`osrm-foot.service` takes its image and mount from `current/osrm.env`, so any
start (reboot, crash, refresh) runs the set with the image that built it. A set
without a stamp refuses to start. Package updates and reboots at any hour
cannot change what serves, and a refresh killed at 04:00 leaves `current`
untouched.

## Install / upgrade

```bash
scp -r deploy/shelly-osrm shelly:/tmp/
ssh shelly 'bash /tmp/shelly-osrm/install.sh'
```

Copied, not piped through `bash -s`: the script reads the units from beside
itself. It installs the script and units, then runs `osrm-refresh --check`. If
`current` was not built by the pinned image, it starts `osrm-refresh.service`
and waits (~20 min). The old set keeps serving until the swap.

**To upgrade osrm-backend**, bump `IMAGE` (26.x publishes only `-debian`
variants on `ghcr.io/project-osrm/osrm-backend`) and rerun the installer.
Nothing else has to happen in any order.

`--update-data` forces a rebuild with the current pin.

## Operations

```bash
ssh shelly 'cat /srv/osrm/finland/processed/current/osrm.env'   # what is serving
ssh shelly 'sudo osrm-refresh --check'                          # built by the pin?
ssh shelly 'journalctl -u osrm-refresh -n 50 --no-pager'
```

Superseded images are not pruned automatically. After an upgrade has run for a
week, an image no set's `OSRM_IMAGE` names can go: `docker image rm <ref>`.
