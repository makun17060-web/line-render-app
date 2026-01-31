#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[buyers_thanks_5d_named] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

# ▼ 固定（事故防止）
NOTIFIED_KIND_FIXED="buyers_thanks_5d_named"
MESSAGE_FILE_FIXED="./messages/buyers_thanks_5d_named.json"

# ▼ デフォルト（env で上書き可）
: "${WINDOW_START_DAYS:=6}"
: "${WINDOW_END_DAYS:=5}"
: "${DEDUP_BY_USER:=1}"
: "${LIMIT:=2000}"
: "${SLEEP_MS:=200}"
: "${DRY_RUN:=1}"
: "${FORCE_ORDER_ID:=}"

export NOTIFIED_KIND="$NOTIFIED_KIND_FIXED"
export MESSAGE_FILE="$MESSAGE_FILE_FIXED"

export WINDOW_START_DAYS
export WINDOW_END_DAYS
export DEDUP_BY_USER
export LIMIT
export SLEEP_MS
export DRY_RUN
export FORCE_ORDER_ID

node scripts/send_buyers_thanks_5d_named.js

echo "[buyers_thanks_5d_named] done: $(date -Is)"
