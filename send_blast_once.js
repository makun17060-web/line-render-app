// send_blast_once.js —（名簿自動追加 + 未送信 + 未購入 + キー指定除外 + FORCE_USER_ID +
// ✅ 注文ID指定(FORCE_ORDER_ID) + ✅購入者直抽出(BUYER_KIND)）Text/Flex 切替版
//
// Run:
//   SEGMENT_KEY=... MESSAGE_FILE=... FUKUBAKO_ID=fukubako-2026 node send_blast_once.js
//
// Optional:
//   DRY_RUN=1                  (送信せず対象件数だけ表示)
//   AUTO_ROSTER_3D=1           (FIRST_SEEN_DAYS 経過した友だちを名簿に入れる)
//   FIRST_SEEN_DAYS=3
//   ONCE_ONLY=0/1              (※従来: 全キー横断の永久除外。あなたの運用では基本0推奨)
//   EXCLUDE_SENT_KEYS="k1,k2"  (✅ これらのキーで sent_at があるユーザーを除外)
//
// ✅ 朝/昼/夜 の時間帯ブロック配信（sh/コマンドで渡す）
//   SLOT=morning|day|night
//
// ✅ お花見など「例外運用」用スイッチ（sh/コマンドで渡す）
//   SKIP_GLOBAL_EVER_SENT=1
//   INCLUDE_BOUGHT=1
//
// ✅ 購入者配信（名簿不要：ordersから抽出）
//   BUYER_KIND=card|cod|pickup|all
//   BUYER_DAYS=30
//
// ✅ 自分テスト用（強制1ユーザー送信）
//   FORCE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// ✅【追加】注文IDで強制1ユーザー送信（最優先）
//   FORCE_ORDER_ID=284
//   ※ FORCE_USER_ID も同時に指定された場合は一致チェック。不一致なら停止。
//
// ✅【追加】50人ずつテスト送信（最終ターゲット配列をスライス）
//   BLAST_LIMIT=50
//   BLAST_OFFSET=0   (次の50なら 50, 100 ...)
//   ※ segment_blast の名簿自体はそのまま、送る直前に 50 人に絞るだけ
//
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN
//
// MESSAGE_FILE の形式：
//   - JSON配列: [ {message}, {message} ... ]
//   - または: { "messages": [ ... ] }

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SEGMENT_KEY   = (process.env.SEGMENT_KEY || "fukubako_3d").trim();
const TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL         = process.env.DATABASE_URL;

const MESSAGE_FILE  = (process.env.MESSAGE_FILE || "./messages/flex.json").trim(); // 既定：flex.json
const DRY_RUN       = String(process.env.DRY_RUN || "").trim() === "1";

const AUTO_ROSTER_3D  = String(process.env.AUTO_ROSTER_3D || "").trim() === "1";
const FIRST_SEEN_DAYS = Number(process.env.FIRST_SEEN_DAYS || 3);

// ✅ 朝/昼/夜ブロック（指定なし/空なら全員）
const SLOT = (process.env.SLOT || "").trim(); // "morning" | "day" | "night" | ""

// ✅ 購入者直抽出モード（名簿不要）
const BUYER_KIND = (process.env.BUYER_KIND || "").trim(); // card | cod | pickup | all | ""
const BUYER_DAYS = Number(process.env.BUYER_DAYS || 0);   // 0なら絞らない

const FUKUBAKO_ID   = (process.env.FUKUBAKO_ID || "fukubako-2026").trim();
const FUKUBAKO_URL  = (process.env.FUKUBAKO_URL || "").trim();

// ✅ 一生1回のみ（全キー横断）
const ONCE_ONLY = String(process.env.ONCE_ONLY || "1").trim() !== "0";

