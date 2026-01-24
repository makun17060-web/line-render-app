#!/usr/bin/env bash
set -x

echo "[after_sent_14d] start: $(date -Is)"

# 1) 最後に送信された配信（全segment横断）から14日経過した未購入者を名簿に入れる
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'after_sent_14d',
  su.user_id,
  NOW()
FROM segment_users su
WHERE su.user_id IS NOT NULL
  AND su.user_id <> ''
  AND su.user_id ~* '^U[0-9a-f]{32}$'   -- 正規のユーザーIDをチェック

  -- 未購入者のみ
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = su.user_id
  )

  -- 最後に送信された配信から14日経過
  AND (
    SELECT MAX(sb.sent_at)
    FROM segment_blast sb
    WHERE sb.user_id = su.user_id
      AND sb.sent_at IS NOT NULL
  ) <= NOW() - INTERVAL '14 days'

  -- すでに after_sent_14d に入っていない人だけ
  AND NOT EXISTS (
    SELECT 1 FROM segment_blast sb2
    WHERE sb2.segment_key = 'after_sent_14d'
      AND sb2.user_id = su.user_id
  );
SQL

# 2) 配信（未送信のみ）
SEGMENT_KEY=after_sent_14d \
MESSAGE_FILE=./messages/flex.json \
ONCE_ONLY=${ONCE_ONLY:-0} \
DRY_RUN=${DRY_RUN:-1} \
node send_blast_once.js

echo "[after_sent_14d] done: $(date -Is)"
