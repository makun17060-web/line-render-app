#!/usr/bin/env bash
set -euo pipefail

echo "[START] build_revive_never_sent_30d $(date -Is)"

psql "$DATABASE_URL" <<'SQL'
insert into segment_users (segment_key, user_id, created_at)
select
  'revive_never_sent_30d' as segment_key,
  u.user_id,
  now() as created_at
from users u
where
  (
    u.last_open_at is null
    or u.last_open_at < now() - interval '30 days'
  )
  and u.user_id is not null
  and u.user_id like 'U%'
  and u.user_id not like 'UDEBUG%'
  and u.user_id not like 'Uxxxxxxxx%'
  and u.user_id not like 'TEST_%'
  and not exists (
    select 1
    from orders o
    where o.user_id = u.user_id
  )
  and not exists (
    select 1
    from segment_blast sb
    where sb.user_id = u.user_id
      and sb.sent_at is not null
  )
on conflict (segment_key, user_id) do nothing;
SQL

echo "[END] build_revive_never_sent_30d $(date -Is)"