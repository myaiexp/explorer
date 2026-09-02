#!/usr/bin/env bash
# Post-deploy hook — run by `deploy` from the main worktree after push, service
# restart and the health gate.
#
# Wander's deployed artifacts span three places (VPS nginx + wander-api, shelly
# osrm-foot + wander-overpass + wander-junctions), and `deploy` restarts units it
# never installs. That gap hid the #7755 hardening on shelly for months while its
# test passed against the repo copy. So the one thing this hook does is say
# whether what is running matches what just landed.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Both checks always run, then one combined exit. Short-circuiting on the first
# failure would hide the other half's report behind whichever ran first, and the
# whole point is to see the full picture of what is behind.
rc=0
deploy/check-unit-drift.sh || rc=1
echo
deploy/check-nginx-drift.sh || rc=1
exit $rc
