// send_blast_once.js —（名簿自動追加 + 未送信 + 未購入 + キー指定除外 + FORCE_USER_ID + ✅購入者直抽出(BUYER_KIND)）Text/Flex 切替版
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
// ✅ 購入者配信（名簿不要：ordersから抽出して送信台帳(segment_blast)だけ残す）
//   BUYER_KIND=card|cod|pickup|all
//   BUYER_DAYS=30     (任意) 直近N日だけに絞る。0/未指定なら無制限
//
//   - card   : status='paid'      AND payment_method IN ('card','stripe')
//   - cod    : status='confirmed' AND payment_method='cod'
//   - pickup : status='pickup'    AND payment_method='pickup_cash'
//   - all    : status IN ('paid','confirmed','pickup') かつ上記のいずれか
//
// ✅ 自分テスト用（強制1ユーザー送信）
//   FORCE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   - 名簿 / 購入済み / 除外キー / ever_sent / sent_at などのフィルタを無視して、その userId にだけ送る
//   - 送信結果は segment_blast に記録（存在しなければ作る）
//
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN
//
// MESSAGE_FILE の形式：
//   - JSON配列: [ {message}, {message} ... ]
//   - または: { "messages": [ ... ] }
//
// 例:
//   MESSAGE_FILE=./messages/text.json
//   MESSAGE_FILE=./messages/flex.json

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

// ✅ 購入者直抽出モード（名簿不要）
const BUYER_KIND = (process.env.BUYER_KIND || "").trim(); // card | cod | pickup | all | ""
const BUYER_DAYS = Number(process.env.BUYER_DAYS || 0);   // 0なら絞らない

// ※商品IDは「変更なし」でOK（今まで通り env で指定 or 既定）
const FUKUBAKO_ID   = (process.env.FUKUBAKO_ID || "fukubako-2026").trim();
const FUKUBAKO_URL  = (process.env.FUKUBAKO_URL || "").trim();

// ✅ 一生1回のみ（全キー横断）
// - デフォルトON（ONCE_ONLY=1）
// ※あなたの運用（未購入は何度でも初めてセット）なら基本OFF推奨：ONCE_ONLY=0
const ONCE_ONLY = String(process.env.ONCE_ONLY || "1").trim() !== "0";

// ✅ キー指定除外（このキー送信済みユーザーを除外）
const EXCLUDE_SENT_KEYS = (process.env.EXCLUDE_SENT_KEYS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ✅ 自分テスト用：強制ターゲット
const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim();

// ✅【今回追加】KEYごとに「global除外(ever_sent all keys)」をスキップしたい場合
// - buyers_thanks_3d（購入後お礼）は「過去に何か送っていてもOK」なので global除外は無効化が自然
// - それ以外は従来どおり安全装置としてON
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
  // LINE userId は通常 "U" + 32桁hex（計33文字）
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
}

