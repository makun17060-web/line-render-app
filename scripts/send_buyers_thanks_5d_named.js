/**
 * scripts/send_buyers_thanks_5d_named.js
 * 購入後5日「名前付き」サンクス（注文単位 / push送信 / 丸ごと版）
 *
 * ✅ これでできること
 *  1) orders から「購入後5日」の注文（5日前の窓）を抽出
 *  2) 注文ごとに user_id へ push で送る（名前差し込み可能）
 *  3) 成功した注文だけ orders.notified_user_at / notified_kind を更新
 *
 * ✅ 方針（重要）
 *  - multicast は個別の名前差し込みができない → push で1件ずつ送る
 *  - 管理は segment_blast ではなく orders 側（注文単位）で管理する
 *
 * 必須ENV:
 *   DATABASE_URL
 *   LINE_CHANNEL_ACCESS_TOKEN
 *
 * 任意ENV:
 *   NOTIFIED_KIND=thanks_5d_named (既定)
 *   MESSAGE_FILE=./messages/buyers_thanks_5d_named.json (既定)
 *     - 配列 or {messages:[...]} を想定
 *     - 文字列中の {{NAME}} を注文の name で置換
 *   DRY_RUN=1               (送らずに件数だけ確認)
 *   WINDOW_START_DAYS=6     (既定: 6日前から)
 *   WINDOW_END_DAYS=5       (既定: 5日前まで) ←ここが「購入後5日」窓
 *   LIMIT=2000              (既定)
 *   SLEEP_MS=200            (既定)
 *   FORCE_ORDER_ID=123      (この注文だけ送る・テスト)
 *   FORCE_USER_ID=Uxxxx...  (この人の最新注文(5日窓内)だけ送る・テスト)
 *
 * 実行（Render/Linux）:
 *   node scripts/send_buyers_thanks_5d_named.js
 *
 * DRY RUN:
 *   DRY_RUN=1 node scripts/send_buyers_thanks_5d_named.js
 *
 * PowerShell:
 *   $env:DRY_RUN="1"; node scripts/send_buyers_thanks_5d_named.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const DBURL = (process.env.DATABASE_URL || "").trim();

const NOTIFIED_KIND = (process.env.NOTIFIED_KIND || "thanks_5d_named").trim();
const MESSAGE_FILE = (process.env.MESSAGE_FILE || "./messages/buyers_thanks_5d_named.json").trim();

const DRY_RUN = String(process.env.DRY_RUN || "").trim() === "1";

const WINDOW_START_DAYS = Number(process.env.WINDOW_START_DAYS || 6); // 6日前
const WINDOW_END_DAYS = Number(process.env.WINDOW_END_DAYS || 5);     // 5日前（＝購入後5日窓）
const LIMIT = Number(process.env.LIMIT || 2000);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

const FORCE_ORDER_ID = (process.env.FORCE_ORDER_ID || "").trim();
const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim();

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!NOTIFIED_KIND) throw new Error("NOTIFIED_KIND is required");
if (!MESSAGE_FILE) throw new Error("MESSAGE_FILE is required");

if (!(Number.isFinite(WINDOW_START_DAYS) && WINDOW_START_DAYS > 0)) {
  throw new Error(`WINDOW_START_DAYS invalid: ${WINDOW_START_DAYS}`);
}
if (!(Number.isFinite(WINDOW_END_DAYS) && WINDOW_END_DAYS >= 0)) {
  throw new Error(`WINDOW_END_DAYS invalid: ${WINDOW_END_DAYS}`);
}
if (WINDOW_START_DAYS <= WINDOW_END_DAYS) {
  throw new Error(
    `WINDOW_START_DAYS must be > WINDOW_END_DAYS (start=${WINDOW_START_DAYS}, end=${WINDOW_END_DAYS})`
  );
}

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

function isValidLineUserId(uid) {
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * LINE push API（個別送信）
 */
async function linePush(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`LINE push failed: ${res.status} ${text}`);
  return text;
}

