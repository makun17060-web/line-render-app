/**
 * scripts/send_buyers_thanks_5d_named.js
 * 購入後5日「名前付き」サンクス（最終購入日基準 / push送信）
 *
 * 重要:
 * - notified_kind / notified_user_at は再送判定に使わない
 * - buyers_thanks_5d_named_at だけで二重送信防止する
 * - 発送通知(shipped_notified_at)とは完全分離
 *
 * Env:
 *  - LINE_CHANNEL_ACCESS_TOKEN (required)
 *  - DATABASE_URL (required)
 *  - MESSAGE_FILE=./messages/buyers_thanks_5d_named.json
 *  - DRY_RUN=1
 *  - DEDUP_BY_USER=1
 *  - WINDOW_START_DAYS=6
 *  - WINDOW_END_DAYS=5
 *  - LIMIT=2000
 *  - SLEEP_MS=200
 *  - FORCE_ORDER_ID=123
 *  - FORCE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *  - SAFE_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const DBURL = (process.env.DATABASE_URL || "").trim();

const MESSAGE_FILE =
  (process.env.MESSAGE_FILE || "./messages/buyers_thanks_5d_named.json").trim();

const DRY_RUN = String(process.env.DRY_RUN || "") === "1";
const DEDUP_BY_USER = String(process.env.DEDUP_BY_USER || "") === "1";

const WINDOW_START_DAYS = Number(process.env.WINDOW_START_DAYS || 6);
const WINDOW_END_DAYS = Number(process.env.WINDOW_END_DAYS || 5);
const LIMIT = Number(process.env.LIMIT || 2000);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

const FORCE_ORDER_ID = (process.env.FORCE_ORDER_ID || "").trim();
const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim();
const SAFE_USER_ID = (process.env.SAFE_USER_ID || "").trim();

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
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${text}`.slice(0, 500));
  }
}

function loadMessageTemplate() {
  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) {
    throw new Error(`MESSAGE_FILE not found: ${fp}`);
  }
  const raw = fs.readFileSync(fp, "utf8");
  const json = JSON.parse(raw);
  return Array.isArray(json) ? json : json.messages;
}

function deepReplaceName(obj, name) {
  const rep = name && String(name).trim() ? String(name).trim() : "お客様";

  if (obj == null) return obj;
  if (typeof obj === "string") return obj.replace(/\{\{NAME\}\}/g, rep);
  if (Array.isArray(obj)) return obj.map((v) => deepReplaceName(v, rep));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deepReplaceName(v, rep);
    }
    return out;
  }
  return obj;
}

function isAllowedBySafetyLock(targetUserId) {
  if (!SAFE_USER_ID) return true;
  return String(targetUserId || "").trim() === SAFE_USER_ID;
}

/**
 * 通常モード:
 * user_idごとに最新注文1件だけ
 * 5〜6日前ウィンドウ
 * まだ buyers_thanks_5d_named_at が入っていないものだけ
 */
async function loadTargetOrders({ startDays, endDays, limit }) {
  const sql = `
    WITH latest_addr AS (
      SELECT DISTINCT ON (user_id)
        user_id,
        name
      FROM addresses
      ORDER BY user_id, created_at DESC
    ),
    latest_order AS (
      SELECT DISTINCT ON (o.user_id)
        o.user_id,
        o.id AS order_id,
        o.name,
        o.created_at,
        o.buyers_thanks_5d_named_at
      FROM orders o
      WHERE o.user_id IS NOT NULL
        AND BTRIM(o.user_id) <> ''
        AND o.status IN ('paid', 'confirmed', 'pickup')
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
      lo.created_at,
      lo.buyers_thanks_5d_named_at
    FROM latest_order lo
    LEFT JOIN latest_addr a ON a.user_id = lo.user_id
    LEFT JOIN users u ON u.user_id = lo.user_id
    WHERE lo.created_at >= NOW() - ($1 || ' days')::interval
      AND lo.created_at <  NOW() - ($2 || ' days')::interval
      AND lo.buyers_thanks_5d_named_at IS NULL
    ORDER BY lo.created_at DESC
    LIMIT $3
  `;

  const { rows } = await pool.query(sql, [
    String(startDays),
    String(endDays),
    limit,
  ]);

  return rows;
}

/**
 * 注文IDで1件
 * force用なので通知済みでも取れる
 */
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
      o.created_at,
      o.buyers_thanks_5d_named_at
    FROM orders o
    LEFT JOIN latest_addr a ON a.user_id = o.user_id
    LEFT JOIN users u ON u.user_id = o.user_id
    WHERE CAST(o.id AS text) = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [String(orderId)]);
  return rows;
}

