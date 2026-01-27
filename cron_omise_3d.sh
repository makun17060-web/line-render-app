#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[isoya_trial_3d] start: $(date -Is)"

APP_DIR="/opt/render/project/src"
SEGMENT_KEY_FIXED="isoya_trial_3d_auto"
MESSAGE_FILE_FIXED="./messages/flex.json"

: "${DRY_RUN:=1}"     # 1=送らない（確認） / 0=本番送信
: "${ONCE_ONLY:=0}"   # いまの send_blast_once.js では基本0でOK（global除外はしない運用）

cd "$APP_DIR"

# Cron環境では node_modules が保証されないので毎回入れる（pgエラー防止）
npm ci --omit=dev

# 1) 友だち追加(first_seen)から3日経過した未購入者を名簿に入れる（3〜4日前の窓で日次安定）
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'isoya_trial_3d_auto',
  su.user_id,
  NOW()
FROM segment_users su
LEFT JOIN segment_blast sb
  ON sb.segment_key='isoya_trial_3d_auto'
 AND sb.user_id=su.user_id
WHERE su.user_id IS NOT NULL
  AND su.user_id <> ''
  AND su.user_id ~* '^U[0-9a-f]{32}$'

  -- ✅ 3日後（「ちょうど3日前〜4日前」の窓）
  AND su.first_seen IS NOT NULL
  AND su.first_seen >= NOW() - INTERVAL '4 days'
  AND su.first_seen <  NOW() - INTERVAL '3 days'

  -- ✅ まだ名簿に入ってない人だけ
  AND sb.user_id IS NULL

  -- ✅ 購入者は除外（ordersが1件でもあれば除外）
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = su.user_id
  )
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# 2) 送信（未送信のみ）
SEGMENT_KEY="$SEGMENT_KEY_FIXED" \
MESSAGE_FILE="$MESSAGE_FILE_FIXED" \
ONCE_ONLY="$ONCE_ONLY" \
DRY_RUN="$DRY_RUN" \
node send_blast_once.js

echo "[isoya_trial_3d] done: $(date -Is)"
