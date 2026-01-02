/**
 * server.js — 磯屋 統合サーバー（修正版）
 *
 * ✅ 今回の修正（重要）
 * - 発送通知の金額ズレ修正：
 *   orders.total が「商品+送料+代引」の最終合計のため、
 *   商品合計は total - shipping_fee - (codなら330) で逆算する
 * - o.order_number は存在しない → id を orderNumber として返す
 *
 * =========================
 * 必須 env
 * - PORT
 * - DATABASE_URL
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - ADMIN_API_TOKEN または ADMIN_CODE
 *
 * 任意 env
 * - DATA_DIR=/var/data
 * - UPLOAD_DIR=/var/data/uploads
 */

"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const { Pool } = require("pg");
const line = require("@line/bot-sdk");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const ADMIN_API_TOKEN = (process.env.ADMIN_API_TOKEN || process.env.ADMIN_CODE || "").trim();

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads");

const COD_FEE = 330;

// ---------- sanity ----------
if (!DATABASE_URL) console.warn("[WARN] DATABASE_URL is missing");
if (!LINE_CHANNEL_ACCESS_TOKEN) console.warn("[WARN] LINE_CHANNEL_ACCESS_TOKEN is missing");
if (!LINE_CHANNEL_SECRET) console.warn("[WARN] LINE_CHANNEL_SECRET is missing");
if (!ADMIN_API_TOKEN) console.warn("[WARN] ADMIN_API_TOKEN / ADMIN_CODE is missing");

// ---------- ensure dirs ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- middleware ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- static hosting ----------
app.use("/public", express.static(path.join(__dirname, "public")));
// ★重要：Disk上の uploads を /public/uploads で配信
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ---------- DB pool ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ---------- helpers ----------
const yen = (n) => Number(n || 0).toLocaleString("ja-JP") + "円";

