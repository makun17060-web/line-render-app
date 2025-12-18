"use strict";

/**
 * server-line.js — フル機能版（Stripe + ミニアプリ + 画像管理）【修正版・丸ごと】
 * - 重要：このファイルの “関数外” に await / p.query / CREATE を置かない
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const multer = require("multer");
const stripeLib = require("stripe");
const { Pool } = require("pg");

// =====================================================
// Express
// =====================================================
const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// Env
// =====================================================
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const LIFF_ID_DIRECT_ADDRESS = (process.env.LIFF_ID_DIRECT_ADDRESS || LIFF_ID).trim();
const LIFF_ID_SHOP = (process.env.LIFF_ID_SHOP || "").trim();

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const COD_FEE = Number(process.env.COD_FEE || 330);

const PHONE_HOOK_TOKEN = (process.env.PHONE_HOOK_TOKEN || "").trim();
const ONLINE_NOTIFY_TOKEN = (process.env.ONLINE_NOTIFY_TOKEN || "").trim();
const PUBLIC_ADDRESS_LOOKUP_TOKEN = (process.env.PUBLIC_ADDRESS_LOOKUP_TOKEN || "").trim();

// LINE config
const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error(
    `ERROR: .env の必須値が不足しています。
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- LIFF_ID
- （ADMIN_API_TOKEN または ADMIN_CODE のどちらか）`
  );
  process.exit(1);
}

// =====================================================
// PostgreSQL
// =====================================================
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })
  : null;

function mustPool() {
  if (!pool) throw new Error("DATABASE_URL not set");
  return pool;
}

// =====================================================
// Stripe
// =====================================================
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || "").trim();
const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;
if (!stripe) console.warn("⚠️ STRIPE_SECRET_KEY が未設定です。/api/pay-stripe は 500 を返します。");

// =====================================================
// Files & dirs
// =====================================================
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const PHONE_ADDRESSES_PATH = path.join(DATA_DIR, "phone-addresses.json");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");

for (const d of [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

app.use("/public", express.static(PUBLIC_DIR));

// =====================================================
// JSON parser（/webhook を除外）
// =====================================================
const jsonParser = express.json({ limit: "2mb" });
const urlParser = express.urlencoded({ extended: true });

app.use((req, res, next) => (req.path.startsWith("/webhook") ? next() : jsonParser(req, res, next)));
app.use((req, res, next) => (req.path.startsWith("/webhook") ? next() : urlParser(req, res, next)));

app.use((req, _res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// =====================================================
// Utils
// =====================================================
function rand4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}
function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function appendJsonLine(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {}
}
const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

// init files
if (!fs.existsSync(PRODUCTS_PATH)) {
  writeJSON(PRODUCTS_PATH, [
    { id: "kusuke-250", name: "久助（えびせん）", price: 250, stock: 20, desc: "お得な割れせん。", image: "" },
    { id: "original-set-2100", name: "磯屋オリジナルセット", price: 2100, stock: 10, desc: "人気の詰め合わせ。", image: "" },
  ]);
}
if (!fs.existsSync(PHONE_ADDRESSES_PATH)) writeJSON(PHONE_ADDRESSES_PATH, {});

// =====================================================
// Auth
// =====================================================
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
function requireAdmin(req, res) {
  const headerTok = bearerToken(req);
  const queryTok = String(req.query?.token || req.query?.code || "").trim();
  const tok = headerTok || queryTok;

  if (ADMIN_API_TOKEN_ENV && tok === ADMIN_API_TOKEN_ENV) return true;
  if (ADMIN_CODE_ENV && tok === ADMIN_CODE_ENV) return true;

  res.status(401).json({ ok: false, error: "unauthorized" });
  return false;
}

// =====================================================
// LINE client
// =====================================================
const client = new line.Client(config);

// =====================================================
// DB schema (※ここだけで CREATE 実行)
// =====================================================
async function ensureDbSchema() {
  if (!pool) return;
  const p = mustPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS codes (
      user_id      TEXT PRIMARY KEY,
      member_code  CHAR(4) UNIQUE,
      address_code CHAR(4) UNIQUE
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      member_code CHAR(4) PRIMARY KEY,
      user_id     TEXT,
      name        TEXT,
      phone       TEXT,
      postal      TEXT,
      prefecture  TEXT,
      city        TEXT,
      address1    TEXT,
      address2    TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS message_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT NOT NULL,
      msg_type TEXT NOT NULL,
      text_len INT DEFAULT 0
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_ts ON message_events(ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_user_id ON message_events(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS liff_open_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      opened_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_kind_time ON liff_open_logs(kind, opened_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_user ON liff_open_logs(user_id);`);
}

// =====================================================
// codes helpers
// =====================================================
async function dbGetCodesByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const r = await p.query(`SELECT user_id, member_code, address_code FROM codes WHERE user_id=$1 LIMIT 1`, [uid]);
  return r.rows[0] || null;
}
async function dbEnsureCodes(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const exist = await dbGetCodesByUserId(uid);
  if (exist?.member_code && exist?.address_code) return exist;

  for (let i = 0; i < 200; i++) {
    const mc = exist?.member_code?.trim() || rand4();
    const ac = exist?.address_code?.trim() || rand4();

    try {
      await p.query(`INSERT INTO codes (user_id, member_code, address_code) VALUES ($1,$2,$3)`, [uid, mc, ac]);
      return { user_id: uid, member_code: mc, address_code: ac };
    } catch (e) {
      if (String(e?.code) === "23505") continue;
      // 既に user_id があるケース
      const again = await dbGetCodesByUserId(uid);
      if (again?.member_code && again?.address_code) return again;
      throw e;
    }
  }
  throw new Error("code_generation_exhausted");
}

async function dbUpsertAddressByUserId(userId, addr = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");
  const codes = await dbEnsureCodes(uid);
  const memberCode = String(codes.member_code || "").trim();

  const a = {
    name: String(addr.name || "").trim(),
    phone: String(addr.phone || "").trim(),
    postal: String(addr.postal || "").trim(),
    prefecture: String(addr.prefecture || "").trim(),
    city: String(addr.city || "").trim(),
    address1: String(addr.address1 || "").trim(),
    address2: String(addr.address2 || "").trim(),
  };

  await p.query(
    `
    INSERT INTO addresses
      (member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
    ON CONFLICT (member_code) DO UPDATE SET
      user_id     = EXCLUDED.user_id,
      name        = EXCLUDED.name,
      phone       = EXCLUDED.phone,
      postal      = EXCLUDED.postal,
      prefecture  = EXCLUDED.prefecture,
      city        = EXCLUDED.city,
      address1    = EXCLUDED.address1,
      address2    = EXCLUDED.address2,
      updated_at  = NOW()
    `,
    [memberCode, uid, a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2]
  );

  return { memberCode, ...a };
}

async function dbGetAddressByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const r = await p.query(
    `
    SELECT c.user_id, c.member_code, c.address_code,
           a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2, a.updated_at
      FROM codes c
      LEFT JOIN addresses a ON a.member_code = c.member_code
     WHERE c.user_id = $1
     LIMIT 1
    `,
    [uid]
  );

  const row = r.rows[0] || null;
  if (!row) return null;

  const hasAny = row.name || row.phone || row.postal || row.prefecture || row.city || row.address1 || row.address2;
  if (!hasAny) return null;

  return row;
}

// =====================================================
// endpoints
// =====================================================
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));

// LINE ping
app.get("/api/line/ping", async (_req, res) => {
  try {
    if (!ADMIN_USER_ID) return res.status(400).json({ ok: false, error: "ADMIN_USER_ID not set" });
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: "✅ LINEサーバー疎通テストOK" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.response?.data || e?.message || String(e) });
  }
});

// LIFF open log
app.post("/api/liff/open", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const kind = String(req.body?.kind || "order").trim().slice(0, 32);
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    await mustPool().query(`INSERT INTO liff_open_logs (user_id, kind) VALUES ($1,$2)`, [userId, kind]);
    try { await dbEnsureCodes(userId); } catch {}
    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/liff/open error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// LIFF address save/load
app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    await dbUpsertAddressByUserId(userId, addr);
    const codes = await dbEnsureCodes(userId);

    return res.json({ ok: true, saved: true, memberCode: String(codes.member_code || ""), addressCode: String(codes.address_code || "") });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.get("/api/liff/address/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || req.headers["x-line-userid"] || "").trim();
    if (!userId || !pool) return res.json({ ok: true, address: null });

    const row = await dbGetAddressByUserId(userId);
    if (!row) return res.json({ ok: true, address: null });

    return res.json({
      ok: true,
      address: {
        name: row.name || "",
        phone: row.phone || "",
        postal: row.postal || "",
        prefecture: row.prefecture || "",
        city: row.city || "",
        address1: row.address1 || "",
        address2: row.address2 || "",
        memberCode: String(row.member_code || ""),
        addressCode: String(row.address_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/liff/address/me error:", e);
    return res.json({ ok: false, address: null });
  }
});

app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();
  if (kind === "shop") {
    if (!LIFF_ID_SHOP) return res.status(500).json({ ok: false, error: "LIFF_ID_SHOP_not_set" });
    return res.json({ ok: true, liffId: LIFF_ID_SHOP });
  }
  if (kind === "cod") return res.json({ ok: true, liffId: LIFF_ID_DIRECT_ADDRESS || LIFF_ID });
  return res.json({ ok: true, liffId: LIFF_ID });
});

// public address lookup (token required)
app.get("/api/public/address-by-code", async (req, res) => {
  try {
    const token = String(req.query.token || req.headers["x-public-token"] || "").trim();
    if (!PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(500).json({ ok: false, error: "PUBLIC_ADDRESS_LOOKUP_TOKEN_not_set" });
    if (token !== PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

    const code = String(req.query.code || "").trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: "code_required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const r = await mustPool().query(
      `SELECT member_code, address_code FROM codes WHERE member_code=$1 LIMIT 1`,
      [code]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });

    const a = await mustPool().query(
      `SELECT postal,prefecture,city,address1,address2 FROM addresses WHERE member_code=$1 LIMIT 1`,
      [code]
    );
    const addr = a.rows[0];
    if (!addr) return res.status(404).json({ ok: false, error: "address_not_registered" });

    return res.json({
      ok: true,
      address: {
        postal: addr.postal || "",
        prefecture: addr.prefecture || "",
        city: addr.city || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        memberCode: code,
        addressCode: String(row.address_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/public/address-by-code error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// phone hook (token required)
app.post("/api/phone/hook", async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || req.headers["x-phone-token"] || "").trim();
    if (!PHONE_HOOK_TOKEN) return res.status(500).json({ ok: false, error: "PHONE_HOOK_TOKEN_not_set" });
    if (token !== PHONE_HOOK_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

    const phoneE164 = String(req.body?.phone || req.body?.from || "").trim();
    const memberCode = String(req.body?.memberCode || req.body?.code || "").trim();
    const address = req.body?.address || {};
    if (!phoneE164) return res.status(400).json({ ok: false, error: "phone required" });
    if (!/^\d{4}$/.test(memberCode)) return res.status(400).json({ ok: false, error: "memberCode(4digits) required" });

    const all = safeReadJSON(PHONE_ADDRESSES_PATH, {});
    all[phoneE164] = { ts: new Date().toISOString(), memberCode, address };
    writeJSON(PHONE_ADDRESSES_PATH, all);

    return res.json({ ok: true, saved: true, db: !!pool });
  } catch (e) {
    console.error("/api/phone/hook error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// order complete notify (token optional if env set)
app.post("/api/order/complete", async (req, res) => {
  try {
    const token = String(req.body?.token || req.query?.token || "").trim();
    if (ONLINE_NOTIFY_TOKEN && token !== ONLINE_NOTIFY_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const order = req.body?.order || req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    const lineUserId = String(order.lineUserId || "").trim();

    const itemsTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);
    const total = itemsTotal + shipping + codFee;

    appendJsonLine(ORDERS_LOG, { ts: new Date().toISOString(), lineUserId, items, itemsTotal, shipping, codFee, total, raw: order });

    const msg =
      `🧾【注文完了】\n合計：${yen(total)}\n（商品${yen(itemsTotal)} + 送料${yen(shipping)} + 代引${yen(codFee)}）`;

    if (ADMIN_USER_ID) {
      try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
    }
    if (lineUserId) {
      try { await client.pushMessage(lineUserId, { type: "text", text: `ご注文ありがとうございます！\n\n${msg}` }); } catch {}
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// Stripe checkout session
app.post("/api/pay-stripe", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);

    const line_items = items
      .map((it) => {
        const unit = Number(it.price) || 0;
        const qty = Number(it.qty) || 0;
        if (!qty || unit < 0) return null;
        return {
          price_data: { currency: "jpy", product_data: { name: String(it.name || it.id || "商品") }, unit_amount: unit },
          quantity: qty,
        };
      })
      .filter(Boolean);

    if (shipping > 0) line_items.push({ price_data: { currency: "jpy", product_data: { name: "送料" }, unit_amount: shipping }, quantity: 1 });
    if (codFee > 0) line_items.push({ price_data: { currency: "jpy", product_data: { name: "代引き手数料" }, unit_amount: codFee }, quantity: 1 });

    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers.host;
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: `${base}/public/confirm-card-success.html`,
      cancel_url: `${base}/public/confirm-fail.html`,
    });

    return res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("/api/pay-stripe error:", e?.raw || e);
    return res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

// webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("webhook error:", e?.stack || e);
    res.status(500).end();
  }
});

async function handleEvent(ev) {
  try {
    if (ev.type === "message" && ev.message?.type === "text") {
      const uid = ev.source?.userId || "";
      const text = String(ev.message.text || "").trim();

      appendJsonLine(MESSAGES_LOG, { ts: new Date().toISOString(), userId: uid, type: "text", len: text.length });

      if (pool && uid) {
        try {
          await mustPool().query(`INSERT INTO message_events (user_id, msg_type, text_len) VALUES ($1,$2,$3)`, [
            uid,
            "text",
            Number(text.length || 0),
          ]);
        } catch {}
      }

      if (text === "会員コード") {
        if (!pool) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "現在DBが未設定のため会員コードを発行できません（DATABASE_URL未設定）。" });
          return;
        }
        const c = await dbEnsureCodes(uid);
        await client.replyMessage(ev.replyToken, { type: "text", text: `磯屋 会員コード\n----------------------\n${c.member_code}` });
        return;
      }

      if (text === "住所コード" || text === "住所番号") {
        if (!pool) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "現在DBが未設定のため住所コードを発行できません（DATABASE_URL未設定）。" });
          return;
        }
        const c = await dbEnsureCodes(uid);
        await client.replyMessage(ev.replyToken, { type: "text", text: `磯屋 住所コード\n----------------------\n${c.address_code}` });
        return;
      }
    }
  } catch (e) {
    console.error("handleEvent error:", e?.stack || e);
  }
}

// =====================================================
// start
// =====================================================
(async () => {
  try {
    await ensureDbSchema();
    console.log("✅ DB schema checked/ensured");
  } catch (e) {
    console.error("❌ ensureDbSchema error:", e?.message || e);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server started on port ${PORT}`);
  });
})();
