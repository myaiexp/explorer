# Read the installed copy of a deploy file, locally or over ssh — sourced by
# check-unit-drift.sh and check-nginx-drift.sh, which both compare a repo file
# against the copy on the host its header names.
#
# The caller's ssh runs INSIDE a `while read` loop fed by find, and without -n
# ssh drains that stdin and the loop silently stops after the first remote file.
# The first run of check-unit-drift.sh checked 2 of 6 units that way and
# reported a clean-looking partial answer — the failure these scripts exist to
# end.
#
# ConnectTimeout starts after getaddrinfo, so on its own it does not bound a
# dead resolver, and `deploy` runs these scripts with nothing around them
# (idea #6279). GNU timeout bounds the whole ssh. 20s default: ConnectTimeout's
# 10s, then auth and the cat. DRIFT_SSH_TIMEOUT is the test seam.
DRIFT_SSH_TIMEOUT="${DRIFT_SSH_TIMEOUT:-20}"
DRIFT_SSH_OPTS=(-n -o BatchMode=yes -o ConnectTimeout=10)

# Hosts already found unreachable this run. read_installed runs inside $( ), so
# it can read this but not write it; the caller records a host with
# mark_unreachable. Without it a dead host costs one full timeout per file.
declare -A DRIFT_UNREACHABLE=()

mark_unreachable() {
    DRIFT_UNREACHABLE["$1"]=1
}

# stdout of the installed copy, or a non-zero exit saying why not:
#   10 = no such file (the host was reached and looked)
#   11 = host unreachable (ssh failed, or the timeout cut it off)
#   12 = anything else; stdout then carries the ssh status for the report
read_installed() {
    local host="$1" path="$2"
    if [[ "$host" == "local" ]]; then
        [[ -f "$path" ]] || return 10
        cat "$path"
        return 0
    fi
    [[ -n "${DRIFT_UNREACHABLE[$host]:-}" ]] && return 11
    # The remote command's own sentinel, so MISSING can only mean the host
    # answered "not a file". A cat that fails on a file that IS there exits 1,
    # which lands in 12 rather than being folded into MISSING.
    local out rc
    out=$(timeout --kill-after=2 "$DRIFT_SSH_TIMEOUT" \
        ssh "${DRIFT_SSH_OPTS[@]}" "$host" "test -f '$path' || exit 10; cat '$path'" 2>/dev/null)
    rc=$?
    case $rc in
        0) printf '%s\n' "$out"; return 0 ;;
        10) return 10 ;;
        # 255 is ssh's own failure; 124 is timeout's TERM, 137 its KILL.
        124 | 137 | 255) return 11 ;;
        *) printf 'exit %s\n' "$rc"; return 12 ;;
    esac
}
