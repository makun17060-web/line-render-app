#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_ohanami_openers_0320] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

# =========================
# 固定値（事故防止）
# =========================
SEGMENT_KEY_FIXED="ohanami_2026_openers_0320"
MESSAGE_FILE_FIXED="./messages/season_spring_hanami.json"
ASOF_ISO_FIXED="2026-03-21T00:00:00+09:00"   # 3/20 JST 終了まで

# =========================
# 実行オプション
# =========================
: "${DRY_RUN:=1}"        # 1=送らない / 0=本番
: "${LIMIT:=20000}"
: "${BATCH_SIZE:=500}"
: "${SLEEP_MS:=200}"

echo "DRY_RUN=$DRY_RUN"
echo "SEGMENT_KEY_FIXED=$SEGMENT_KEY_FIXED"
echo "MESSAGE_FILE_FIXED=$MESSAGE_FILE_FIXED"
echo "ASOF_ISO_FIXED=$ASOF_ISO_FIXED"

# =========================
# ① 3/20時点 起動者名簿を segment_blast に確定
# =========================
SEGMENT_KEY="$SEGMENT_KEY_FIXED" \
ASOF_ISO="$ASOF_ISO_FIXED" \
node scripts/roster_openers_asof_to_blast.js

# =========================
# ② 名簿に対して送信
#    ・AUTO_ROSTERしない
#    ・グローバル ever_sent 除外を使わない
#    ・購入者も含める
# =========================
DRY_RUN="$DRY_RUN" \
AUTO_ROSTER_3D=0 \
SEGMENT_KEY="$SEGMENT_KEY_FIXED" \
MESSAGE_FILE="$MESSAGE_FILE_FIXED" \
\
# ▼ このキーでの二重送信だけ防ぐ
EXCLUDE_SENT_KEYS="$SEGMENT_KEY_FIXED" \
\
# ▼ 超重要：グローバル除外を完全にOFF
ONCE_ONLY=0 \
SKIP_GLOBAL_EVER_SENT=1 \
\
# ▼ 超重要：購入者も含める（send_blast_once.js 側で拾われる前提）
INCLUDE_BOUGHT=1 \
INCLUDE_HAS_ORDERED=1 \
\
LIMIT="$LIMIT" \
BATCH_SIZE="$BATCH_SIZE" \
SLEEP_MS="$SLEEP_MS" \
node send_blast_once.js

echo "[cron_ohanami_openers_0320] done: $(date -Is)"
