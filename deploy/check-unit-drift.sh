#!/usr/bin/env bash
# Compare every systemd unit committed under deploy/ against the copy actually
# installed on its host.
#
# WHY: a unit that is committed but not installed keeps running as an old copy.
# wander-junctions.service ran on shelly for months as an earlier unit — no
# dedicated user, cache still under /home/shelly — while its hardening test
# passed on every run. Both are true at once: the test reads the REPO copy, and
# `deploy` / the post-receive hook restart a unit but never install it. A test
# that reads a repo file proves the intent, never the deployment, so this
# script reads the installed copy.
#
# Each unit names its own host in a `# deploy-host: <host>` header, so a unit
# added later joins this check without anyone remembering a list. `local` means
# this box; anything else is an ssh destination. A unit with no header FAILS
# rather than being skipped — opt-in would reproduce exactly the silence this
# exists to end.
#
# Both sides drop what systemd itself ignores before comparing: lines whose
# first non-blank character is # or ;, blank lines, and trailing whitespace. So
# a comment-only edit in the repo is not DRIFT and does not fail the deploy
# until the unit is reinstalled. Comment drift goes unreported; behaviour is
# what this guards. A '#' after content is part of the value, so it stays.
#
# Drop-ins count as the unit. systemd layers every <unit>.d/*.conf in
# /etc/systemd/system over the unit file, so a stale one changes behaviour while
# the unit itself still matches — osrm-refresh.service ran six weeks with a
# drop-in pointing LD_LIBRARY_PATH at a deleted dir and read "ok" every deploy.
# Each side is the unit followed by its drop-ins in name order, each behind a
# marker line: the host's /etc/systemd/system/<unit>.d/, and the repo's
# <unit>.d/ committed beside the unit. An installed drop-in the repo does not
# commit is DRIFT, and the report names it. /usr/lib drop-ins are package-owned
# and not read.
#
# Exit 1 on DRIFT, MISSING, a read ERROR or an undeclared host. An UNREACHABLE
# host only warns: ssh being down is not evidence about drift, and a shelly
# outage should not fail a VPS deploy — but the line is printed every run, so it
# cannot go quiet. A dead host is dialled once per run, under a bounded timeout
# (lib/read-installed.sh).
#
# Reports only. Installing is deliberate (a unit change usually wants the matching
# installer, e.g. deploy/install-wander-junctions.sh, which also creates users and
# migrates state) — this says WHICH host is behind, and by what.

set -uo pipefail

# Seams, both defaulting to production: the tree to scan, and where a `local`
# unit is installed. Overridden by the tests to drive a fixture tree.
UNIT_SRC_DIR="${UNIT_SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
SYSTEMD_UNIT_DIR="${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"

# read_installed + mark_unreachable: the bounded ssh read and its exit codes.
# shellcheck source=lib/read-installed.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/read-installed.sh"

failed=0
checked=0

# The unit at "$1", then each "$1".d/*.conf behind an `@@ drop-in <name> @@`
# line. POSIX sh, because read_installed runs it on the host over ssh — one
# call per unit — and the repo side runs the same text locally, so both sides
# are built by one definition. LC_ALL=C pins the glob order to systemd's.
EMIT_WITH_DROPINS='cat "$1" || exit 1
LC_ALL=C
for f in "$1".d/*.conf; do
    [ -f "$f" ] || continue
    printf "\n@@ drop-in %s @@\n" "${f##*/}"
    cat "$f" || exit 1
done'

# Names of the drop-ins in a side built by EMIT_WITH_DROPINS, one per line.
dropin_names() {
    sed -n 's/^@@ drop-in \(.*\) @@$/\1/p' | tr '\n' ' ' | sed 's/ $//'
}

# Reads stdin, writes stdout. The same function runs over both sides, so it can
# only ever hide a difference, never invent one.
normalize() {
    sed -E -e '/^[[:space:]]*[#;]/d' -e 's/[[:space:]]+$//' -e '/^$/d'
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
    if installed=$(read_installed "$host" "$installed_path" "$EMIT_WITH_DROPINS"); then
        repo=$(sh -c "$EMIT_WITH_DROPINS" sh "$src")
        if [[ "$(printf '%s\n' "$repo" | normalize)" == "$(printf '%s\n' "$installed" | normalize)" ]]; then
            report "$name" "ok ($host)"
        else
            live_dropins="$(printf '%s\n' "$installed" | dropin_names)"
            repo_dropins="$(printf '%s\n' "$repo" | dropin_names)"
            if [[ "$live_dropins" != "$repo_dropins" ]]; then
                report "$name" "DRIFT — $host:$installed_path.d/ holds [${live_dropins:-none}], repo commits [${repo_dropins:-none}]"
            else
                report "$name" "DRIFT — $host:$installed_path differs from ${src#"$UNIT_SRC_DIR"/} (unit or drop-ins)"
            fi
            failed=1
        fi
    else
        case $? in
            10) report "$name" "MISSING — not installed at $host:$installed_path"; failed=1 ;;
            11) report "$name" "unreachable — could not ssh to $host (not checked)"; mark_unreachable "$host" ;;
            12) report "$name" "ERROR — reading $host:$installed_path failed ($installed)"; failed=1 ;;
        esac
    fi
done < <(find "$UNIT_SRC_DIR" -type f \( -name '*.service' -o -name '*.timer' -o -name '*.socket' \) | sort)

if [[ $checked -eq 0 ]]; then
    echo "  no units found under $UNIT_SRC_DIR — the scan is broken, not the deployment"
    exit 1
fi

if [[ $failed -ne 0 ]]; then
    echo "Unit drift: the running config is NOT what the repo says. Install the unit on the host above."
    exit 1
fi

echo "Unit drift: none ($checked checked)"