/**
 * MESSAGE_FILE（配列 or {messages:[]}）を読み込む
 * 文字列中の {{NAME}} を置換するため、テンプレとして保持
 */
function loadMessageTemplate() {
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
  // 最低限のバリデーション
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== "object") throw new Error(`messages[${i}] must be an object`);
    if (typeof m.type !== "string" || !m.type.trim()) throw new Error(`messages[${i}].type is required`);
  }

  return msgs;
}

/**
 * 任意オブジェクトの全stringに対して {{NAME}} を置換
 * flex含めてOK（JSON内の文字列は全部対象）
 */
function deepReplaceName(obj, name) {
  const safeName = (name || "").trim();
  const rep = safeName ? safeName : "ご注文者";

  if (obj == null) return obj;

  if (typeof obj === "string") {
    return obj.replace(/\{\{NAME\}\}/g, rep);
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => deepReplaceName(v, rep));
  }
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepReplaceName(v, rep);
    }
    return out;
  }
  return obj;
}

/**
 * 送信対象（注文単位）を抽出
 * - 5日前窓（6日前〜5日前）
 * - status: paid/confirmed/pickup（必要なら増やしてOK）
 * - 未送信: notified_user_at is null OR notified_kind != NOTIFIED_KIND
 */
async function loadTargetOrdersByWindow({ startDays, endDays, limit }) {
  const sql = `
    SELECT
      o.id AS order_id,
      o.user_id,
      o.name AS orders_name,
      o.status,
      o.created_at,
      o.notified_user_at,
      o.notified_kind
    FROM orders o
    WHERE o.user_id IS NOT NULL AND o.user_id <> ''
      AND o.status IN ('paid','confirmed','pickup')
      AND o.created_at >= NOW() - ($1::text || ' days')::interval
      AND o.created_at <  NOW() - ($2::text || ' days')::interval
      AND (o.notified_user_at IS NULL OR o.notified_kind IS DISTINCT FROM $3)
    ORDER BY o.created_at ASC
    LIMIT $4
  `;
  const { rows } = await pool.query(sql, [String(startDays), String(endDays), NOTIFIED_KIND, limit]);
  return rows || [];
}

async function loadOrderById(orderId) {
  const { rows } = await pool.query(
    `
    SELECT
      o.id AS order_id,
      o.user_id,
      o.name AS orders_name,
      o.status,
      o.created_at,
      o.notified_user_at,
      o.notified_kind
    FROM orders o
    WHERE o.id = $1
    `,
    [orderId]
  );
  return rows?.[0] || null;
}

/**
 * FORCE_USER_ID 用：窓内の最新1件だけ拾う（テスト用）
 */
async function loadLatestOrderForUserInWindow(userId, startDays, endDays) {
  const { rows } = await pool.query(
    `
    SELECT
      o.id AS order_id,
      o.user_id,
      o.name AS orders_name,
      o.status,
      o.created_at,
      o.notified_user_at,
      o.notified_kind
    FROM orders o
    WHERE o.user_id = $1
      AND o.status IN ('paid','confirmed','pickup')
      AND o.created_at >= NOW() - ($2::text || ' days')::interval
      AND o.created_at <  NOW() - ($3::text || ' days')::interval
    ORDER BY o.created_at DESC
    LIMIT 1
    `,
    [userId, String(startDays), String(endDays)]
  );
  return rows?.[0] || null;
}

async function markOrderSent(orderId) {
  const { rowCount } = await pool.query(
    `
    UPDATE orders
       SET notified_user_at = NOW(),
           notified_kind = $2
     WHERE id = $1
    `,
    [orderId, NOTIFIED_KIND]
  );
  return rowCount || 0;
}

async function markOrderFailed(orderId, errMsg) {
  // orders に last_error が無い前提。ログだけに残す（必要なら列追加してもOK）
  // もし orders.raw_event に入れたいなどあれば後で変える
  console.error(`[markOrderFailed] order_id=${orderId} err=${String(errMsg || "").slice(0, 400)}`);
}

