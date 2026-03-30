#!/usr/bin/env bash
set -euo pipefail

echo "[START] build_buyers_repeat_offer $(date -Is)"

APP_DIR="/opt/render/project/src"
cd "$APP_DIR"

SEGMENT_KEY="${SEGMENT_KEY:-buyers_repeat_offer}"

if [ -f ./.env ]; then
  set -a
  . ./.env
  set +a
fi

psql "$DATABASE_URL" <<SQL
BEGIN;

CREATE TABLE IF NOT EXISTS segment_users (
  segment_key text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_key, user_id)
);

WITH order_counts AS (
  SELECT
    o.user_id,
    COUNT(*)::int AS order_count,
    MAX(o.created_at) AS last_order_at
  FROM orders o
  WHERE o.user_id IS NOT NULL
    AND o.user_id <> ''
    AND o.user_id NOT LIKE 'TEST_%'
    AND COALESCE(o.status, '') NOT IN ('cancelled', 'canceled')
  GROUP BY o.user_id
),
target_users AS (
  SELECT
    oc.user_id
  FROM order_counts oc
  WHERE oc.order_count >= 2
),
exclude_sent AS (
  SELECT DISTINCT sb.user_id
  FROM segment_blast sb
  WHERE sb.segment_key = '${SEGMENT_KEY}'
    AND sb.sent_at IS NOT NULL
)
INSERT INTO segment_users (segment_key, user_id)
SELECT
  '${SEGMENT_KEY}',
  tu.user_id
FROM target_users tu
LEFT JOIN exclude_sent es
  ON es.user_id = tu.user_id
LEFT JOIN segment_users su
  ON su.segment_key = '${SEGMENT_KEY}'
 AND su.user_id = tu.user_id
WHERE es.user_id IS NULL
  AND su.user_id IS NULL;

COMMIT;
SQL

echo "[END] build_buyers_repeat_offer $(date -Is)"