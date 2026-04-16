#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

SCRIPT_NAME="inactive_30d_offer1"
TS() { date -Is; }

log() { echo "[$1] ${*:2}"; }

: "${DRY_RUN:=0}"
: "${SEGMENT_KEY:=inactive_30d_offer1}"
: "${MESSAGE_FILE:=./messages/flex.json}"

log start "script=${SCRIPT_NAME} ts=$(TS)"

# ① build
SEGMENT_KEY="${SEGMENT_KEY}" bash ./scripts/build_inactive_30d_offer1.sh

# ② send
OUTPUT="$(
  DRY_RUN="${DRY_RUN}" \
  SEGMENT_KEY="${SEGMENT_KEY}" \
  MESSAGE_FILE="${MESSAGE_FILE}" \
  node send_blast_once.js 2>&1
)"

echo "${OUTPUT}"

# ③ ログ要約
roster_total=$(echo "$OUTPUT" | grep -o 'roster_total=[0-9]*' | cut -d= -f2)
eligible=$(echo "$OUTPUT" | grep -o 'eligible_targets.*=[0-9]*' | grep -o '[0-9]*$')
valid=$(echo "$OUTPUT" | grep -o 'valid_targets=[0-9]*' | cut -d= -f2)

log result "roster_total=${roster_total:-0} eligible=${eligible:-0} valid=${valid:-0}"

log end "script=${SCRIPT_NAME} ok ts=$(TS)"