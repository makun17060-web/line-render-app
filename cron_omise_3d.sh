#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_omise_3d] start: $(date -Is)"

APP_DIR="/opt/render/project/src"

# ▼ 今回送る配信キー（＝名簿キー）とメッセージ
SEGMENT_KEY_FIXED="omise_3d"
MESSAGE_FILE_FIXED="./messages/omise_3d.json"

# ▼ 一回配信：同じキーを除外に使う（＝二度送らない）
EXCLUDE_SENT_KEYS_FIXED="omise_3d"

: "${DRY_RUN:=1}"     # 1=送らない（確認） / 0=本番送信
: "${ONCE_ONLY:=0}"   # 全キー永久除外は基本OFF推奨

cd "$APP_DIR"

# Cron環境の pg 事故防止（node_modules保証）
npm ci --omit=dev

# 1) 友だち追加(followed_at)から3日経過した未購入者を名簿(omise_3d)に入れる（3〜4日前の窓）
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'omise_3d',
  fe.user_id,
  NOW()
FROM follow_events fe
LEFT JOIN segment_blast sb
  ON sb.segment_key='omise_3d'
 AND sb.user_id=fe.user_id
LEFT JOIN segment_users su
  ON su.user_id = fe.user_id
WHERE fe.user_id IS NOT NULL
  AND fe.user_id <> ''
  AND fe.user_id ~* '^U[0-9a-f]{32}$'
  AND fe.user_id NOT LIKE 'UDEBUG%'

  -- ✅ 3日後（「ちょうど3日前〜4日前」の窓）※follow基準
  AND fe.followed_at IS NOT NULL
  AND fe.followed_at >= NOW() - INTERVAL '4 days'
  AND fe.followed_at <  NOW() - INTERVAL '3 days'

  -- ✅ まだ名簿に入ってない人だけ
  AND sb.user_id IS NULL

  -- ✅ 購入者は除外（segment_users が無い人もいるので orders を直接見る）
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = fe.user_id
  )

  -- ✅ もし segment_users に has_ordered があるなら、ここでも落とせる（安全側）
  AND COALESCE(su.has_ordered, false) = false
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# 2) 送信（未送信のみ）＋同じキー送信済みは除外（＝一回配信）
SEGMENT_KEY="$SEGMENT_KEY_FIXED" \
MESSAGE_FILE="$MESSAGE_FILE_FIXED" \
EXCLUDE_SENT_KEYS="$EXCLUDE_SENT_KEYS_FIXED" \
ONCE_ONLY="$ONCE_ONLY" \
DRY_RUN="$DRY_RUN" \
AUTO_ROSTER_3D=0 \
node send_blast_once.js

echo "[cron_omise_3d] done: $(date -Is)"
