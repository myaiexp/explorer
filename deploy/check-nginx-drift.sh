#!/usr/bin/env bash
# Compare every nginx conf committed under deploy/ against the copy actually
# installed on its host.
#
# WHY (idea #4047): this is check-unit-drift.sh's argument applied to the other
# half of the deployment. deploy/nginx-*.conf are the reviewable source of truth
# — tests/nginx-security.test.js reads them and asserts the CSP, the rate limits
# and the XFF overwrite — while the live vhost is hand-edited to match and
# nothing compared the two. On 2026-09-01 nginx-wander.conf HAD drifted: live
# carried https://tile.openstreetmap.org in the CSP img-src that the repo copy
# lacked. Harmless in that instance, but the repo was not the truth it claims to
# be, and a test reading the repo copy could never have said so.
#
# The comparison differs from the unit check, which is why this is its own
# script. A unit is a whole file; most of these are FRAGMENTS embedded in
# /etc/nginx/sites-enabled/default, a vhost shared with every other project on
# the box. So each conf's header names its host and its install path, and the
# VERB names which of the two shapes it is:
#
#   # deploy-host: local                                  `local` = this box, else an ssh destination
#   # deploy-into: /etc/nginx/sites-enabled/default       a fragment of a bigger file  → containment
#   # deploy-as:   /etc/nginx/snippets/wander-headers.conf the repo owns the whole file → equality
#
# Exactly one of into/as, and a conf with neither (or both) FAILS rather than
# being skipped — opt-in would reproduce the silence this exists to end. The two
# modes are not interchangeable: containment alone would wave through an
# add_header appended live to a file the repo claims to own, which is the exact
# silent-hole shape nginx-wander-headers.conf exists to prevent.
#
# Both sides are normalized before comparing: comments dropped, runs of
# whitespace collapsed, blank lines removed. Indentation is not a config change
# (a snippet sits one level deeper inside `server { }`), and comment text drifts
# constantly. The cost is that comment drift is NOT reported — the live vhost's
# comments still said /explorer after the rename and this check stays quiet about
# that. Behaviour is what it guards.
#
# `#` opens a comment at the start of a line or after whitespace only, so a '#'
# inside a directive value stays content and a difference after it still counts.
#
# Exit 1 on DRIFT, MISSING or an undeclared header. An UNREACHABLE host only
# warns: ssh being down is not evidence about drift, and a shelly outage should
# not fail a VPS deploy — but the line is printed every run, so it cannot go
# quiet.
#
# Reports only. Installing nginx config is deliberate: a fragment has to be
# spliced into a vhost by hand and `nginx -t` run before reload.

set -uo pipefail

# Seams, both defaulting to production: the tree to scan, and a prefix in front
# of every declared install path. Overridden by the tests to drive a fixture root.
NGINX_SRC_DIR="${NGINX_SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NGINX_ROOT_PREFIX="${NGINX_ROOT_PREFIX:-}"

# -n is load-bearing, not tidiness: this ssh runs INSIDE a `while read` loop fed
# by find, and without it ssh drains that stdin and the loop silently stops after
# the first remote conf. See the same note in check-unit-drift.sh — it cost that
# script a clean-looking partial answer on its first real run.
SSH_OPTS=(-n -o BatchMode=yes -o ConnectTimeout=10)

failed=0
checked=0

# Comments out, whitespace collapsed, blank lines gone. Reads stdin, writes
# stdout. The same function runs over both sides, so it can only ever hide a
# difference, never invent one.
normalize() {
    sed -E 's/(^|[[:space:]])#.*$//' |
        awk '{ gsub(/[[:space:]]+/, " "); gsub(/^ | $/, ""); if ($0 != "") print }'
}

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

header() {
    sed -n "s/^#[[:space:]]*$1:[[:space:]]*\([^[:space:]]\{1,\}\)[[:space:]]*$/\1/p" "$2" | head -1
}

report() {
    printf '  %-40s %s\n' "$1" "$2"
}

echo "Nginx drift check (repo → installed)"

while IFS= read -r src; do
    checked=$((checked + 1))
    name="$(basename "$src")"
    rel="${src#"$NGINX_SRC_DIR"/}"

    host="$(header deploy-host "$src")"
    into="$(header deploy-into "$src")"
    as="$(header deploy-as "$src")"

    if [[ -z "$host" ]]; then
        report "$name" "UNDECLARED — no deploy-host: header in $rel"
        failed=1
        continue
    fi
    if [[ -n "$into" && -n "$as" ]]; then
        report "$name" "UNDECLARED — $rel declares both deploy-into and deploy-as; pick one"
        failed=1
        continue
    fi
    if [[ -z "$into" && -z "$as" ]]; then
        report "$name" "UNDECLARED — no deploy-into:/deploy-as: header in $rel"
        failed=1
        continue
    fi

    if [[ -n "$as" ]]; then
        mode=exact
        declared="$as"
    else
        mode=embedded
        declared="$into"
    fi
    installed_path="${NGINX_ROOT_PREFIX}${declared}"

    if installed=$(read_installed "$host" "$installed_path"); then
        repo_norm="$(normalize <"$src")"
        live_norm="$(printf '%s\n' "$installed" | normalize)"
        if [[ "$mode" == exact ]]; then
            [[ "$repo_norm" == "$live_norm" ]] && ok=1 || ok=0
        else
            # Newline-wrapped so the match is line-aligned at both ends — a raw
            # substring test would accept our block starting mid-directive.
            [[ $'\n'"$live_norm"$'\n' == *$'\n'"$repo_norm"$'\n'* ]] && ok=1 || ok=0
        fi
        if [[ $ok -eq 1 ]]; then
            report "$name" "ok ($mode, $host)"
        else
            report "$name" "DRIFT — $host:$declared no longer matches $rel ($mode)"
            failed=1
        fi
    else
        case $? in
            10) report "$name" "MISSING — not installed at $host:$declared"; failed=1 ;;
            11) report "$name" "unreachable — could not ssh to $host (not checked)" ;;
        esac
    fi
done < <(find "$NGINX_SRC_DIR" -type f -name '*.conf' | sort)

if [[ $checked -eq 0 ]]; then
    echo "  no nginx confs found under $NGINX_SRC_DIR — the scan is broken, not the deployment"
    exit 1
fi

if [[ $failed -ne 0 ]]; then
    echo "Nginx drift: the live config is NOT what the repo says. Reconcile, then nginx -t && reload."
    exit 1
fi

echo "Nginx drift: none ($checked checked)"
