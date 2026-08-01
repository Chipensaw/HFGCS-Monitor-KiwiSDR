#!/bin/sh
# HFGCS retention sweep.
#
# Two independent limits, applied in order:
#   1. age    -- delete day directories older than retentionDays
#   2. size   -- if the tree still exceeds maxTotalMB, delete oldest days
#                until it fits
#
# The size cap exists because age alone does not bound anything: one busy
# week during an exercise can outweigh a quiet month, and this disk is shared
# with the production relay.
#
# Deletes whole day directories, never individual clips, so events.jsonl and
# the audio it describes are always removed together.

set -eu

DATA=${1:-/opt/hfgcs/data}
CONFIG=${2:-/opt/hfgcs/config/hfgcs.json}
EVENTS="$DATA/events"

[ -d "$EVENTS" ] || { echo "[retention] no events dir at $EVENTS; nothing to do"; exit 0; }

# Read limits from config, with conservative fallbacks if jq/python are absent
# or the keys are missing.
read_cfg() {
    # read_cfg <dotted.key.path> <fallback>
    python3 - "$CONFIG" "$1" "$2" <<'PYEOF' 2>/dev/null || echo "$2"
import json, sys
try:
    with open(sys.argv[1]) as fh:
        cfg = json.load(fh)
    node = cfg
    for key in sys.argv[2].split('.'):
        node = node[key]
    print(int(node))
except Exception:
    print(int(sys.argv[3]))
PYEOF
}

DAYS=$(read_cfg retention.retentionDays 90)
MAXMB=$(read_cfg retention.maxTotalMB 8192)

echo "[retention] limits: retentionDays=$DAYS maxTotalMB=$MAXMB"

# --- pass 1: age ------------------------------------------------------------
removed_age=0
cutoff=$(date -u -d "$DAYS days ago" +%Y-%m-%d 2>/dev/null || true)
if [ -n "$cutoff" ]; then
    for d in "$EVENTS"/*; do
        [ -d "$d" ] || continue
        day=$(basename "$d")
        # Only touch directories that look like YYYY-MM-DD.
        case "$day" in
            [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
            *) continue ;;
        esac
        if [ "$day" \< "$cutoff" ]; then
            echo "[retention] age: removing $day"
            rm -rf -- "$d"
            removed_age=$((removed_age + 1))
        fi
    done
else
    echo "[retention] WARNING: could not compute cutoff date; age pass skipped"
fi

# --- pass 2: size -----------------------------------------------------------
total_mb() { du -sm "$EVENTS" 2>/dev/null | awk '{print $1}'; }

removed_size=0
cur=$(total_mb)
while [ -n "$cur" ] && [ "$cur" -gt "$MAXMB" ]; do
    oldest=""
    for d in "$EVENTS"/*; do
        [ -d "$d" ] || continue
        # Only ever delete directories that look like YYYY-MM-DD. Anything
        # else in events/ was put there by a human and is not ours to reap.
        case "$(basename "$d")" in
            [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
            *) continue ;;
        esac
        oldest=$d
        break
    done
    [ -n "$oldest" ] || break
    echo "[retention] size: ${cur}MB > ${MAXMB}MB, removing $(basename "$oldest")"
    rm -rf -- "$oldest"
    removed_size=$((removed_size + 1))
    cur=$(total_mb)
done

echo "[retention] done: ${removed_age} removed by age, ${removed_size} by size, now ${cur:-0}MB"
exit 0
