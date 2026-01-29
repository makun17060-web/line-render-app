/**
 * scripts/send_buyers_thanks_5d_named.js
 * 購入後5日「名前付き」サンクス（注文単位 / push送信 / 安全柵入り・丸ごと版）
 *
 * ✅ 今回の修正ポイント（重要）
 * - FORCE_ORDER_ID でも addresses JOIN で増殖しない（latest_addr + LIMIT 1）
 * - どんな理由で rows が重複しても「同一 order_id は二度送らない」(Set ガード)
 * - 実際に読んだ MESSAGE_FILE の絶対パスをログに出す（事故防止）
 *
 * ✅ 今回だけ「同じ user_id は1回」にするスイッチ追加
 * - DEDUP_BY_USER=1 のときだけ、同一 user_id への送信を1回に抑制（終わったら外せば注文ごとに戻る）
 *
 * ✔ 名前取得優先順位
 *   1) orders.name
 *   2) addresses.name（最新）
 *   3) users.display_name
 *   4) 'お客様'
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Node 18+ なら global fetch がある前提（Renderは通常OK）
// もし環境によって fetch が無い場合は: const fetch = require("node-fetch");

const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const DBURL = (process.env.DATABASE_URL || "").trim();

const NOTIFIED_KIND = (process.env.NOTIFIED_KIND || "thanks_5d_named").trim();
const MESSAGE_FILE =
  (process.env.MESSAGE_FILE || "./messages/buyers_thanks_5d_named.json").trim();

const DRY_RUN = String(process.env.DRY_RUN || "") === "1";

// ★今回だけ user_id 重複を抑えるスイッチ（1ならON）
const DEDUP_BY_USER = String(process.env.DEDUP_BY_USER || "") === "1";

const WINDOW_START_DAYS = Number(process.env.WINDOW_START_DAYS || 6);
const WINDOW_END_DAYS = Number(process.env.WINDOW_END_DAYS || 5);
const LIMIT = Number(process.env.LIMIT || 2000);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

const FORCE_ORDER_ID = (process.env.FORCE_ORDER_ID || "").trim();
const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim(); // 将来用（現状未使用）

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

function isValidLineUserId(uid) {
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* LINE push */
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
}

/* テンプレ読込 */
function loadMessageTemplate() {
  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) {
    throw new Error(`MESSAGE_FILE not found: ${fp}`);
  }
  const raw = fs.readFileSync(fp, "utf8");
  const json = JSON.parse(raw);
  return Array.isArray(json) ? json : json.messages;
}

/* {{NAME}} 置換 */
function deepReplaceName(obj, name) {
  const rep = name && name.trim() ? name.trim() : "お客様";
  if (obj == null) return obj;
  if (typeof obj === "string") return obj.replace(/\{\{NAME\}\}/g, rep);
  if (Array.isArray(obj)) return obj.map((v) => deepReplaceName(v, rep));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = deepReplaceName(v, rep);
    return out;
  }
  return obj;
}

/* ===== 核心：名前を確実に拾うSQL（注文一覧） ===== */
async function loadTargetOrders({ startDays, endDays, limit }) {
  const sql = `
    WITH latest_addr AS (
      SELECT DISTINCT ON (user_id)
        user_id,
        name
      FROM addresses
      ORDER BY user_id, created_at DESC
    )
    SELECT
      o.id            AS order_id,
      o.user_id,
      COALESCE(
        NULLIF(o.name, ''),
        NULLIF(a.name, ''),
        NULLIF(u.display_name, ''),
        'お客様'
      )               AS resolved_name,
      o.created_at
    FROM orders o
    LEFT JOIN latest_addr a ON a.user_id = o.user_id
    LEFT JOIN users u       ON u.user_id = o.user_id
    WHERE o.user_id IS NOT NULL
      AND o.status IN ('paid','confirmed','pickup')
      AND o.created_at >= NOW() - ($1 || ' days')::interval
      AND o.created_at <  NOW() - ($2 || ' days')::interval
      AND (o.notified_user_at IS NULL OR o.notified_kind IS DISTINCT FROM $3)
    ORDER BY o.created_at ASC
    LIMIT $4
  `;
  const { rows } = await pool.query(sql, [
    String(startDays),
    String(endDays),
    NOTIFIED_KIND,
    limit,
  ]);
  return rows;
}

