#!/usr/bin/env bash
set -euo pipefail
set -x

echo "[cron_shoukai_14d] start: $(date -Is)"

APP_DIR="/opt/render/project/src"

# ▼ 今回送る配信キー（＝名簿キー）とメッセージ
SEGMENT_KEY_FIXED="shoukai_14d"
MESSAGE_FILE_FIXED="./messages/shoukai_14d.json"

# ▼ 一回配信：同じキーを除外に使う（＝二度送らない）
EXCLUDE_SENT_KEYS_FIXED="shoukai_14d"

# ▼ デフォルト（外から上書きOK）
: "${DRY_RUN:=1}"            # 1=送らない（確認） / 0=本番送信
: "${ONCE_ONLY:=0}"          # 全キー永久除外は基本OFF推奨
: "${AUTO_ROSTER_3D:=1}"     # 1=名簿自動追加を使う（このcronでは推奨）
: "${FIRST_SEEN_DAYS:=14}"   # 何日後を対象にするか（このcronでは14）
: "${SLOT:=night}"           # morning|day|night|（空なら無効）※send_blast_once.js側仕様に合わせる
: "${INCLUDE_BOUGHT:=0}"     # 1=購入者も含める / 0=除外（このcronでは0推奨）
: "${LIMIT:=20000}"          # 万一増えた時の安全上限

cd "$APP_DIR"

# --- 環境チェック（軽量・安全） ---
node -v

# ✅ デプロイ直後などで node_modules が無い場合は安全にスキップ
if [ ! -d "node_modules" ]; then
  echo "[cron_shoukai_14d] node_modules not found. skip."
  exit 0
fi

# ✅ メッセージファイル存在チェック（パス事故防止）
if [ ! -f "$MESSAGE_FILE_FIXED" ]; then
  echo "[cron_shoukai_14d] MESSAGE_FILE not found: $MESSAGE_FILE_FIXED"
  exit 1
fi

# ✅ JSON文法チェック（配信事故防止）
node -e "JSON.parse(require('fs').readFileSync('$MESSAGE_FILE_FIXED','utf8'));"

# ------------------------------------------------------------
# 1) follow基準で「ちょうど14日前〜15日前」の未購入者を名簿に入れる
#    ※ INSERT先は segment_blast（あなたの現行仕様に合わせる）
#    ※ ここは“名簿作り”なので、送信slotとは切り離してOK
# ------------------------------------------------------------
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO segment_blast (segment_key, user_id, created_at)
SELECT
  'shoukai_14d',
  fe.user_id,
  NOW()
FROM follow_events fe
LEFT JOIN segment_blast sb
  ON sb.segment_key='shoukai_14d'
 AND sb.user_id=fe.user_id
LEFT JOIN segment_users su
  ON su.user_id = fe.user_id
WHERE fe.user_id IS NOT NULL
  AND fe.user_id <> ''
  AND fe.user_id ~* '^U[0-9a-f]{32}$'
  AND fe.user_id NOT LIKE 'UDEBUG%'

  -- ✅ 14日後（「ちょうど15日前〜14日前」の窓）※follow基準
  AND fe.followed_at IS NOT NULL
  AND fe.followed_at >= NOW() - INTERVAL '15 days'
  AND fe.followed_at <  NOW() - INTERVAL '14 days'

  -- ✅ まだ名簿に入ってない人だけ
  AND sb.user_id IS NULL

  -- ✅ 購入者は除外（ordersを直接見る）
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.user_id = fe.user_id
  )

  -- ✅ もし segment_users に has_ordered があるなら、ここでも落とす（安全側）
  AND COALESCE(su.has_ordered, false) = false
ON CONFLICT (segment_key, user_id) DO NOTHING;
SQL

# ------------------------------------------------------------
# 2) 送信（未送信のみ）＋同じキー送信済みは除外（＝一回配信）
#    ✅ ここを「外から上書き可能」にして運用しやすくする
#    ✅ send_blast_once.js はプロジェクト直下にある前提
# ------------------------------------------------------------
SEGMENT_KEY="$SEGMENT_KEY_FIXED" \
MESSAGE_FILE="$MESSAGE_FILE_FIXED" \
EXCLUDE_SENT_KEYS="$EXCLUDE_SENT_KEYS_FIXED" \
ONCE_ONLY="$ONCE_ONLY" \
DRY_RUN="$DRY_RUN" \
AUTO_ROSTER_3D="$AUTO_ROSTER_3D" \
FIRST_SEEN_DAYS="$FIRST_SEEN_DAYS" \
SLOT="$SLOT" \
INCLUDE_BOUGHT="$INCLUDE_BOUGHT" \
LIMIT="$LIMIT" \
node send_blast_once.js

echo "[cron_shoukai_14d] done: $(date -Is)"
