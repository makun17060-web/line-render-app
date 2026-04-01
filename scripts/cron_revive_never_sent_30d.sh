#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

LOG_FILE="$APP_DIR/logs/revive_never_sent_30d.log"

log() {
  echo "[$(date -Is)] $1" | tee -a "$LOG_FILE"
}

log "START"

# ① セグメント作成
bash ./scripts/build_revive_never_sent_30d.sh >> "$LOG_FILE" 2>&1

# ② 配信
SEGMENT_KEY=revive_never_sent_30d \
MESSAGE_FILE=./messages/omise_intro.json \
SKIP_GLOBAL_EVER_SENT=1 \
INCLUDE_BOUGHT=0 \
BLAST_LIMIT=50 \
node scripts/send_blast_once.js >> "$LOG_FILE" 2>&1

log "END"