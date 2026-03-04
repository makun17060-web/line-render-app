#!/bin/bash
set -e

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
    u.last_liff_open_at is null
    or u.last_liff_open_at < now() - interval '30 days'
  )
on conflict (segment_key, user_id) do nothing;
SQL

echo "=== send blast ==="

export SEGMENT_KEY=inactive_30d
export MESSAGE_FILE=./messages/omise_intro.json
export SKIP_GLOBAL_EVER_SENT=1

node send_blast_once.js