// ✅ キー指定除外（このキー送信済みユーザーを除外）
const EXCLUDE_SENT_KEYS = (process.env.EXCLUDE_SENT_KEYS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ✅ 自分テスト用：強制ターゲット（user_id）
const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim();

// ✅【追加】注文IDで強制ターゲット（order_id）
const FORCE_ORDER_ID = (process.env.FORCE_ORDER_ID || "").trim();

// ✅【追加】sh から動的に切り替えるスイッチ
const SKIP_GLOBAL_EVER_SENT = String(process.env.SKIP_GLOBAL_EVER_SENT || "").trim() === "1";
const INCLUDE_BOUGHT        = String(process.env.INCLUDE_BOUGHT || "").trim() === "1";

// ✅【追加】送信対象を最後に 50 人などに絞る（テスト用）
const BLAST_LIMIT  = Number(process.env.BLAST_LIMIT || 0);   // 0なら無制限
const BLAST_OFFSET = Number(process.env.BLAST_OFFSET || 0);  // 0なら先頭から

// ✅【従来互換】KEYごとに「global除外(ever_sent all keys)」をスキップしたい場合
const SKIP_GLOBAL_EVER_SENT_KEYS = new Set([
  "buyers_thanks_3d",
]);

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!FUKUBAKO_ID) throw new Error("FUKUBAKO_ID is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

// Node 18+ は fetch あり。無い環境なら node-fetch を入れる必要あり。
async function lineMulticast(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`LINE multicast failed: ${res.status} ${text}`);
  return text;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mustString(x, name) {
  if (typeof x !== "string" || x.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return x.trim();
}

// ✅ LINE userId 妥当性チェック（事故防止）
function isValidLineUserId(uid) {
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
}

// messages を外部JSONから読み込む
function loadMessages() {
  if (!MESSAGE_FILE) {
    const text =
`【ご案内】
こちらから購入できます👇
${FUKUBAKO_URL || "（URL未設定：FUKUBAKO_URLを指定してください）"}`;

    return [{ type: "text", text }];
  }

  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) throw new Error(`MESSAGE_FILE not found: ${fp}`);

  const raw = fs.readFileSync(fp, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MESSAGE_FILE JSON parse failed: ${e.message}`);
  }

  const msgs = Array.isArray(json) ? json : json?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error(`MESSAGE_FILE format invalid. Use: [..] or {"messages":[..]}`);
  }

  // 軽いバリデーション（事故防止）
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== "object") throw new Error(`messages[${i}] must be an object`);
    const type = mustString(m.type, `messages[${i}].type`);

    if (type === "text") {
      mustString(m.text, `messages[${i}].text`);
    } else if (type === "flex") {
      mustString(m.altText, `messages[${i}].altText`);
      if (!m.contents || typeof m.contents !== "object") throw new Error(`messages[${i}].contents is required`);
    } else if (type === "image") {
      mustString(m.originalContentUrl, `messages[${i}].originalContentUrl`);
      mustString(m.previewImageUrl, `messages[${i}].previewImageUrl`);
    } else {
      throw new Error(`Unsupported message type: ${type} (allowed: text, flex, image)`);
    }
  }

  return msgs;
}

// ✅ 購入済み判定（orders.items が jsonb）
function buildAlreadyBoughtSQL() {
  return `
    SELECT DISTINCT o.user_id
      FROM orders o
     WHERE o.user_id IS NOT NULL
       AND o.user_id <> ''
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(o.items) = 'array' THEN o.items
               WHEN jsonb_typeof(o.items) = 'object' AND jsonb_typeof(o.items->'items') = 'array' THEN o.items->'items'
               ELSE '[]'::jsonb
             END
           ) elem
          WHERE (elem->>'id') = $1
       )
  `;
}

// ✅ 「一生1回のみ」：過去に “どのキーでも” 1回でも送った user を永久除外（全キー横断）
async function loadEverSentSetAll() {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT user_id
      FROM segment_blast
     WHERE user_id IS NOT NULL
       AND user_id <> ''
       AND sent_at IS NOT NULL
    `
  );
  return new Set(rows.map(r => r.user_id).filter(Boolean));
}

// ✅ EXCLUDE_SENT_KEYS：指定キーで送信済み（sent_at not null）の user を除外
async function loadSentSetForKeys(keys) {
  if (!keys || keys.length === 0) return new Set();
  const { rows } = await pool.query(
    `
    SELECT DISTINCT user_id
      FROM segment_blast
     WHERE segment_key = ANY($1::text[])
       AND user_id IS NOT NULL
       AND user_id <> ''
       AND sent_at IS NOT NULL
    `,
    [keys]
  );
  return new Set(rows.map(r => r.user_id).filter(Boolean));
}