// messages を外部JSONから読み込む
function loadMessages() {
  // MESSAGE_FILE 未指定ならデフォルト（テキスト）
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
// - items が配列: [{id, qty, ...}, ...] でも
// - items がオブジェクト: {items:[{id..}], ...} でも
// 両方拾えるようにする
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

// ✅ 友だち追加からN日経過した人を名簿に入れる（送信は別）
async function autoRosterByFirstSeen(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`FIRST_SEEN_DAYS invalid: ${days}`);

  const r = await pool.query(
    `
    WITH cand AS (
      SELECT su.user_id
      FROM segment_users su
      WHERE su.user_id IS NOT NULL
        AND su.user_id <> ''
        AND su.first_seen <= NOW() - ($2::text || ' days')::interval
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

// ✅ FORCE_USER_ID 用：送信記録を必ず segment_blast に残す（なければ作る）
async function markSentForForceUser(userId, ok, errMsg) {
  const msg = errMsg ? String(errMsg).slice(0, 500) : null;

  // 1) 行が無ければ作る（created_at）
  await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [SEGMENT_KEY, userId]
  );

  // 2) 成否で更新
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

  // ユーザーごとの「最後の購入」を1件に絞って分類（payment_method 実態に合わせて固定）
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

// ✅ BUYER_KIND 用：送信台帳（segment_blast）に行を作る（未送信管理のため）
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
  console.log(`FORCE_USER_ID=${FORCE_USER_ID || "(none)"}`);

  console.log(`BUYER_KIND=${BUYER_KIND || "(none)"} BUYER_DAYS=${BUYER_DAYS || "(none)"}`);

  // ✅ 今回追加：このキーでは global ever_sent 除外をスキップするか
  const skipGlobalEverSent = SKIP_GLOBAL_EVER_SENT_KEYS.has(SEGMENT_KEY);
  console.log(`SKIP_GLOBAL_EVER_SENT=${skipGlobalEverSent ? "1" : "0"} (keys=${[...SKIP_GLOBAL_EVER_SENT_KEYS].join(",")})`);

  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // ✅ 先に FORCE_USER_ID を処理（フィルタ全部無視でこの人だけ）
  if (FORCE_USER_ID) {
    if (!isValidLineUserId(FORCE_USER_ID)) {
      throw new Error(`FORCE_USER_ID invalid: ${FORCE_USER_ID}`);
    }

    console.log("=== FORCE MODE ===");
    console.log(`force_targets=1 (${FORCE_USER_ID})`);

    if (DRY_RUN) {
      console.log("DRY_RUN=1 so not sending (FORCE MODE).");
      await pool.end();
      return;
    }

    try {
      await lineMulticast([FORCE_USER_ID], messages);
      await markSentForForceUser(FORCE_USER_ID, true, null);
      console.log("OK force send: 1");
    } catch (e) {
      await markSentForForceUser(FORCE_USER_ID, false, e?.message || e);
      console.error("NG force send:", e?.message || e);
      throw e;
    }

    await pool.end();
    return;
  }

  // 0) AUTO_ROSTER（N日経過を名簿へ）※ BUYER_KIND 時でも動かしてOK（運用が混ざるなら）
  if (AUTO_ROSTER_3D) {
    const cand = await pool.query(
      `SELECT COUNT(*)::int AS n FROM segment_users su WHERE su.first_seen <= NOW() - ($1::text || ' days')::interval`,
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

    console.log(`already_bought_users=(skipped in BUYER MODE)`); // BUYER配信では商品購入除外をしないのが基本
  } else {
    // 既存どおり：商品「購入済み」は除外用に取得
    const boughtSql = buildAlreadyBoughtSQL();
    const bought = await pool.query(boughtSql, [FUKUBAKO_ID]);
    const boughtSet = new Set(bought.rows.map(r => r.user_id).filter(Boolean));
    console.log(`already_bought_users=${boughtSet.size}`);

    // 後段で使うので閉じない
    globalThis.__boughtSet = boughtSet; // 既存構造に合わせて苦肉の策（下で参照）
  }

  // 2) EXCLUDE_SENT_KEYS：指定キーで送信済みを除外
  let excludeByKeysSet = new Set();
  if (EXCLUDE_SENT_KEYS.length) {
    excludeByKeysSet = await loadSentSetForKeys(EXCLUDE_SENT_KEYS);
    console.log(`excluded_by_keys_users=${excludeByKeysSet.size} (sent_at not null)`);
  }

  // 3) 一生1回のみ：過去に “どのキーでも” 送った user を取得（永久除外）
  // ✅ 今回追加：buyers_thanks_3d のような「購入後お礼」は global 除外をスキップ
  let everSentSet = new Set();
  if (ONCE_ONLY && !skipGlobalEverSent) {
    everSentSet = await loadEverSentSetAll();
    console.log(`ever_sent_excluded_users=${everSentSet.size} (global all keys)`);
  } else if (ONCE_ONLY && skipGlobalEverSent) {
    console.log(`ever_sent_excluded_users=0 (global skipped for ${SEGMENT_KEY})`);
  }

  // 4) segment_blast から「未送信」を取得（最大20000）
  const { rows } = await pool.query(
    `
    SELECT user_id
      FROM segment_blast
     WHERE segment_key = $1
       AND sent_at IS NULL
     ORDER BY user_id
     LIMIT 20000
    `,
    [SEGMENT_KEY]
  );

  const allTargets = rows.map(r => r.user_id).filter(Boolean);
  console.log(`unsent_targets=${allTargets.length}`);

  // 5) フィルタ
  let ids = allTargets;

  // 未購入配信（従来）だけ：FUKUBAKO_ID 購入済み除外
  if (!BUYER_KIND) {
    const boughtSet = globalThis.__boughtSet || new Set();
    ids = ids.filter(uid => !boughtSet.has(uid));
  }

  // 共通：キー指定送信済み除外・（任意）全キー永久除外
  if (excludeByKeysSet.size) ids = ids.filter(uid => !excludeByKeysSet.has(uid));
  if (ONCE_ONLY) ids = ids.filter(uid => !everSentSet.has(uid));

  // 6) 不正userId（TEST_USERなど）を除外
  const invalid = ids.filter(uid => !isValidLineUserId(String(uid).trim()));
  const valid = ids.filter(uid => isValidLineUserId(String(uid).trim()));

  console.log(
    `eligible_targets (${BUYER_KIND ? "buyer_mode" : "exclude bought"}${EXCLUDE_SENT_KEYS.length ? " + sent(keys)" : ""}${ONCE_ONLY ? (skipGlobalEverSent ? " + ever_sent(global skipped)" : " + ever_sent(global)") : ""})=${ids.length}`
  );
  console.log(`valid_targets=${valid.length} invalid_targets=${invalid.length}`);
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

  const batches = chunk(valid, 500); // multicastは最大500
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

    // レート対策（軽く間隔）
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`DONE sent=${sent} failed=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
