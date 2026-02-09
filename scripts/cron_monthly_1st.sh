#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_monthly_1st] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

: "${DRY_RUN:=1}"
: "${LIMIT:=20000}"

# 友だち追加から何日以上の人に定期を始めるか
: "${MIN_FOLLOW_DAYS:=21}"

# 24時間ルール
: "${COOLDOWN_HOURS:=24}"

# 起動者だけにしたいなら 1（最初は0でOK）
: "${ONLY_OPENERS:=0}"
: "${OPENED_WITHIN_DAYS:=365}"

export NOTIFIED_KIND="monthly_1st"
export PRIORITY="10"
export MESSAGE_FILE="./messages/monthly_1st.txt"

node -v

# node_modulesが無い/デプロイ直後などは安全にスキップ
if [ ! -d "node_modules" ]; then
  echo "[cron_monthly_1st] node_modules missing. skip."
  exit 0
fi

DRY_RUN="$DRY_RUN" \
LIMIT="$LIMIT" \
MIN_FOLLOW_DAYS="$MIN_FOLLOW_DAYS" \
COOLDOWN_HOURS="$COOLDOWN_HOURS" \
ONLY_OPENERS="$ONLY_OPENERS" \
OPENED_WITHIN_DAYS="$OPENED_WITHIN_DAYS" \
NOTIFIED_KIND="$NOTIFIED_KIND" \
PRIORITY="$PRIORITY" \
MESSAGE_FILE="$MESSAGE_FILE" \
node scripts/send_monthly_1st.js

echo "[cron_monthly_1st] done: $(date -Is)"
