/**
 * scripts/send_buyers_thanks_5d_named.js
 * 購入後5日「名前付き」サンクス（最終購入日基準 / push送信 / ✅横断除外なし / 最終版）
 *
 * ✅ 仕様
 * - user_idごとに最新購入を1件だけ（最終購入日基準）
 * - X〜Y日前（既定: 6〜5日）
 * - orders.notified_user_at / orders.notified_kind で二重送信防止（このキーのみ）
 *
 * ✅ 運用
 * - “別キーで既に送った”人は、後述の「印付け」(mark)で除外する
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const DBURL = (process.env.DATABASE_URL || "").trim();

const NOTIFIED_KIND =
  (process.env.NOTIFIED_KIND || "buyers_thanks_5d_named").trim();
const MESSAGE_FILE =
  (process.env.MESSAGE_FILE || "./messages/buyers_thanks_5d_named.json").trim();

const DRY_RUN = String(process.env.DRY_RUN || "") === "1";
const DEDUP_BY_USER = String(process.env.DEDUP_BY_USER || "") === "1";

const WINDOW_START_DAYS = Number(process.env.WINDOW_START_DAYS || 6);
const WINDOW_END_DAYS = Number(process.env.WINDOW_END_DAYS || 5);
const LIMIT = Number(process.env.LIMIT || 2000);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

const FORCE_ORDER_ID = (process.env.FORCE_ORDER_ID || "").trim();

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

function loadMessageTemplate() {
  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) throw new Error(`MESSAGE_FILE not found: ${fp}`);
  const raw = fs.readFileSync(fp, "utf8");
  const json = JSON.parse(raw);
  return Array.isArray(json) ? json : json.messages;
}

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

/** 最終購入日基準：userごと最新注文1件のみ */
async function loadTargetOrders({ startDays, endDays, limit }) {
  const sql = `
    WITH latest_addr AS (
      SELECT DISTINCT ON (user_id)
        user_id, name
      FROM addresses
      ORDER BY user_id, created_at DESC
    ),
    latest_order AS (
      SELECT DISTINCT ON (o.user_id)
        o.user_id,
        o.id AS order_id,
        o.name,
        o.created_at,
        o.notified_user_at,
        o.notified_kind
      FROM orders o
      WHERE o.user_id IS NOT NULL
        AND o.user_id <> ''
        AND o.status IN ('paid','confirmed','pickup')
      ORDER BY o.user_id, o.created_at DESC
    )
    SELECT
      lo.order_id,
      lo.user_id,
      COALESCE(
        NULLIF(lo.name, ''),
        NULLIF(a.name, ''),
        NULLIF(u.display_name, ''),
        'お客様'
      ) AS resolved_name,
      lo.created_at
    FROM latest_order lo
    LEFT JOIN latest_addr a ON a.user_id = lo.user_id
    LEFT JOIN users u ON u.user_id = lo.user_id
    WHERE lo.created_at >= NOW() - ($1 || ' days')::interval
      AND lo.created_at <  NOW() - ($2 || ' days')::interval
      AND (lo.notified_user_at IS NULL OR lo.notified_kind IS DISTINCT FROM $3)
    ORDER BY lo.created_at DESC
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

async function loadSingleOrder(orderId) {
  const sql = `
    WITH latest_addr AS (
      SELECT DISTINCT ON (user_id)
        user_id, name
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
  console.log("WINDOW_START_DAYS=", WINDOW_START_DAYS, "WINDOW_END_DAYS=", WINDOW_END_DAYS);
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

  if (DRY_RUN) {
    console.log(
      targets.slice(0, 10).map((o) => ({
        order_id: o.order_id,
        user_id: o.user_id,
        name: o.resolved_name,
        created_at: o.created_at,
      }))
    );
  }

  let sent = 0;
  const sentOrderIds = new Set();
  const sentUserIds = new Set();

  for (const o of targets) {
    if (sentOrderIds.has(o.order_id)) continue;
    sentOrderIds.add(o.order_id);

    // 保険
    if (DEDUP_BY_USER) {
      if (sentUserIds.has(o.user_id)) {
        console.log(`SKIP duplicate user_id=${o.user_id} (order_id=${o.order_id})`);
        continue;
      }
      sentUserIds.add(o.user_id);
    }

    if (!isValidLineUserId(o.user_id)) continue;

    console.log(`[WILL_SEND] user_id=${o.user_id} order_id=${o.order_id}`);

    if (DRY_RUN) continue;

    const messages = deepReplaceName(template, o.resolved_name);
    await linePush(o.user_id, messages);
    await markOrderSent(o.order_id);

    sent++;
    await sleep(SLEEP_MS);
  }

  console.log(`DONE sent_orders=${sent}`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