function safeJson(v, fallback) {
  try {
    if (v == null) return fallback;
    if (typeof v === "object") return v;
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function requireAdmin(req, res, next) {
  const token = String(req.query.token || "").trim();
  if (!ADMIN_API_TOKEN || token !== ADMIN_API_TOKEN) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

async function linePush(to, text) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is missing");
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages: [{ type: "text", text }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`LINE push failed: ${r.status} ${t}`);
  }
  return true;
}

function calcItemsSum(items) {
  const arr = Array.isArray(items) ? items : [];
  let sum = 0;
  for (const it of arr) {
    const name = String(it?.name || it?.id || "");
    let price = Number(it?.price || 0);
    const qty = Number(it?.qty || 0);

    // （任意）久助の単価補完：単価が無い場合のみ
    if (!price && /久助/.test(name)) price = 250;

    sum += price * qty;
  }
  return sum;
}

/**
 * ★核心：DB row を「表示用の内訳」に正規化
 * - totalDb は最終合計（商品+送料+代引）
 * - itemsTotal は totalDb - shipping - codFee
 */
function normalizeTotalsFromRow(row) {
  const payment = String(row.payment_method || "").toLowerCase();
  const shipping = Number(row.shipping_fee || 0);
  const totalDb = Number(row.total || 0);
  const codFee = payment === "cod" ? COD_FEE : 0;

  const itemsFromTotal = totalDb - shipping - codFee;

  const items = safeJson(row.items, []);
  const itemsCalc = calcItemsSum(items);

  const warn = (itemsCalc !== 0 && itemsFromTotal !== itemsCalc);
  const diff = itemsFromTotal - itemsCalc;

  return {
    items,
    itemsTotal: itemsFromTotal,
    itemsCalc,
    shipping,
    codFee,
    finalTotal: totalDb,
    warn,
    diff,
  };
}

// ---------- ensure tables (safe) ----------
async function ensureDb() {
  // orders：あなたのスキーマに合わせる（存在するなら何もしない）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      member_code TEXT,
      phone TEXT,
      items JSONB,
      total INTEGER,
      shipping_fee INTEGER,
      payment_method TEXT,
      status TEXT,
      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,
      source TEXT,
      raw_event JSONB,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
      notified_at TIMESTAMPTZ,
      notified_user_at TIMESTAMPTZ,
      notified_admin_at TIMESTAMPTZ,
      notified_kind TEXT
    );
  `);

  // addresses（以前あなたが出してくれた列ベース）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      member_code TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // segment_users（あると便利：無くても動く）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      last_seen_at TIMESTAMPTZ,
      last_chat_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

ensureDb().catch((e) => console.error("[ensureDb] error:", e));

// ===================================================
// Health
// ===================================================
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ===================================================
// Orders create API（必要ならミニアプリ/電話サーバから使える）
// ===================================================
app.post("/api/orders/create", async (req, res) => {
  try {
    const b = req.body || {};
    const userId = String(b.userId || b.user_id || "").trim() || null;
    const memberCode = String(b.memberCode || b.member_code || "").trim() || null;
    const phone = String(b.phone || "").trim() || null;

    const items = Array.isArray(b.items) ? b.items : safeJson(b.items, []);
    const paymentMethod = String(b.paymentMethod || b.payment_method || "").trim().toLowerCase();
    const shippingFee = Number(b.shippingFee ?? b.shipping_fee ?? 0) || 0;

    // 合計はサーバー側で作る（ズレを減らす）
    const itemsSum = calcItemsSum(items);
    const codFee = paymentMethod === "cod" ? COD_FEE : 0;
    const finalTotal = itemsSum + shippingFee + codFee;

    const name = String(b.name || "").trim() || null;
    const zip = String(b.zip || "").trim() || null;
    const pref = String(b.pref || "").trim() || null;
    const address = String(b.address || "").trim() || null;

    const source = String(b.source || "liff").trim();
    const status = String(b.status || "new").trim();

    const rawEvent = (typeof b.raw_event === "object") ? b.raw_event : safeJson(b.raw_event, null);

    const r = await pool.query(
      `
      INSERT INTO orders
        (user_id, member_code, phone, items, total, shipping_fee, payment_method, status,
         name, zip, pref, address, source, raw_event)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,
         $9,$10,$11,$12,$13,$14)
      RETURNING id, created_at
      `,
      [
        userId, memberCode, phone,
        JSON.stringify(items),
        finalTotal, shippingFee, paymentMethod, status,
        name, zip, pref, address,
        source, rawEvent ? JSON.stringify(rawEvent) : null
      ]
    );

    res.json({
      ok: true,
      id: r.rows[0].id,
      created_at: r.rows[0].created_at,
      itemsSum,
      shippingFee,
      codFee,
      total: finalTotal
    });
  } catch (e) {
    console.error("[/api/orders/create] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================================================
// Admin: orders list  ★今回の修正が入っている本体
// GET /api/admin/orders?token=...&date=YYYYMMDD
// ===================================================
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const date = String(req.query.date || "").trim(); // YYYYMMDD
  try {
    const params = [];
    let where = "";
    if (date) {
      where = "WHERE o.created_at::date = to_date($1,'YYYYMMDD')";
      params.push(date);
    }

    const sql = `
      SELECT
        o.id,
        o.user_id,
        o.member_code,
        o.phone,
        o.items,
        o.total,
        o.shipping_fee,
        o.payment_method,
        o.status,
        o.name,
        o.zip,
        o.pref,
        o.address,
        o.source,
        o.raw_event,
        o.created_at,
        o.notified_user_at,
        o.notified_admin_at,
        o.notified_kind
      FROM orders o
      ${where}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT 500
    `;

    const r = await pool.query(sql, params);

    const items = r.rows.map((row) => {
      const t = normalizeTotalsFromRow(row);

      return {
        // ✅ order_numberが無いので id を注文番号にする
        id: row.id,
        orderNumber: row.id,

        userId: row.user_id,
        lineUserId: row.user_id,

        member_code: row.member_code,
        phone: row.phone,

        items: t.items,

        // admin が表示に使う
        shipping_fee: t.shipping,
        shipping: t.shipping,
        payment_method: row.payment_method,
        payment: row.payment_method,
        codFee: t.codFee,

        // ★ズレない内訳
        itemsTotal: t.itemsTotal,
        finalTotal: t.finalTotal,
        total: t.finalTotal,

        // 時刻
        ts: row.created_at,
        created_at: row.created_at,

        // 住所（admin.html が address object を読む）
        address: {
          name: row.name || "",
          phone: row.phone || "",
          postal: row.zip || "",
          prefecture: row.pref || "",
          city: "",
          address1: row.address || "",
          address2: "",
        },

        status: row.status,
        source: row.source,

        notified_user_at: row.notified_user_at,
        notified_admin_at: row.notified_admin_at,
        notified_kind: row.notified_kind,

        // 検算（警告表示用）
        warn: t.warn ? { itemsCalc: t.itemsCalc, itemsFromTotal: t.itemsTotal, diff: t.diff } : null,
      };
    });

    res.json({ ok: true, items });
  } catch (e) {
    console.error("[/api/admin/orders] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================================================
// Admin: notify shipped
// POST /api/admin/orders/notify-shipped?token=...
// body: { orderId, userId, message }
// ===================================================
app.post("/api/admin/orders/notify-shipped", requireAdmin, express.json(), async (req, res) => {
  try {
    const { orderId, userId, message } = req.body || {};
    const oid = Number(orderId);
    const uid = String(userId || "").trim();
    const msg = String(message || "").trim();

    if (!uid) return res.status(400).json({ ok: false, error: "body.userId required" });
    if (!msg) return res.status(400).json({ ok: false, error: "body.message required" });

    await linePush(uid, msg);

    // DB に発送通知済み保存（id列）
    if (isFinite(oid) && oid > 0) {
      await pool.query(
        `UPDATE orders
         SET notified_user_at = NOW(),
             notified_kind = 'shipped'
         WHERE id = $1`,
        [oid]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[/api/admin/orders/notify-shipped] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================================================
// Admin: segment preview/send（最低限）
// ===================================================

// POST /api/admin/segment/preview?token=...
// body: { type: "orders"|"addresses"|"activeChatters", date?: "YYYYMMDD" }
app.post("/api/admin/segment/preview", requireAdmin, express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.type || "").trim();
    const date = String(b.date || "").trim(); // YYYYMMDD

    let userIds = [];

    if (type === "orders") {
      const params = [];
      let where = "WHERE o.user_id IS NOT NULL AND o.user_id <> ''";
      if (date) {
        where += " AND o.created_at::date = to_date($1,'YYYYMMDD')";
        params.push(date);
      }
      const r = await pool.query(
        `SELECT DISTINCT o.user_id FROM orders o ${where} ORDER BY o.user_id LIMIT 20000`,
        params
      );
      userIds = r.rows.map((x) => x.user_id).filter(Boolean);
    } else if (type === "addresses") {
      const r = await pool.query(
        `SELECT DISTINCT a.user_id FROM addresses a WHERE a.user_id IS NOT NULL AND a.user_id <> '' ORDER BY a.user_id LIMIT 20000`
      );
      userIds = r.rows.map((x) => x.user_id).filter(Boolean);
    } else if (type === "activeChatters") {
      // segment_users があればそれを使う（無ければ空）
      const params = [];
      let where = "WHERE s.user_id IS NOT NULL AND s.user_id <> '' AND s.last_chat_at IS NOT NULL";
      if (date) {
        where += " AND (s.last_chat_at AT TIME ZONE 'Asia/Tokyo')::date = to_date($1,'YYYYMMDD')";
        params.push(date);
      }
      let r;
      try {
        r = await pool.query(
          `SELECT DISTINCT s.user_id FROM segment_users s ${where} ORDER BY s.user_id LIMIT 20000`,
          params
        );
        userIds = r.rows.map((x) => x.user_id).filter(Boolean);
      } catch (e) {
        userIds = [];
      }
    } else {
      return res.status(400).json({ ok: false, error: "unknown type" });
    }

    res.json({ ok: true, total: userIds.length, userIds });
  } catch (e) {
    console.error("[/api/admin/segment/preview] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /api/admin/segment/send?token=...
// body: { userIds: string[], message: string }
app.post("/api/admin/segment/send", requireAdmin, express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const userIds = Array.isArray(b.userIds) ? b.userIds : [];
    const msg = String(b.message || "").trim();

    if (!msg) return res.status(400).json({ ok: false, error: "message required" });
    if (userIds.length === 0) return res.status(400).json({ ok: false, error: "userIds required" });

    // push を順番に（大量なら multicast に改造可）
    let sent = 0;
    for (const uid of userIds) {
      const to = String(uid || "").trim();
      if (!to) continue;
      await linePush(to, msg);
      sent++;
      // 負荷軽減：必要なら少し待つ（無ければ削除OK）
      await new Promise((r) => setTimeout(r, 80));
    }

    res.json({ ok: true, requested: userIds.length, sent });
  } catch (e) {
    console.error("[/api/admin/segment/send] error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================================================
// LINE Webhook（最低限）
// ===================================================
if (LINE_CHANNEL_SECRET && LINE_CHANNEL_ACCESS_TOKEN) {
  const config = { channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN, channelSecret: LINE_CHANNEL_SECRET };

  async function touchUser(userId, kind, profileMaybe) {
    if (!userId) return;
    const now = new Date();
    const displayName = profileMaybe?.displayName || null;

    let setCol = "last_seen_at";
    if (kind === "chat") setCol = "last_chat_at";
    if (kind === "liff") setCol = "last_liff_at";

    // upsert
    await pool.query(
      `
      INSERT INTO segment_users (user_id, display_name, last_seen_at, last_chat_at, last_liff_at)
      VALUES ($1, $2, $3, NULL, NULL)
      ON CONFLICT (user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, segment_users.display_name),
        ${setCol} = $3
      `,
      [userId, displayName, now]
    );
  }

  async function handleEvent(ev) {
    const userId = ev?.source?.userId || "";
    if (userId) {
      try {
        // profileは重いので、必要なら取得（ここでは省略）
        await touchUser(userId, "seen", null);
      } catch {}
    }

    // テキストだけ最低限反応
    if (ev.type === "message" && ev.message?.type === "text") {
      const text = String(ev.message.text || "").trim();

      if (userId) {
        try { await touchUser(userId, "chat", null); } catch {}
      }

      // 必要ならここに「直接注文」「久助」などの処理を追加
      // 今回は安全に「受け取りました」だけ
      const client = new line.Client(config);
      await client.replyMessage(ev.replyToken, [
        { type: "text", text: "お問い合わせありがとうございます。内容を確認してご案内します。" }
      ]);
    }
  }

  app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
      const events = req.body.events || [];
      await Promise.all(events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      const detail = err?.response?.data || err?.stack || err;
      console.error("Webhook Error:", JSON.stringify(detail, null, 2));
      res.status(500).end();
    }
  });
} else {
  console.warn("[WARN] LINE webhook disabled (missing secret/token)");
}

// ===================================================
// start
// ===================================================
app.listen(PORT, () => {
  console.log(`[ISOYA] server listening on :${PORT}`);
  console.log(`[ISOYA] DATA_DIR=${DATA_DIR}`);
  console.log(`[ISOYA] UPLOAD_DIR=${UPLOAD_DIR}`);
});
