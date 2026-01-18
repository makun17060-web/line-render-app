#!/usr/bin/env bash
set -euo pipefail

echo "[omise_10d] start: $(date -Is)"

# 1) 友だち追加から10日経過した人を名簿に入れる
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'omise_10d',
  su.user_id,
  NOW()
FROM segment_users su
LEFT JOIN segment_blast sb
  ON sb.segment_key = 'omise_10d'
 AND sb.user_id = su.user_id
WHERE su.user_id IS NOT NULL
  AND su.user_id <> ''
  AND su.user_id ~* '^U[0-9a-f]{32}$'
  AND su.first_seen <= NOW() - INTERVAL '10 days'
  AND sb.sent_at IS NULL
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# 2) Flex を送信（未送信のみ）
SEGMENT_KEY=omise_10d \
MESSAGE_FILE=./messages/omise_10d.json \
ONCE_ONLY=${ONCE_ONLY:-0} \
DRY_RUN=${DRY_RUN:-0} \
node send_blast_once.js

echo "[omise_10d] done: $(date -Is)"
