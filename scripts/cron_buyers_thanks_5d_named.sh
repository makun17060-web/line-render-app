#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[buyers_thanks_5d_named] start: $(date -Is)"

# =========================================================
# 基本設定
# =========================================================
APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

# ---------------------------------------------------------
# 固定値（事故防止：ここは env で変えさせない）
# ---------------------------------------------------------
NOTIFIED_KIND_FIXED="buyers_thanks_5d_named"
MESSAGE_FILE_FIXED="./messages/buyers_thanks_5d_named.json"

# ---------------------------------------------------------
# デフォルト値（必要なときだけ env で上書き可）
#
# 通常運用：
#   購入後5日 → 6〜5日ウィンドウ
#
# 棚卸し運用：
#   例）30〜3日 → WINDOW_START_DAYS=30 WINDOW_END_DAYS=3
# ---------------------------------------------------------
: "${WINDOW_START_DAYS:=6}"
: "${WINDOW_END_DAYS:=5}"

# 最終購入日基準なので通常は不要だが、
# 念のための安全柵として残す（1人1通）
: "${DEDUP_BY_USER:=1}"

: "${LIMIT:=2000}"
: "${SLEEP_MS:=200}"
: "${DRY_RUN:=1}"
: "${FORCE_ORDER_ID:=}"

# =========================================================
# 環境変数 export
# =========================================================
export NOTIFIED_KIND="$NOTIFIED_KIND_FIXED"
export MESSAGE_FILE="$MESSAGE_FILE_FIXED"

export WINDOW_START_DAYS
export WINDOW_END_DAYS
export DEDUP_BY_USER
export LIMIT
export SLEEP_MS
export DRY_RUN
export FORCE_ORDER_ID

# =========================================================
# 実行
# =========================================================
node scripts/send_buyers_thanks_5d_named.js

echo "[buyers_thanks_5d_named] done: $(date -Is)"
