#!/usr/bin/env bash
# scripts/cron_buyers_thanks_5d_named.sh
# 購入後5日「名前付き」サンクス配信（注文単位 / push）
set -euo pipefail
set -x

echo "[buyers_thanks_5d_named] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

# ✅ 固定（事故防止）：ここだけ見れば仕様が分かる
NOTIFIED_KIND_FIXED="buyers_thanks_5d_named"
MESSAGE_FILE_FIXED="./messages/buyers_thanks_5d_named.json"

# ✅ 購入後5日（5〜6日前の注文が対象）
WINDOW_START_DAYS_FIXED="6"
WINDOW_END_DAYS_FIXED="5"

# ✅ 1ユーザー1回に抑える（今回の安全スイッチ）
DEDUP_BY_USER_FIXED="1"

# ✅ 送りすぎ防止 & レート対策
LIMIT_FIXED="2000"
SLEEP_MS_FIXED="200"

# ✅ 既定はDRY_RUN（本番はDRY_RUN=0で上書き）
: "${DRY_RUN:=1}"

# （任意）特定注文だけテストする場合：
#   FORCE_ORDER_ID=1234 DRY_RUN=1 bash scripts/cron_buyers_thanks_5d_named.sh
: "${FORCE_ORDER_ID:=}"

export NOTIFIED_KIND="$NOTIFIED_KIND_FIXED"
export MESSAGE_FILE="$MESSAGE_FILE_FIXED"
export WINDOW_START_DAYS="$WINDOW_START_DAYS_FIXED"
export WINDOW_END_DAYS="$WINDOW_END_DAYS_FIXED"
export DEDUP_BY_USER="$DEDUP_BY_USER_FIXED"
export LIMIT="$LIMIT_FIXED"
export SLEEP_MS="$SLEEP_MS_FIXED"
export DRY_RUN
export FORCE_ORDER_ID

node scripts/send_buyers_thanks_5d_named.js

echo "[buyers_thanks_5d_named] done: $(date -Is)"
