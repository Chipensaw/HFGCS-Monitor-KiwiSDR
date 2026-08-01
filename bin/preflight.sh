#!/bin/sh
# HFGCS recorder preflight interlock.
#
# Runs as ExecStartPre. A non-zero exit blocks the unit from starting and the
# reason lands in the journal as plain text.
#
# Three gates, in order of how badly you want to be stopped:
#
#   1. config/ENABLED must exist. Installing and enabling a unit is not the
#      same act as authorising it to open sockets to other people's radios.
#      Removing this file is the kill switch.
#
#   2. kiwi-survey-collector must not be running. Both projects draw slots
#      from the same KiwiSDR pool. A slot we are holding is a slot the survey
#      sees as unavailable, which feeds straight into its documented 8 dB
#      selection bias -- and the cohort fingerprint cannot detect it, because
#      the cohort has not changed. Only the observed capacity has.
#
#   3. The newest survey run must carry its COMPLETE sentinel. Gate 2 alone
#      is not enough: a paused collector is inactive but its run is still
#      open, and resuming it later would land us right back in gate 2's
#      problem with data already collected under two different conditions.
#
# Override for a genuine emergency: stop the survey properly, or edit this
# script. Do not make it silently permissive.

set -eu

CONFIG_DIR=${HFGCS_CONFIG_DIR:-/opt/hfgcs/config}
SURVEY_DATA=${KIWI_SURVEY_DATA:-/opt/kiwi-survey/data}
SURVEY_UNIT=${KIWI_SURVEY_UNIT:-kiwi-survey-collector}

# --- gate 1: explicit authorisation -----------------------------------------
if [ ! -f "$CONFIG_DIR/ENABLED" ]; then
    echo "[preflight] REFUSED: $CONFIG_DIR/ENABLED is absent."
    echo "[preflight] The recorder is installed but not authorised to contact receivers."
    echo "[preflight] To authorise:  sudo -u hfgcs touch $CONFIG_DIR/ENABLED"
    exit 1
fi

# --- gate 2: survey collector must be idle ----------------------------------
if systemctl is-active --quiet "$SURVEY_UNIT" 2>/dev/null; then
    echo "[preflight] REFUSED: $SURVEY_UNIT is active."
    echo "[preflight] Both projects draw slots from the same KiwiSDR pool; running"
    echo "[preflight] them together corrupts the survey's capacity measurements."
    exit 1
fi

# --- gate 3: newest survey run must be complete -----------------------------
# No run directory at all is fine -- that means no survey has ever run here.
newest=""
for d in "$SURVEY_DATA"/run-*; do
    [ -d "$d" ] || continue
    newest=$d
done

if [ -n "$newest" ] && [ ! -f "$newest/COMPLETE" ]; then
    echo "[preflight] REFUSED: survey run $(basename "$newest") has no COMPLETE sentinel."
    echo "[preflight] The run is open -- paused, or still in progress. Wait for it to"
    echo "[preflight] finish, or retire the run directory if it has been abandoned."
    exit 1
fi

echo "[preflight] OK: authorised, survey idle${newest:+, $(basename "$newest") complete}."
exit 0
