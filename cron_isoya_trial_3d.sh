#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[isoya_trial_3d] start: $(date -Is)"

# ===== 設定 =====
APP_DIR="/opt/render/project/src"
SEGMENT_KEY="isoya_trial_3d_auto"
MESSAGE_FILE="./messages/flex.json"

# DRY_RUN / ONCE_ONLY は外から上書き可能
: "${DRY_RUN:=1}"
: "${ONCE_ONLY:=1}"

# ===== 作業ディレクトリ =====
cd "$APP_DIR"

# ===== 依存関係（Cron では必須）=====
# node_modules が保証されないため、毎回入れる
npm ci --omit=dev

# ===== 1) 名簿作成（SQLで確実に）=====
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

  -- 3日経過（3〜4日前の窓で日次安定）
  AND su.first_seen IS NOT NULL
  AND su.first_seen >= NOW() - INTERVAL '4 days'
  AND su.first_seen <  NOW() - INTERVAL '3 days'

  -- まだ名簿に入っていない人だけ
  AND sb.user_id IS NULL

  -- 購入者は除外
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = su.user_id
  )
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# ===== 2) 送信（未送信のみ）====
SEGMENT_KEY="$SEGMENT_KEY" \
MESSAGE_FILE="$MESSAGE_FILE" \
ONCE_ONLY="$ONCE_ONLY" \
DRY_RUN="$DRY_RUN" \
node send_blast_once.js

echo "[isoya_trial_3d] done: $(date -Is)"