// ✅ 友だち追加（follow_events.followed_at）からN日経過した人を名簿に入れる（送信は別）
async function autoRosterByFirstSeen(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`FIRST_SEEN_DAYS invalid: ${days}`);

  const r = await pool.query(
    `
    WITH first_follow AS (
      SELECT DISTINCT ON (fe.user_id)
        fe.user_id,
        fe.followed_at AS first_followed_at
      FROM follow_events fe
      WHERE fe.user_id IS NOT NULL
        AND fe.user_id <> ''
        AND fe.followed_at IS NOT NULL
      ORDER BY fe.user_id, fe.followed_at ASC
    ),
    cand AS (
      SELECT ff.user_id
      FROM first_follow ff
      WHERE ff.first_followed_at <= NOW() - ($2::text || ' days')::interval
    )
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, c.user_id, NOW()
    FROM cand c
    ON CONFLICT (segment_key, user_id) DO NOTHING
    RETURNING user_id
    `,
    [SEGMENT_KEY, String(d)]
  );

  return r.rowCount || 0;
}

// ✅ FORCE 用：送信記録を必ず segment_blast に残す（なければ作る）
async function markSentForForceUser(userId, ok, errMsg) {
  const msg = errMsg ? String(errMsg).slice(0, 500) : null;

  await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [SEGMENT_KEY, userId]
  );

  if (ok) {
    await pool.query(
      `
      UPDATE segment_blast
         SET sent_at = NOW(),
             last_error = NULL
       WHERE segment_key = $1
         AND user_id = $2
      `,
      [SEGMENT_KEY, userId]
    );
  } else {
    await pool.query(
      `
      UPDATE segment_blast
         SET last_error = $3
       WHERE segment_key = $1
         AND user_id = $2
      `,
      [SEGMENT_KEY, userId, msg || "FORCE_SEND_FAILED"]
    );
  }
}

// ✅ BUYER_KIND 用：orders から購入者を抽出（名簿不要）
async function loadBuyerIds(kind, days) {
  const k = String(kind || "").trim();
  if (!k) return [];

  const d = Number(days || 0);
  const whereDays = (Number.isFinite(d) && d > 0)
    ? `AND created_at >= NOW() - ($2::text || ' days')::interval`
    : ``;

  const sql = `
    WITH last_buy AS (
      SELECT DISTINCT ON (user_id)
        user_id, payment_method, status, created_at AS last_order_at
      FROM orders
      WHERE user_id IS NOT NULL
        AND user_id <> ''
        AND status IN ('paid','confirmed','pickup')
        ${whereDays}
      ORDER BY user_id, created_at DESC
    )
    SELECT user_id
    FROM last_buy
    WHERE
      CASE
        WHEN $1 = 'card' THEN (status='paid' AND payment_method IN ('card','stripe'))
        WHEN $1 = 'cod'  THEN (status='confirmed' AND payment_method='cod')
        WHEN $1 = 'pickup' THEN (status='pickup' AND payment_method='pickup_cash')
        WHEN $1 = 'all' THEN (
          (status='paid' AND payment_method IN ('card','stripe'))
          OR (status='confirmed' AND payment_method='cod')
          OR (status='pickup' AND payment_method='pickup_cash')
        )
        ELSE FALSE
      END
    ORDER BY user_id
    LIMIT 20000
  `;

  const params = (Number.isFinite(d) && d > 0) ? [k, String(d)] : [k];
  const { rows } = await pool.query(sql, params);
  return rows.map(r => r.user_id).filter(Boolean);
}

// ✅ BUYER_KIND 用：送信台帳（segment_blast）に行を作る
async function ensureBlastRows(segmentKey, userIds) {
  if (!userIds || userIds.length === 0) return 0;

  const { rowCount } = await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, x, NOW()
    FROM unnest($2::text[]) AS x
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [segmentKey, userIds]
  );
  return rowCount || 0;
}

// ✅【追加】注文ID → user_id 解決（FORCE_ORDER_ID）
async function resolveUserIdFromOrderId(orderId) {
  const oid = Number(orderId);
  if (!Number.isFinite(oid) || oid <= 0) throw new Error(`FORCE_ORDER_ID invalid: ${orderId}`);

  const r = await pool.query(`select user_id from orders where id = $1`, [oid]);
  const uid = (r.rows?.[0]?.user_id || "").trim();
  return uid; // 空の可能性あり
}

