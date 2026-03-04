#!/bin/bash
set -euo pipefail

cd /opt/render/project/src

echo "=== inactive_30d roster update ==="

psql "$DATABASE_URL" <<'SQL'
insert into segment_blast (segment_key, user_id, created_at)
select
  'inactive_30d',
  u.user_id,
  now()
from segment_users u
where
(
  -- ① 一度も起動していない + 友だち追加30日以上
  (u.last_liff_open_at is null and u.first_seen < now() - interval '30 days')
  OR
  -- ② 一度起動したが30日以上開いていない
  (u.last_liff_open_at < now() - interval '30 days')
)
on conflict (segment_key, user_id) do nothing;
SQL

echo "=== send blast ==="

export SEGMENT_KEY=inactive_30d
export MESSAGE_FILE=./messages/omise_intro.json

# ✅ 送信済み除外を有効化（=スキップしない）
export SKIP_GLOBAL_EVER_SENT=0

# ✅ 送ったら二度送らない（inactive_30dを記録して除外）
export ONCE_ONLY=1

# ✅ 任意：外からDRY_RUN=1でテストできる（未指定なら0扱いでOK）
export DRY_RUN="${DRY_RUN:-0}"

node send_blast_once.js