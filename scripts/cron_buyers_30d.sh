#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_buyers_30d] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

: "${DRY_RUN:=1}"
: "${MESSAGE_FILE:=./messages/buyers_30d_soft.json}"

# JSTで「30日前」の日付をキー化
TARGET_DATE="$(TZ=Asia/Tokyo date -d "30 days ago" +%F 2>/dev/null || TZ=Asia/Tokyo date -v-30d +%F)"
SEGMENT_KEY="buyers_30d_${TARGET_DATE}"

export DRY_RUN MESSAGE_FILE SEGMENT_KEY

# 1) 名簿（user_segments）作成＋送信対象（segment_blast）器作成
node scripts/prepare_buyers_30d_roster.js

# 2) 送信（既存送信エンジンに委譲）
: "${NOTIFIED_KIND:=$SEGMENT_KEY}"
: "${LIMIT:=20000}"
: "${BATCH_SIZE:=500}"
: "${SLEEP_MS:=200}"

export NOTIFIED_KIND LIMIT BATCH_SIZE SLEEP_MS
: "${INCLUDE_BOUGHT:=1}"
: "${SKIP_GLOBAL_EVER_SENT:=1}"
: "${ONCE_ONLY:=0}"
export INCLUDE_BOUGHT SKIP_GLOBAL_EVER_SENT ONCE_ONLY

node send_blast_once.js

echo "[cron_buyers_30d] done: $(date -Is)"
