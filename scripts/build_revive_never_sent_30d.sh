#!/usr/bin/env bash
set -euo pipefail

echo "[START] build_revive_never_sent_30d $(date -Is)"

psql "$DATABASE_URL" <<'SQL'
with last_open as (
  select
    user_id,
    max(opened_at) as last_open_at
  from liff_open_logs
  group by user_id
)
insert into segment_users (segment_key, user_id, created_at)
select
  'revive_never_sent_30d' as segment_key,
  u.user_id,
  now() as created_at
from users u
left join last_open lo
  on lo.user_id = u.user_id
where
  (
    lo.last_open_at is null
    or lo.last_open_at < now() - interval '30 days'
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
      and sb.segment_key = 'revive_never_sent_30d'
      and sb.sent_at is not null
  )
on conflict (segment_key, user_id) do nothing;
SQL

echo "[END] build_revive_never_sent_30d $(date -Is)"