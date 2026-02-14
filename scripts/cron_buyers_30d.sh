#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_buyers_30d] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

# =========================
# 基本設定
# =========================
DRY_RUN="${DRY_RUN:-0}"

# 👇 ★ここで完全固定（環境変数に影響されない）
MESSAGE_FILE="./messages/buyers_30d_A_soft.json"

# =========================
# 日付キー生成（JST基準）
# =========================
TARGET_DATE="$(TZ=Asia/Tokyo date -d "30 days ago" +%F 2>/dev/null || TZ=Asia/Tokyo date -v-30d +%F)"
SEGMENT_KEY="buyers_30d_${TARGET_DATE}"

export DRY_RUN MESSAGE_FILE SEGMENT_KEY

echo "DEBUG FINAL MESSAGE_FILE=$MESSAGE_FILE"
node -e 'console.log("DEBUG node sees MESSAGE_FILE="+process.env.MESSAGE_FILE)'

# =========================
# 1) 名簿作成
# =========================
node scripts/prepare_buyers_30d_roster.js

# =========================
# 2) 送信設定
# =========================
: "${NOTIFIED_KIND:=$SEGMENT_KEY}"
: "${LIMIT:=20000}"
: "${BATCH_SIZE:=500}"
: "${SLEEP_MS:=200}"

export NOTIFIED_KIND LIMIT BATCH_SIZE SLEEP_MS

# 👇 buyers_30d専用（超重要）
INCLUDE_BOUGHT=1
SKIP_GLOBAL_EVER_SENT=1
ONCE_ONLY=0

export INCLUDE_BOUGHT SKIP_GLOBAL_EVER_SENT ONCE_ONLY

# =========================
# 3) 送信
# =========================
node send_blast_once.js

echo "[cron_buyers_30d] done: $(date -Is)"
