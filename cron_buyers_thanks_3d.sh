#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

# 1) 購入3日後（カード/代引/店頭）を名簿に追加
psql "$DATABASE_URL" <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'buyers_thanks_3d' AS segment_key,
  o.user_id,
  now()
FROM orders o
WHERE o.user_id IS NOT NULL
  AND o.status IN ('paid','confirmed','pickup')
  AND o.created_at >= now() - interval '4 days'
  AND o.created_at <  now() - interval '3 days'
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# 2) 未送信にだけ送る（1回だけ）
SEGMENT_KEY=buyers_thanks_3d \
MESSAGE_FILE=./messages/buyers_thanks_3d.json \
ONCE_ONLY=1 \
node send_blast_once.js
