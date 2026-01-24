#!/usr/bin/env bash
set -x

echo "[isoya_trial_10d] start: $(date -Is)"

# 1) 友だち追加（first_seen）から10日経過した未購入者を名簿に入れる
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'isoya_trial_10d_auto',
  su.user_id,
  NOW()
FROM segment_users su
WHERE su.user_id IS NOT NULL
  AND su.user_id <> ''
  AND su.user_id ~* '^U[0-9a-f]{32}$'   -- 正規のユーザーIDをチェック

  -- ✅ 友だち追加から10日経過
  AND su.first_seen IS NOT NULL
  AND su.first_seen >= NOW() - INTERVAL '11 days'
  AND su.first_seen < NOW() - INTERVAL '10 days'

  -- ✅ まだ名簿に入っていない人だけ（ここが重要）
  AND NOT EXISTS (
    SELECT 1 FROM segment_blast sb
    WHERE sb.segment_key = 'isoya_trial_10d_auto'
      AND sb.user_id = su.user_id
  )

  -- ✅ 購入者は除外
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = su.user_id
  )
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# 2) 送信（未送信のみ）
SEGMENT_KEY=isoya_trial_10d_auto \
MESSAGE_FILE=./messages/flex.json \
ONCE_ONLY=${ONCE_ONLY:-0} \
DRY_RUN=${DRY_RUN:-1} \
node send_blast_once.js

echo "[isoya_trial_10d] done: $(date -Is)"