(async () => {
  const messages = loadMessages();

  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE || "(default)"}`);
  console.log(`FUKUBAKO_ID=${FUKUBAKO_ID}`);
  console.log(`FUKUBAKO_URL=${FUKUBAKO_URL || "(none)"}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);

  console.log(`AUTO_ROSTER_3D=${AUTO_ROSTER_3D ? "1" : "0"} FIRST_SEEN_DAYS=${FIRST_SEEN_DAYS}`);
  console.log(`ONCE_ONLY=${ONCE_ONLY ? "1" : "0"} (global)`);
  console.log(`EXCLUDE_SENT_KEYS=${EXCLUDE_SENT_KEYS.length ? EXCLUDE_SENT_KEYS.join(",") : "(none)"}`);

  console.log(`FORCE_ORDER_ID=${FORCE_ORDER_ID || "(none)"}`);
  console.log(`FORCE_USER_ID=${FORCE_USER_ID || "(none)"}`);

  console.log(`BUYER_KIND=${BUYER_KIND || "(none)"} BUYER_DAYS=${BUYER_DAYS || "(none)"}`);
  console.log(`SLOT=${SLOT || "(none)"}`);

  const skipGlobalEverSent = SKIP_GLOBAL_EVER_SENT || SKIP_GLOBAL_EVER_SENT_KEYS.has(SEGMENT_KEY);
  console.log(`SKIP_GLOBAL_EVER_SENT=${skipGlobalEverSent ? "1" : "0"} (keys=${[...SKIP_GLOBAL_EVER_SENT_KEYS].join(",")})`);
  console.log(`INCLUDE_BOUGHT=${INCLUDE_BOUGHT ? "1" : "0"}`);

  // ✅ 追加：BLAST_LIMIT/OFFSET ログ
  const blastLimit = (Number.isFinite(BLAST_LIMIT) && BLAST_LIMIT > 0) ? BLAST_LIMIT : 0;
  const blastOffset = (Number.isFinite(BLAST_OFFSET) && BLAST_OFFSET > 0) ? BLAST_OFFSET : 0;
  console.log(`BLAST_LIMIT=${blastLimit || "(none)"} BLAST_OFFSET=${blastOffset || 0}`);

  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // ============================================================
  // ✅ FORCE MODE（最優先）：FORCE_ORDER_ID → user_id → 送信
  //   優先順位：FORCE_ORDER_ID > FORCE_USER_ID
  //   両方指定時：不一致なら停止（事故防止）
  // ============================================================
  let forceUid = FORCE_USER_ID;

  if (FORCE_ORDER_ID) {
    console.log("=== FORCE ORDER MODE ===");
    console.log(`FORCE_ORDER_ID=${FORCE_ORDER_ID}`);

    const uidFromOrder = await resolveUserIdFromOrderId(FORCE_ORDER_ID);
    if (!uidFromOrder) {
      console.log(`No user_id for order id=${FORCE_ORDER_ID} (nothing to send).`);
      await pool.end();
      return;
    }

    if (FORCE_USER_ID && uidFromOrder !== FORCE_USER_ID.trim()) {
      throw new Error(`FORCE mismatch: order(${FORCE_ORDER_ID})=>${uidFromOrder} but FORCE_USER_ID=${FORCE_USER_ID}`);
    }

    forceUid = uidFromOrder;
    console.log(`FORCE_ORDER_ID resolved user_id=${forceUid}`);
  }

  if (forceUid) {
    if (!isValidLineUserId(forceUid)) {
      throw new Error(`FORCE user_id invalid: ${forceUid}`);
    }

    console.log("=== FORCE MODE ===");
    console.log(`force_targets=1 (${forceUid})`);

    if (DRY_RUN) {
      console.log("DRY_RUN=1 so not sending (FORCE MODE).");
      await pool.end();
      return;
    }

    try {
      await lineMulticast([forceUid], messages);
      await markSentForForceUser(forceUid, true, null);
      console.log("OK force send: 1");
    } catch (e) {
      await markSentForForceUser(forceUid, false, e?.message || e);
      console.error("NG force send:", e?.message || e);
      throw e;
    }

    await pool.end();
    return;
  }

  // ============================================================
  // 通常モード（既存のまま）
  // ============================================================

  // 0) AUTO_ROSTER（N日経過を名簿へ）※ BUYER_KIND 時でも動かしてOK
  if (AUTO_ROSTER_3D) {
    const cand = await pool.query(
      `
      WITH first_follow AS (
        SELECT DISTINCT ON (fe.user_id)
          fe.user_id,
          fe.followed_at AS first_followed_at
        FROM follow_events fe
        WHERE fe.user_id IS NOT NULL
          AND fe.user_id <> ''
          AND fe.followed_at IS NOT NULL
        ORDER BY fe.user_id, fe.followed_at ASC
      )
      SELECT COUNT(*)::int AS n
      FROM first_follow
      WHERE first_followed_at <= NOW() - ($1::text || ' days')::interval
      `,
      [String(FIRST_SEEN_DAYS)]
    );
    console.log(`roster_candidates_by_first_seen=${cand.rows?.[0]?.n ?? "?"} (days=${FIRST_SEEN_DAYS})`);

    const inserted = await autoRosterByFirstSeen(FIRST_SEEN_DAYS);
    console.log(`roster_inserted=${inserted} (segment_key=${SEGMENT_KEY})`);
  }

  // 1) ターゲット元を決める（BUYER_KIND があれば orders から抽出して segment_blast に登録）
  if (BUYER_KIND) {
    console.log("=== BUYER MODE ===");
    const buyerIds = await loadBuyerIds(BUYER_KIND, BUYER_DAYS);
    console.log(`buyer_targets=${buyerIds.length} (kind=${BUYER_KIND}${BUYER_DAYS ? `, days=${BUYER_DAYS}` : ""})`);

    const created = await ensureBlastRows(SEGMENT_KEY, buyerIds);
    console.log(`segment_blast_rows_created=${created} (if missing)`);

    console.log(`already_bought_users=(skipped in BUYER MODE)`);
  } else {
    const boughtSql = buildAlreadyBoughtSQL();
    const bought = await pool.query(boughtSql, [FUKUBAKO_ID]);
    const boughtSet = new Set(bought.rows.map(r => r.user_id).filter(Boolean));
    console.log(`already_bought_users=${boughtSet.size}`);
    globalThis.__boughtSet = boughtSet;
  }

  // 2) EXCLUDE_SENT_KEYS：指定キーで送信済みを除外
  let excludeByKeysSet = new Set();
  if (EXCLUDE_SENT_KEYS.length) {
    excludeByKeysSet = await loadSentSetForKeys(EXCLUDE_SENT_KEYS);
    console.log(`excluded_by_keys_users=${excludeByKeysSet.size} (sent_at not null)`);
  }

  // 3) 一生1回のみ：過去に “どのキーでも” 送った user を取得（永久除外）
  let everSentSet = new Set();
  if (ONCE_ONLY && !skipGlobalEverSent) {
    everSentSet = await loadEverSentSetAll();
    console.log(`ever_sent_excluded_users=${everSentSet.size} (global all keys)`);
  } else if (ONCE_ONLY && skipGlobalEverSent) {
    console.log(`ever_sent_excluded_users=0 (global skipped for ${SEGMENT_KEY})`);
  }

  // 4) segment_blast から「未送信」を取得（最大20000）
  const slotParam = (SLOT === "morning" || SLOT === "day" || SLOT === "night") ? SLOT : null;

  const unsentSql = `
    WITH base AS (
      SELECT sb.user_id
      FROM segment_blast sb
      WHERE sb.segment_key = $1
        AND sb.sent_at IS NULL
        AND sb.user_id IS NOT NULL
        AND sb.user_id <> ''
    ),
    ref AS (
      SELECT
        b.user_id,
        COALESCE(
          (SELECT MAX(opened_at)   FROM public.liff_open_logs WHERE user_id=b.user_id),
          (SELECT MAX(followed_at) FROM public.follow_events  WHERE user_id=b.user_id)
        ) AS ref_ts
      FROM base b
    ),
    slotted AS (
      SELECT
        user_id,
        CASE
          WHEN ref_ts IS NULL THEN 'night'
          WHEN EXTRACT(HOUR FROM (ref_ts AT TIME ZONE 'Asia/Tokyo')) BETWEEN 6 AND 10 THEN 'morning'
          WHEN EXTRACT(HOUR FROM (ref_ts AT TIME ZONE 'Asia/Tokyo')) BETWEEN 11 AND 16 THEN 'day'
          ELSE 'night'
        END AS slot
      FROM ref
    )
    SELECT user_id
    FROM slotted
    WHERE ($2::text IS NULL OR slot = $2::text)
    ORDER BY user_id
    LIMIT 20000
  `;

  const { rows } = await pool.query(unsentSql, [SEGMENT_KEY, slotParam]);

  const allTargets = rows.map(r => r.user_id).filter(Boolean);
  console.log(`roster_total=${allTargets.length}`);

  // 5) フィルタ
  let ids = allTargets;

  if (!BUYER_KIND && !INCLUDE_BOUGHT) {
    const boughtSet = globalThis.__boughtSet || new Set();
    ids = ids.filter(uid => !boughtSet.has(uid));
  }

  if (excludeByKeysSet.size) ids = ids.filter(uid => !excludeByKeysSet.has(uid));
  if (ONCE_ONLY) ids = ids.filter(uid => !everSentSet.has(uid));

  // 6) 不正userId除外
  const invalid = ids.filter(uid => !isValidLineUserId(String(uid).trim()));
  let valid = ids.filter(uid => isValidLineUserId(String(uid).trim()));

  console.log(
    `eligible_targets (${BUYER_KIND ? "buyer_mode" : (INCLUDE_BOUGHT ? "include bought" : "exclude bought")}${slotParam ? ` + slot(${slotParam})` : ""}${EXCLUDE_SENT_KEYS.length ? " + sent(keys)" : ""}${ONCE_ONLY ? (skipGlobalEverSent ? " + ever_sent(global skipped)" : " + ever_sent(global)") : ""})=${ids.length}`
  );
  console.log(`valid_targets=${valid.length} invalid_targets=${invalid.length}`);

  // ✅ 追加：ここで 50 人などに絞る（送る直前の valid をスライス）
  if (blastLimit > 0 || blastOffset > 0) {
    const before = valid.length;
    const start = Math.max(0, blastOffset);
    const end = blastLimit > 0 ? (start + blastLimit) : undefined; // limitなしなら末尾まで
    valid = valid.slice(start, end);
    console.log(`BLAST_SLICE applied: before=${before}, offset=${start}, limit=${blastLimit || "(none)"}, after=${valid.length}`);
  }

  console.log("would_send_batches=" + Math.ceil(valid.length / 500) + " (batch_size=500)");
  console.log();
  console.log();

  if (invalid.length) {
    console.log(`invalid_sample=${invalid.slice(0, 5).join(",")}`);

    await pool.query(
      `
      UPDATE segment_blast
         SET last_error = $3
       WHERE segment_key = $1
         AND user_id = ANY($2::text[])
      `,
      [SEGMENT_KEY, invalid, "INVALID_LINE_USER_ID (filtered before multicast)"]
    );
  }

  if (valid.length === 0) {
    console.log("Nothing to send (no valid targets after filters).");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    await pool.end();
    return;
  }

  const batches = chunk(valid, 500);
  let sent = 0;
  let failed = 0;

  for (const part of batches) {
    try {
      await lineMulticast(part, messages);

      await pool.query(
        `
        UPDATE segment_blast
           SET sent_at = NOW(), last_error = NULL
         WHERE segment_key = $1
           AND user_id = ANY($2::text[])
        `,
        [SEGMENT_KEY, part]
      );

      sent += part.length;
      console.log(`OK batch: ${part.length} (total sent=${sent})`);
    } catch (e) {
      failed += part.length;
      console.error(`NG batch: ${part.length}`, e.message);

      await pool.query(
        `
        UPDATE segment_blast
           SET last_error = $3
         WHERE segment_key = $1
           AND user_id = ANY($2::text[])
        `,
        [SEGMENT_KEY, part, String(e.message).slice(0, 500)]
      );
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`DONE sent=${sent} failed=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});