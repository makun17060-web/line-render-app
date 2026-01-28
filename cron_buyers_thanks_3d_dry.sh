#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

echo "=== DRY RUN: buyers_thanks_3d ==="
echo "Time: $(date)"

psql "$DATABASE_URL" <<'SQL'
SELECT
  o.user_id,
  o.status,
  o.created_at
FROM orders o
WHERE o.user_id IS NOT NULL
  AND o.status IN ('paid','confirmed','pickup')
  AND o.created_at >= now() - interval '4 days'
  AND o.created_at <  now() - interval '3 days'
ORDER BY o.created_at;
SQL

echo "=== END DRY RUN ==="