/* FORCE_ORDER_ID 用：増殖しない・必ず1件 */
async function loadSingleOrder(orderId) {
  const sql = `
    WITH latest_addr AS (
      SELECT DISTINCT ON (user_id)
        user_id,
        name
      FROM addresses
      ORDER BY user_id, created_at DESC
    )
    SELECT
      o.id AS order_id,
      o.user_id,
      COALESCE(
        NULLIF(o.name, ''),
        NULLIF(a.name, ''),
        NULLIF(u.display_name, ''),
        'お客様'
      ) AS resolved_name,
      o.created_at
    FROM orders o
    LEFT JOIN latest_addr a ON a.user_id=o.user_id
    LEFT JOIN users u ON u.user_id=o.user_id
    WHERE o.id=$1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [Number(orderId)]);
  return rows;
}

async function markOrderSent(orderId) {
  await pool.query(
    `
    UPDATE orders
       SET notified_user_at = NOW(),
           notified_kind = $2
     WHERE id = $1
    `,
    [orderId, NOTIFIED_KIND]
  );
}

(async () => {
  console.log("NOTIFIED_KIND=", NOTIFIED_KIND);
  console.log("DRY_RUN=", DRY_RUN ? "1" : "0");
  console.log("DEDUP_BY_USER=", DEDUP_BY_USER ? "1" : "0");
  console.log("CWD=", process.cwd());
  console.log("MESSAGE_FILE(resolved)=", path.resolve(process.cwd(), MESSAGE_FILE));

  const template = loadMessageTemplate();

  let targets = [];

  if (FORCE_ORDER_ID) {
    targets = await loadSingleOrder(FORCE_ORDER_ID);
  } else {
    targets = await loadTargetOrders({
      startDays: WINDOW_START_DAYS,
      endDays: WINDOW_END_DAYS,
      limit: LIMIT,
    });
  }

  console.log(`target_orders=${targets.length}`);

  // DRY_RUN: 内容確認（最初の数件）
  if (DRY_RUN) {
    console.log(
      targets.slice(0, 10).map((o) => ({
        order_id: o.order_id,
        user_id: o.user_id,
        name: o.resolved_name,
        created_at: o.created_at,
      }))
    );
    await pool.end();
    return;
  }

  let sent = 0;

  // ✅ 最終安全柵：同一 order_id は絶対に二度送らない
  const sentOrderIds = new Set();

  // ✅ 今回だけ：同一 user_id は1回だけ（DEDUP_BY_USER=1 のとき）
  const sentUserIds = new Set();

  for (const o of targets) {
    // order_id 重複ガード
    if (sentOrderIds.has(o.order_id)) {
      console.log(`SKIP duplicate order_id=${o.order_id}`);
      continue;
    }
    sentOrderIds.add(o.order_id);

    // user_id 重複ガード（今回だけ）
    if (DEDUP_BY_USER) {
      if (sentUserIds.has(o.user_id)) {
        console.log(`SKIP duplicate user_id=${o.user_id} (order_id=${o.order_id})`);
        continue;
      }
      sentUserIds.add(o.user_id);
    }

    if (!isValidLineUserId(o.user_id)) {
      console.log(`SKIP invalid user_id order_id=${o.order_id} user_id=${o.user_id}`);
      continue;
    }

    const messages = deepReplaceName(template, o.resolved_name);

    // 送信 → 記録（※DEDUP_BY_USER=1 の場合でも「代表の1注文」だけに印が付きます）
    await linePush(o.user_id, messages);
    await markOrderSent(o.order_id);

    sent++;
    console.log(`OK order_id=${o.order_id} name="${o.resolved_name}"`);

    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  console.log(`DONE sent_orders=${sent}`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
