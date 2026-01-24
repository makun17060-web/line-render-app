#!/usr/bin/env bash
set -x

echo "[isoya_trial_10d] start: $(date -Is)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'isoya_trial_10d_auto',
  su.user_id,
  NOW()
FROM segment_users su
LEFT JOIN segment_blast sb
  ON sb.segment_key='isoya_trial_10d_auto'
 AND sb.user_id=su.user_id
WHERE su.user_id IS NOT NULL
  AND su.user_id <> ''
  AND su.user_id ~* '^U[0-9a-f]{32}$'

  -- ✅ 10日以上（窓じゃなく“以上”）
  AND su.first_seen IS NOT NULL
  AND su.first_seen <= NOW() - INTERVAL '10 days'

  -- ✅ まだ名簿に入ってない人だけ
  AND sb.user_id IS NULL

  -- ✅ 購入者は除外
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = su.user_id
  )
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

SEGMENT_KEY=isoya_trial_10d_auto \
MESSAGE_FILE=./messages/flex.json \
ONCE_ONLY=${ONCE_ONLY:-0} \
DRY_RUN=${DRY_RUN:-1} \
node send_blast_once.js

echo "[isoya_trial_10d] done: $(date -Is)"