/**
 * user_idでその人の最新注文1件
 * force用なので通知済みでも取れる
 */
async function loadLatestOrderByUser(userId) {
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
      o.created_at,
      o.buyers_thanks_5d_named_at
    FROM orders o
    LEFT JOIN latest_addr a ON a.user_id = o.user_id
    LEFT JOIN users u ON u.user_id = o.user_id
    WHERE o.user_id = $1
      AND BTRIM(o.user_id) <> ''
      AND o.status IN ('paid', 'confirmed', 'pickup')
    ORDER BY o.created_at DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [userId]);
  return rows;
}

async function markBuyersThanksSent(orderId) {
  await pool.query(
    `
    UPDATE orders
       SET buyers_thanks_5d_named_at = NOW()
     WHERE id = $1
    `,
    [orderId]
  );
}

(async () => {
  console.log("DRY_RUN=", DRY_RUN ? "1" : "0");
  console.log("DEDUP_BY_USER=", DEDUP_BY_USER ? "1" : "0");
  console.log(
    "WINDOW_START_DAYS=",
    WINDOW_START_DAYS,
    "WINDOW_END_DAYS=",
    WINDOW_END_DAYS
  );
  console.log("MESSAGE_FILE(resolved)=", path.resolve(process.cwd(), MESSAGE_FILE));
  console.log("FORCE_ORDER_ID=", FORCE_ORDER_ID || "(none)");
  console.log("FORCE_USER_ID=", FORCE_USER_ID || "(none)");
  console.log("SAFE_USER_ID=", SAFE_USER_ID || "(none)");

  const template = loadMessageTemplate();

  let targets = [];

  if (FORCE_ORDER_ID) {
    console.log("=== FORCE MODE (ORDER) ===");
    targets = await loadSingleOrder(FORCE_ORDER_ID);
  } else if (FORCE_USER_ID) {
    console.log("=== FORCE MODE (USER) ===");
    if (!isValidLineUserId(FORCE_USER_ID)) {
      throw new Error(`FORCE_USER_ID is invalid: ${FORCE_USER_ID}`);
    }
    targets = await loadLatestOrderByUser(FORCE_USER_ID);
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
        buyers_thanks_5d_named_at: o.buyers_thanks_5d_named_at,
      }))
    );
  }

  let sent = 0;
  let failed = 0;
  const sentOrderIds = new Set();
  const sentUserIds = new Set();

  for (const o of targets) {
    if (!o) continue;

    if (sentOrderIds.has(o.order_id)) continue;
    sentOrderIds.add(o.order_id);

    if (DEDUP_BY_USER) {
      if (sentUserIds.has(o.user_id)) {
        console.log(`SKIP duplicate user_id=${o.user_id} (order_id=${o.order_id})`);
        continue;
      }
      sentUserIds.add(o.user_id);
    }

    if (!isValidLineUserId(o.user_id)) {
      console.log(`SKIP invalid LINE user_id=${o.user_id} (order_id=${o.order_id})`);
      continue;
    }

    if (!isAllowedBySafetyLock(o.user_id)) {
      console.log(
        `[SAFETY_LOCK] BLOCKED user_id=${o.user_id} order_id=${o.order_id} (allowed only SAFE_USER_ID=${SAFE_USER_ID})`
      );
      continue;
    }

    console.log(`[TARGET_THANKS_5D] user_id=${o.user_id} order_id=${o.order_id}`);

    if (DRY_RUN) {
      console.log(`[DRY_RUN_THANKS_5D] order_id=${o.order_id}`);
      continue;
    }

    try {
      const messages = deepReplaceName(template, o.resolved_name);
      await linePush(o.user_id, messages);
      console.log(`[SENT_THANKS_5D_OK] order_id=${o.order_id}`);

      await markBuyersThanksSent(o.order_id);
      console.log(`[DB_UPDATED_THANKS_5D] order_id=${o.order_id}`);

      sent++;
      await sleep(SLEEP_MS);
    } catch (e) {
      failed++;
      console.error(`[SENT_THANKS_5D_NG] order_id=${o.order_id} ${e.message}`);
    }
  }

  console.log(`DONE sent_orders=${sent} failed=${failed}`);
  await pool.end();
})().catch(async (e) => {
  console.error(e);
  try {
    await pool.end();
  } catch {}
  process.exit(1);
});