#!/usr/bin/env bash
# Post-deploy hook — run by `deploy` from the main worktree after push, service
# restart and the health gate.
#
# Wander's deployed artifacts span three places (VPS nginx + wander-api, shelly
# osrm-foot + wander-overpass + wander-junctions), and `deploy` restarts units it
# never installs. That gap hid the #7755 hardening on shelly for months while its
# test passed against the repo copy. So the one thing this hook does is say
# whether what is running matches what just landed.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec deploy/check-unit-drift.sh
