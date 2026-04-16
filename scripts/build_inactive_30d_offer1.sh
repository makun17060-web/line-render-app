cat > ./scripts/build_inactive_30d_offer1.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

SEGMENT_KEY="${SEGMENT_KEY:-inactive_30d_offer1}"

echo "[START] build_${SEGMENT_KEY} $(date -Is)"

psql "$DATABASE_URL" <<SQL
with last_open as (
  select
    user_id,
    max(opened_at) as last_open_at
  from liff_open_logs
  where user_id is not null
  group by user_id
),
targets as (
  select
    u.user_id
  from users u
  left join last_open lo
    on lo.user_id = u.user_id
  where
    (
      lo.last_open_at is null
      or lo.last_open_at < now() - interval '30 days'
    )
    and u.user_id is not null
    and u.user_id ~ '^U[0-9a-fA-F]{32}$'
    and not exists (
      select 1
      from orders o
      where o.user_id = u.user_id
        and (
          (o.payment_method in ('card', 'stripe') and o.status = 'paid')
          or (o.payment_method = 'cod' and o.status = 'confirmed')
          or (o.payment_method = 'pickup_cash' and o.status = 'pickup')
          or (
            o.payment_method not in ('card', 'stripe', 'cod', 'pickup_cash')
            and o.status in ('paid', 'confirmed', 'pickup')
          )
        )
    )
    and not exists (
      select 1
      from segment_blast sb
      where sb.user_id = u.user_id
        and sb.segment_key = '${SEGMENT_KEY}'
        and sb.sent_at is not null
    )
)
insert into segment_blast (segment_key, user_id, created_at)
select
  '${SEGMENT_KEY}' as segment_key,
  t.user_id,
  now() as created_at
from targets t
on conflict (segment_key, user_id) do nothing;
SQL

echo "[END] build_${SEGMENT_KEY} $(date -Is)"
EOF
chmod +x ./scripts/build_inactive_30d_offer1.sh