#!/usr/bin/env bash
# Compare every systemd unit committed under deploy/ against the copy actually
# installed on its host.
#
# WHY (idea #4018): wander-junctions.service ran on shelly for months as the old
# pre-#7755 unit — no dedicated user, cache still under /home/shelly — while its
# hardening test passed on every run. Both were true at once: the test read the
# REPO copy, and `deploy` / the post-receive hook restart a unit but never
# install it. A test that reads a repo file proves the intent, never the
# deployment. It was found by accident, and only because copying the canonical
# unit in made the service fail 217/USER.
#
# Each unit names its own host in a `# deploy-host: <host>` header, so a unit
# added later joins this check without anyone remembering a list. `local` means
# this box; anything else is an ssh destination. A unit with no header FAILS
# rather than being skipped — opt-in would reproduce exactly the silence this
# exists to end.
#
# Exit 1 on DRIFT, MISSING or an undeclared host. An UNREACHABLE host only warns:
# ssh being down is not evidence about drift, and a shelly outage should not fail
# a VPS deploy — but the line is printed every run, so it cannot go quiet.
#
# Reports only. Installing is deliberate (a unit change usually wants the matching
# installer, e.g. deploy/install-wander-junctions.sh, which also creates users and
# migrates state) — this says WHICH host is behind, and by what.

set -uo pipefail

# Seams, both defaulting to production: the tree to scan, and where a `local`
# unit is installed. Overridden by the tests to drive a fixture tree.
UNIT_SRC_DIR="${UNIT_SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

# -n is load-bearing, not tidiness: this ssh runs INSIDE a `while read` loop fed
# by find, and without it ssh drains that stdin and the loop silently stops after
# the first remote unit. The first run of this script checked 2 of 6 units and
# reported a clean-looking partial answer — the exact failure mode the script
# exists to end.
SSH_OPTS=(-n -o BatchMode=yes -o ConnectTimeout=10)

failed=0
checked=0

# stdout of the installed copy, or a non-zero exit distinguishing absent from
# unreachable: 10 = no such file, 11 = host unreachable.
read_installed() {
    local host="$1" path="$2"
    if [[ "$host" == "local" ]]; then
        [[ -f "$path" ]] || return 10
        cat "$path"
        return 0
    fi
    # One ssh, two outcomes. `test -f` first so a missing file is reported as
    # MISSING rather than folded into the connection failure.
    local out rc
    out=$(ssh "${SSH_OPTS[@]}" "$host" "test -f '$path' && cat '$path'" 2>/dev/null)
    rc=$?
    if [[ $rc -eq 0 ]]; then
        printf '%s\n' "$out"
        return 0
    fi
    # ssh reports 255 for its own failures; anything else came from the remote
    # command, i.e. we reached the host and the file was not there.
    [[ $rc -eq 255 ]] && return 11
    return 10
}

report() {
    printf '  %-40s %s\n' "$1" "$2"
}

echo "Unit drift check (repo → installed)"

while IFS= read -r src; do
    checked=$((checked + 1))
    name="$(basename "$src")"
    host="$(sed -n 's/^#[[:space:]]*deploy-host:[[:space:]]*\([^[:space:]]\{1,\}\)[[:space:]]*$/\1/p' "$src" | head -1)"

    if [[ -z "$host" ]]; then
        report "$name" "UNDECLARED — no deploy-host: header in ${src#"$UNIT_SRC_DIR"/}"
        failed=1
        continue
    fi

    installed_path="$SYSTEMD_UNIT_DIR/$name"
    if installed=$(read_installed "$host" "$installed_path"); then
        # Both sides go through $( ) so both have trailing newlines stripped —
        # the one difference that is never a config change.
        if [[ "$(cat "$src")" == "$installed" ]]; then
            report "$name" "ok ($host)"
        else
            report "$name" "DRIFT — $host:$installed_path differs from ${src#"$UNIT_SRC_DIR"/}"
            failed=1
        fi
    else
        case $? in
            10) report "$name" "MISSING — not installed at $host:$installed_path"; failed=1 ;;
            11) report "$name" "unreachable — could not ssh to $host (not checked)" ;;
        esac
    fi
done < <(find "$UNIT_SRC_DIR" -type f \( -name '*.service' -o -name '*.timer' \) | sort)

if [[ $checked -eq 0 ]]; then
    echo "  no units found under $UNIT_SRC_DIR — the scan is broken, not the deployment"
    exit 1
fi

if [[ $failed -ne 0 ]]; then
    echo "Unit drift: the running config is NOT what the repo says. Install the unit on the host above."
    exit 1
fi

echo "Unit drift: none ($checked checked)"
