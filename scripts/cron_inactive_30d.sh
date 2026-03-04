#!/bin/bash
set -euo pipefail

cd /opt/render/project/src

SEGMENT_KEY="inactive_30d"
MESSAGE_FILE="./messages/omise_intro.json"

# 送信後の「他キー送信済み」除外を無効化（= 他キーで送ってても inactive_30d の対象に入れる）
export SKIP_GLOBAL_EVER_SENT=1

# 既定は購入者を除外（必要なら INCLUDE_BOUGHT=1 に変更）
export INCLUDE_BOUGHT="${INCLUDE_BOUGHT:-0}"

# DRY_RUN=1 のときは送信しない（ログだけ）
export DRY_RUN="${DRY_RUN:-0}"

echo "=== [cron_inactive_30d] start $(date -Iseconds) ==="
echo "SEGMENT_KEY=${SEGMENT_KEY}"
echo "MESSAGE_FILE=${MESSAGE_FILE}"
echo "DRY_RUN=${DRY_RUN}"
echo "INCLUDE_BOUGHT=${INCLUDE_BOUGHT}"
echo "SKIP_GLOBAL_EVER_SENT=${SKIP_GLOBAL_EVER_SENT}"

echo "=== roster update (segment_blast upsert) ==="
psql "$DATABASE_URL" <<SQL
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  '${SEGMENT_KEY}',
  u.user_id,
  now()
FROM segment_users u
WHERE
  u.user_id IS NOT NULL
  AND (
    -- ① 一度も起動していない + 友だち追加30日以上
    (u.last_liff_open_at IS NULL AND u.first_seen < now() - interval '30 days')
    OR
    -- ② 一度起動したが30日以上開いていない
    (u.last_liff_open_at < now() - interval '30 days')
  )
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

echo "=== send blast ==="
export SEGMENT_KEY="${SEGMENT_KEY}"
export MESSAGE_FILE="${MESSAGE_FILE}"

# テスト時に「少数だけ送りたい」なら BLAST_LIMIT を環境変数で渡せるようにする
# 例: DRY_RUN=1 BLAST_LIMIT=5 scripts/cron_inactive_30d.sh
if [[ -n "${BLAST_LIMIT:-}" ]]; then
  export BLAST_LIMIT
  export BLAST_OFFSET="${BLAST_OFFSET:-0}"
  echo "BLAST_LIMIT=${BLAST_LIMIT} BLAST_OFFSET=${BLAST_OFFSET}"
fi

node send_blast_once.js

echo "=== [cron_inactive_30d] end $(date -Iseconds) ==="