(async () => {
  const template = loadMessageTemplate();

  console.log(`NOTIFIED_KIND=${NOTIFIED_KIND}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);
  console.log(`WINDOW_START_DAYS=${WINDOW_START_DAYS} WINDOW_END_DAYS=${WINDOW_END_DAYS}`);
  console.log(`LIMIT=${LIMIT} SLEEP_MS=${SLEEP_MS}`);
  console.log(`FORCE_ORDER_ID=${FORCE_ORDER_ID || "(none)"} FORCE_USER_ID=${FORCE_USER_ID || "(none)"}`);
  console.log(`template_messages_count=${template.length}, first_type=${template[0]?.type}`);
  console.log("");

  let targets = [];

  if (FORCE_ORDER_ID) {
    const oid = Number(FORCE_ORDER_ID);
    if (!Number.isFinite(oid) || oid <= 0) throw new Error(`FORCE_ORDER_ID invalid: ${FORCE_ORDER_ID}`);
    const o = await loadOrderById(oid);
    if (!o) {
      console.log(`FORCE_ORDER_ID=${oid} not found`);
      await pool.end();
      return;
    }
    targets = [o];
    console.log(`=== FORCE ORDER MODE === order_id=${oid}`);
  } else if (FORCE_USER_ID) {
    if (!isValidLineUserId(FORCE_USER_ID)) throw new Error(`FORCE_USER_ID invalid: ${FORCE_USER_ID}`);
    const o = await loadLatestOrderForUserInWindow(FORCE_USER_ID, WINDOW_START_DAYS, WINDOW_END_DAYS);
    if (!o) {
      console.log(`FORCE_USER_ID=${FORCE_USER_ID} has no order in window`);
      await pool.end();
      return;
    }
    targets = [o];
    console.log(`=== FORCE USER MODE === user_id=${FORCE_USER_ID} order_id=${o.order_id}`);
  } else {
    targets = await loadTargetOrdersByWindow({
      startDays: WINDOW_START_DAYS,
      endDays: WINDOW_END_DAYS,
      limit: LIMIT,
    });
  }

  console.log(`target_orders=${targets.length}`);

  // user_id 妥当性でフィルタ
  const invalid = targets.filter((o) => !isValidLineUserId(String(o.user_id || "")));
  const valid = targets.filter((o) => isValidLineUserId(String(o.user_id || "")));

  console.log(`valid_orders=${valid.length} invalid_orders=${invalid.length}`);
  if (invalid.length) {
    console.log(
      `invalid_sample_order_ids=${invalid.slice(0, 5).map((x) => x.order_id).join(",")}`
    );
  }
  console.log("");

  if (valid.length === 0) {
    console.log("Nothing to send.");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    // 参考表示（最初の数件）
    console.log(
      valid.slice(0, 5).map((o) => ({
        order_id: o.order_id,
        user_id: o.user_id,
        orders_name: o.orders_name,
        created_at: o.created_at,
      }))
    );
    await pool.end();
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const o of valid) {
    const orderId = o.order_id;
    const uid = String(o.user_id || "").trim();
    const name = String(o.orders_name || "").trim(); // 配送先名（ギフト時は受取人名になる可能性あり）

    // メッセージ生成（テンプレに {{NAME}} があれば置換）
    const messages = deepReplaceName(template, name);

    try {
      await linePush(uid, messages);
      await markOrderSent(orderId);
      sent += 1;
      console.log(`OK order_id=${orderId} to=${uid} name="${name || "(blank)"}"`);
    } catch (e) {
      failed += 1;
      const msg = e?.message || e;
      await markOrderFailed(orderId, msg);
      console.error(`NG order_id=${orderId} to=${uid}`, msg);
    }

    await sleep(SLEEP_MS);
  }

  console.log(`DONE sent_orders=${sent} failed_orders=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
