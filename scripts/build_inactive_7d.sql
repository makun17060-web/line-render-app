-- 7日以上未起動・未購入・未送信を segment_blast に投入

WITH last_open AS (
  SELECT
    l.user_id,
    MAX(l.opened_at) AS last_open_at
  FROM public.liff_open_logs l
  WHERE l.user_id IS NOT NULL
    AND l.user_id <> ''
    AND l.user_id NOT LIKE 'TEST_%'
    AND l.user_id <> 'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  GROUP BY l.user_id
),
targets AS (
  SELECT lo.user_id
  FROM last_open lo
  LEFT JOIN (
    SELECT DISTINCT user_id
    FROM orders
    WHERE user_id IS NOT NULL
      AND user_id <> ''
  ) b ON b.user_id = lo.user_id
  LEFT JOIN (
    SELECT DISTINCT user_id
    FROM segment_blast
    WHERE segment_key = 'inactive_7d'
      AND sent_at IS NOT NULL
  ) s ON s.user_id = lo.user_id
  WHERE lo.last_open_at < NOW() - INTERVAL '7 days'
    AND b.user_id IS NULL
    AND s.user_id IS NULL
)
INSERT INTO segment_blast (segment_key, user_id, sent_at, created_at)
SELECT 'inactive_7d', t.user_id, NULL, NOW()
FROM targets t
LEFT JOIN segment_blast sb
  ON sb.segment_key = 'inactive_7d'
 AND sb.user_id = t.user_id
 AND sb.sent_at IS NULL
WHERE sb.user_id IS NULL;