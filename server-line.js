/**
 * server-line.js — 超フル機能版（Disk products.json + uploads + 住所DB + セグメント + 注文DB + 送料計算統一 + 管理画面/配信/発送通知/純増）
 *
 * ✅ 今回の修正（502/DB互換）
 * - Render の PORT に必ず追従（PORT が無ければ起動失敗）
 * - app.listen(PORT, "0.0.0.0") を明示（502対策）
 * - /healthz を追加（疎通確認用）
 * - 既存DB（過去版）に created_at 等が無い場合でも落ちないように ALTER TABLE IF NOT EXISTS を追加
 *
 * ✅ 維持
 * - 久助も「商品」として自由に価格変更できる（products.json が正）
 * - 久助の送料は「アカシャシリーズと同じ」扱い（混載も同梱扱い）
 * - 起動キーワードは「直接注文」と「久助」だけ（それ以外は無反応）
 * - ただしセッション中の入力は受け付ける
 *
 * ✅ Disk
 * - PRODUCTS_FILE=/var/data/products.json
 * - UPLOAD_DIR=/var/data/uploads
 *
 * ✅ 必須環境変数
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - DATABASE_URL（Postgres）
 *
 * ✅ 任意
 * - ADMIN_USER_ID
 * - BASE_URL（例 https://line-render-app-1.onrender.com）
 * - ADMIN_API_KEY
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const line = require("@line/bot-sdk");

// ================= Env =================
// ★Render は PORT を渡す。無いならサービス設定ミスなので落とす
const PORT = parseInt(process.env.PORT || "", 10);
if (!PORT) {
  console.error("FATAL: PORT is not set. (Render Web Service should set PORT automatically)");
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL || ""; // 例: https://line-render-app-1.onrender.com

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

const PRODUCTS_FILE = process.env.PRODUCTS_FILE || "/var/data/products.json";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/var/data/uploads";

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) console.warn("DATABASE_URL is not set (DB features disabled)");

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ================= App =================
const app = express();
app.use((req, res, next) => {
  console.log("[REQ]", new Date().toISOString(), req.method, req.url);
  next();
});

app.use(cors());

// ★静的（public）と uploads（Disk）
ensureDirSync(UPLOAD_DIR);
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ================= DB =================
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ================= Multer (Upload) =================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}_${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ================= Utilities =================
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
async function readJsonSafe(filePath, fallback) {
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
async function writeJsonAtomic(filePath, obj) {
  ensureDirSync(path.dirname(filePath));
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}
function nowJSTDateString() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}
function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ================= In-memory session =================
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

function setSession(userId, mode, data = {}) {
  sessions.set(userId, { mode, data, updatedAt: Date.now() });
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}
function clearSession(userId) {
  sessions.delete(userId);
}

// ================= Products (Disk single source of truth) =================
async function loadProducts() {
  const fallback = [
    {
      id: "kusuke-250",
      name: "久助（われせん）",
      price: 340,
      stock: 30,
      volume: "100g",
      desc: "お得な割れせん。",
      image: "",
    },
  ];
  const arr = await readJsonSafe(PRODUCTS_FILE, fallback);
  return Array.isArray(arr) ? arr : fallback;
}
async function saveProducts(products) {
  await writeJsonAtomic(PRODUCTS_FILE, products);
}
async function getProductById(id) {
  const products = await loadProducts();
  return products.find((p) => String(p.id) === String(id)) || null;
}
function normalizeProductPatch(patch) {
  const out = {};
  if (patch.id != null) out.id = String(patch.id).trim();
  if (patch.name != null) out.name = String(patch.name);
  if (patch.price != null) out.price = Number(patch.price);
  if (patch.stock != null) out.stock = Number(patch.stock);
  if (patch.volume != null) out.volume = String(patch.volume);
  if (patch.desc != null) out.desc = String(patch.desc);
  if (patch.image != null) out.image = String(patch.image);
  return out;
}

// ================= DB schema (create + migrate-safe) =================
async function ensureDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS line_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      user_id TEXT PRIMARY KEY,
      member_code TEXT,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      source TEXT,
      items JSONB,
      total INTEGER,
      shipping_fee INTEGER,
      payment_method TEXT,
      status TEXT,
      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,
      raw_event JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      last_seen_at TIMESTAMP,
      last_liff_at TIMESTAMP,
      last_chat_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS liff_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      event TEXT,
      meta JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_blast (
      segment_key TEXT,
      user_id TEXT,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY(segment_key, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS message_events (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      kind TEXT,
      raw_event JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // ===== migrate: 既存テーブルに列が無いケースを救済 =====
  await pool.query(`ALTER TABLE line_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE line_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);

  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);

  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_event JSONB;`);

  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_liff_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP;`);

  await pool.query(`ALTER TABLE liff_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  await pool.query(`ALTER TABLE segment_blast ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  await pool.query(`ALTER TABLE message_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  // ===== indexes =====
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_events_created_at ON message_events(created_at DESC);`);
}

async function touchUser(userId, kind) {
  if (!pool || !userId) return;
  await pool.query(
    `
    INSERT INTO segment_users (user_id, last_seen_at, last_liff_at, last_chat_at, updated_at)
    VALUES ($1,
      CASE WHEN $2='seen' THEN now() ELSE NULL END,
      CASE WHEN $2='liff' THEN now() ELSE NULL END,
      CASE WHEN $2='chat' THEN now() ELSE NULL END,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at = COALESCE(EXCLUDED.last_seen_at, segment_users.last_seen_at),
      last_liff_at = COALESCE(EXCLUDED.last_liff_at, segment_users.last_liff_at),
      last_chat_at = COALESCE(EXCLUDED.last_chat_at, segment_users.last_chat_at),
      updated_at = now()
  `,
    [userId, kind]
  );
}

async function upsertLineProfile(userId) {
  if (!pool || !userId) return;
  try {
    const prof = await client.getProfile(userId);
    await pool.query(
      `
      INSERT INTO line_users (user_id, display_name, picture_url, status_message, created_at, updated_at)
      VALUES ($1,$2,$3,$4, now(), now())
      ON CONFLICT (user_id) DO UPDATE SET
        display_name=$2, picture_url=$3, status_message=$4, updated_at=now()
    `,
      [userId, prof.displayName || "", prof.pictureUrl || "", prof.statusMessage || ""]
    );
  } catch {}
}

async function dbGetAddressByUserId(userId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT * FROM addresses WHERE user_id=$1`, [userId]);
  return r.rows[0] || null;
}

async function dbInsertMessageEvent(userId, kind, raw_event) {
  if (!pool || !userId || !kind) return;
  await pool.query(`INSERT INTO message_events (user_id, kind, raw_event) VALUES ($1,$2,$3)`, [
    userId,
    String(kind),
    raw_event || {},
  ]);
}

// ================= Shipping (unified) =================
function sizeFromAkasha6Qty(qty) {
  if (qty <= 2) return 60;
  if (qty <= 4) return 80;
  if (qty <= 6) return 100;
  if (qty <= 8) return 120;
  return 140;
}
function sizeFromOriginalSetQty(qty) {
  if (qty <= 1) return 80;
  if (qty <= 2) return 100;
  if (qty <= 4) return 120;
  return 140;
}
function sizeFromTotalQty(qty) {
  if (qty <= 2) return 60;
  if (qty <= 4) return 80;
  if (qty <= 6) return 100;
  if (qty <= 8) return 120;
  return 140;
}

function isOriginalSet(item) {
  const id = String(item?.id || "");
  return id === "original-set-2000";
}
function isAkasha6(item) {
  const id = String(item?.id || "");
  const name = String(item?.name || "");
  if (id === "kusuke-250" || /久助/.test(name)) return true;
  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}

function prefToRegion(pref) {
  const p = String(pref || "");
  if (/北海道/.test(p)) return "hokkaido";
  if (/(青森|岩手|宮城|秋田|山形|福島)/.test(p)) return "tohoku";
  if (/(東京|神奈川|千葉|埼玉|茨城|栃木|群馬|山梨)/.test(p)) return "kanto";
  if (/(新潟|長野)/.test(p)) return "shinetsu";
  if (/(富山|石川|福井)/.test(p)) return "hokuriku";
  if (/(岐阜|静岡|愛知|三重)/.test(p)) return "chubu";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山)/.test(p)) return "kinki";
  if (/(鳥取|島根|岡山|広島|山口)/.test(p)) return "chugoku";
  if (/(徳島|香川|愛媛|高知)/.test(p)) return "shikoku";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島)/.test(p)) return "kyushu";
  if (/沖縄/.test(p)) return "okinawa";
  return "unknown";
}

function shippingFeeByRegionAndSize(region, size) {
  const base =
    {
      hokkaido: 1200,
      tohoku: 950,
      kanto: 850,
      shinetsu: 850,
      hokuriku: 800,
      chubu: 800,
      kinki: 850,
      chugoku: 900,
      shikoku: 950,
      kyushu: 1050,
      okinawa: 1400,
      unknown: 999,
    }[region] ?? 999;

  const up = size <= 60 ? 0 : size <= 80 ? 120 : size <= 100 ? 240 : size <= 120 ? 420 : 620;
  return Math.round(base + up);
}

function calcShippingUnified(items, prefecture) {
  const safeItems = Array.isArray(items) ? items : [];
  const totalQty = safeItems.reduce((a, it) => a + Number(it.qty || 0), 0);

  const akashaQty = safeItems.filter(isAkasha6).reduce((a, it) => a + Number(it.qty || 0), 0);
  const originalQty = safeItems.filter(isOriginalSet).reduce((a, it) => a + Number(it.qty || 0), 0);

  let size = 60;
  if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else if (akashaQty > 0) size = sizeFromAkasha6Qty(akashaQty);
  else size = sizeFromTotalQty(totalQty);

  const region = prefToRegion(prefecture);
  const fee = shippingFeeByRegionAndSize(region, size);
  return { size, region, fee };
}

// ================= Flex builders =================
function productFlex(products) {
  const bubbles = products.map((p) => {
    const imgUrl = p.image ? `${BASE_URL}/public/uploads/${p.image}` : `${BASE_URL}/public/noimage.png`;
    return {
      type: "bubble",
      hero: { type: "image", url: imgUrl, size: "full", aspectMode: "cover", aspectRatio: "20:13" },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name || "", weight: "bold", wrap: true, size: "md" },
          { type: "text", text: `価格：${Number(p.price || 0)}円`, size: "sm", color: "#555555" },
          p.volume ? { type: "text", text: `内容量：${p.volume}`, size: "sm", color: "#555555" } : null,
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true, color: "#666666" } : null,
          { type: "text", text: `在庫：${Number(p.stock || 0)}`, size: "sm", color: "#555555" },
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [{ type: "button", style: "primary", action: { type: "message", label: "この商品を注文", text: `注文 ${p.id}` } }],
      },
    };
  });

  return { type: "flex", altText: "商品一覧", contents: { type: "carousel", contents: bubbles.slice(0, 10) } };
}

function confirmFlex(product, qty, addressObj) {
  const price = Number(product.price || 0);
  const subtotal = price * qty;

  const pref = addressObj?.prefecture || "";
  const items = [{ id: product.id, name: product.name, qty, price }];

  let shipping = null;
  if (pref) shipping = calcShippingUnified(items, pref);

  const total = subtotal + (shipping?.fee || 0);

  const addrText = addressObj
    ? `〒${addressObj.postal || ""}\n${addressObj.prefecture || ""}${addressObj.city || ""}${addressObj.address1 || ""}\n${addressObj.address2 || ""}`
    : "（住所未登録）";

  return {
    type: "flex",
    altText: "注文内容の確認",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "ご注文内容の確認", weight: "bold", size: "lg" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              { type: "text", text: product.name, weight: "bold", wrap: true },
              product.volume ? { type: "text", text: `内容量：${product.volume}`, size: "sm", color: "#555555" } : null,
              { type: "text", text: `単価：${price}円`, size: "sm", color: "#555555" },
              { type: "text", text: `数量：${qty}`, size: "sm", color: "#555555" },
              { type: "text", text: `小計：${subtotal}円`, size: "sm", color: "#555555" },
            ].filter(Boolean),
          },
          { type: "separator" },
          { type: "box", layout: "vertical", spacing: "sm", contents: [{ type: "text", text: "お届け先", weight: "bold" }, { type: "text", text: addrText, size: "sm", wrap: true, color: "#555555" }] },
          shipping
            ? { type: "box", layout: "vertical", spacing: "xs", contents: [{ type: "text", text: `送料：${shipping.fee}円`, size: "sm" }, { type: "text", text: `梱包サイズ：${shipping.size}`, size: "xs", color: "#666666" }] }
            : { type: "text", text: "送料：住所未登録のため計算できません", size: "sm", color: "#b91c1c", wrap: true },
          { type: "separator" },
          { type: "text", text: `合計：${total}円`, weight: "bold", size: "lg" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", action: { type: "message", label: "注文確定", text: `確定 ${product.id} ${qty}` } },
          { type: "button", style: "secondary", action: { type: "message", label: "キャンセル", text: "キャンセル" } },
        ],
      },
    },
  };
}

// ================= Admin auth =================
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  if (String(key) !== String(ADMIN_API_KEY)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}
function adminPageGate(req) {
  if (!ADMIN_API_KEY) return true;
  const key = req.query.api_key || req.headers["x-api-key"] || "";
  return String(key) === String(ADMIN_API_KEY);
}

// ================= LINE Webhook =================
// ★重要：署名検証が壊れないように /webhook は body parser より前
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
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

// ================= Body Parsers =================
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= Health / Root =================
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/", (req, res) => res.status(200).send("OK"));

// ================= API (public) =================
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();
    res.json({ ok: true, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/shipping", async (req, res) => {
  try {
    const { items, prefecture } = req.body || {};
    const r = calcShippingUnified(items, prefecture);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/liff/log", async (req, res) => {
  try {
    const { userId, event, meta } = req.body || {};
    if (userId) await touchUser(userId, "liff");
    if (pool && userId && event) {
      await pool.query(`INSERT INTO liff_logs (user_id, event, meta) VALUES ($1,$2,$3)`, [
        userId,
        String(event),
        meta || {},
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ================= Admin API =================
app.post("/api/admin/products/update", requireAdmin, async (req, res) => {
  try {
    const patch = normalizeProductPatch(req.body || {});
    if (!patch.id) return res.status(400).json({ ok: false, error: "id is required" });

    const products = await loadProducts();
    const idx = products.findIndex((p) => String(p.id) === String(patch.id));

    if (idx >= 0) products[idx] = { ...products[idx], ...patch };
    else {
      products.push({
        id: patch.id,
        name: patch.name || patch.id,
        price: Number.isFinite(patch.price) ? patch.price : 0,
        stock: Number.isFinite(patch.stock) ? patch.stock : 0,
        volume: patch.volume || "",
        desc: patch.desc || "",
        image: patch.image || "",
      });
    }

    await saveProducts(products);
    res.json({ ok: true, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const fn = req.file?.filename || "";
    res.json({ ok: true, filename: fn, url: `${BASE_URL}/public/uploads/${fn}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true, orders: [] });
    const status = String(req.query.status || "").trim();
    const limit = clampInt(req.query.limit || 50, 1, 300) || 50;

    const where = status ? "WHERE status=$1" : "";
    const params = status ? [status] : [];
    const r = await pool.query(
      `
      SELECT id, user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, created_at
      FROM orders
      ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `,
      params
    );
    res.json({ ok: true, orders: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/orders/notify-shipped", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: "DB not configured" });

    const orderId = clampInt(req.body?.order_id, 1, 1e9);
    const tracking = String(req.body?.tracking || "").trim();
    if (!orderId) return res.status(400).json({ ok: false, error: "order_id is required" });

    const r = await pool.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
    const order = r.rows[0];
    if (!order) return res.status(404).json({ ok: false, error: "order not found" });

    await pool.query(`UPDATE orders SET status='shipped' WHERE id=$1`, [orderId]);

    if (order.user_id) {
      const msg = tracking ? `発送しました。\n追跡番号：${tracking}\nご利用ありがとうございました。` : `発送しました。\nご利用ありがとうございました。`;
      try {
        await client.pushMessage(order.user_id, { type: "text", text: msg });
      } catch {}
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/admin/friends/today", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true, date: nowJSTDateString(), added: 0, removed: 0, net: 0 });

    const today = nowJSTDateString();
    const start = new Date(`${today}T00:00:00+09:00`).toISOString();

    const add = await pool.query(`SELECT COUNT(*)::int AS n FROM message_events WHERE kind='follow' AND created_at >= $1`, [start]);
    const remove = await pool.query(`SELECT COUNT(*)::int AS n FROM message_events WHERE kind IN ('unfollow','blocked') AND created_at >= $1`, [start]);

    const added = add.rows[0]?.n || 0;
    const removed = remove.rows[0]?.n || 0;
    res.json({ ok: true, date: today, added, removed, net: added - removed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/segment/build", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: "DB not configured" });

    const segment_key = String(req.body?.segment_key || "").trim();
    const rule = String(req.body?.rule || "liff_openers_not_purchased").trim();
    if (!segment_key) return res.status(400).json({ ok: false, error: "segment_key is required" });

    let sql = "";
    if (rule === "all") {
      sql = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, user_id
        FROM segment_users
        WHERE user_id IS NOT NULL AND user_id <> ''
        ON CONFLICT DO NOTHING
      `;
    } else if (rule === "liff_openers") {
      sql = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, user_id
        FROM segment_users
        WHERE last_liff_at IS NOT NULL AND user_id IS NOT NULL AND user_id <> ''
        ON CONFLICT DO NOTHING
      `;
    } else if (rule === "not_purchased") {
      sql = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, s.user_id
        FROM segment_users s
        LEFT JOIN (SELECT DISTINCT user_id FROM orders) o ON o.user_id = s.user_id
        WHERE o.user_id IS NULL AND s.user_id IS NOT NULL AND s.user_id <> ''
        ON CONFLICT DO NOTHING
      `;
    } else {
      sql = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, s.user_id
        FROM segment_users s
        LEFT JOIN (SELECT DISTINCT user_id FROM orders) o ON o.user_id = s.user_id
        WHERE s.last_liff_at IS NOT NULL
          AND o.user_id IS NULL
          AND s.user_id IS NOT NULL AND s.user_id <> ''
        ON CONFLICT DO NOTHING
      `;
    }

    await pool.query(sql, [segment_key]);
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM segment_blast WHERE segment_key=$1`, [segment_key]);
    res.json({ ok: true, segment_key, count: cnt.rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/segment/send", requireAdmin, async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: "DB not configured" });

    const segment_key = String(req.body?.segment_key || "").trim();
    const text = String(req.body?.text || "").trim();
    const flex_json = String(req.body?.flex_json || "").trim();

    if (!segment_key) return res.status(400).json({ ok: false, error: "segment_key is required" });
    if (!text && !flex_json) return res.status(400).json({ ok: false, error: "text or flex_json is required" });

    const r = await pool.query(`SELECT user_id FROM segment_blast WHERE segment_key=$1`, [segment_key]);
    const ids = r.rows.map((x) => x.user_id).filter(Boolean);
    if (ids.length === 0) return res.json({ ok: true, sent: 0 });

    const messages = [];
    if (text) messages.push({ type: "text", text });
    if (flex_json) {
      let obj = null;
      try {
        obj = JSON.parse(flex_json);
      } catch {
        return res.status(400).json({ ok: false, error: "flex_json must be valid JSON string" });
      }
      messages.push(obj);
    }

    let sent = 0;
    for (const part of chunks(ids, 500)) {
      try {
        await client.multicast(part, messages);
        sent += part.length;
      } catch (e) {
        console.error("multicast error:", e?.message || e);
      }
    }

    res.json({ ok: true, segment_key, sent });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ================= Admin page =================
app.get("/admin", (req, res) => {
  if (!adminPageGate(req)) return res.status(401).send("unauthorized");
  res.type("html").send(`OK`);
});

// ================= LINE handler =================
async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";

  if (userId) {
    try {
      await touchUser(userId, "seen");
      await upsertLineProfile(userId);
    } catch {}
  }

  if (ev.type === "follow") {
    if (userId) {
      await dbInsertMessageEvent(userId, "follow", ev);
      await touchUser(userId, "seen");
      await upsertLineProfile(userId);
    }
    return;
  }
  if (ev.type === "unfollow") {
    if (userId) await dbInsertMessageEvent(userId, "unfollow", ev);
    return;
  }

  if (ev.type !== "message" || ev.message.type !== "text") return;

  const text = String(ev.message.text || "").trim();
  const sess = userId ? getSession(userId) : null;

  if (/^キャンセル$/.test(text)) {
    if (userId) clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "キャンセルしました。" });
  }

  const isBoot = text === "直接注文" || text === "久助";
  const isKusukeInline = /^久助\s*\d{1,2}$/.test(text.replace(/[　]+/g, " "));
  const isOrder = /^注文\s+/.test(text);
  const isFix = /^確定\s+/.test(text);

  if (!sess && !isBoot && !isOrder && !isFix && !isKusukeInline) return;

  if (text === "直接注文") {
    await touchUser(userId, "chat");
    const products = await loadProducts();
    return client.replyMessage(ev.replyToken, [
      { type: "text", text: "商品一覧です。『この商品を注文』を押してください。" },
      productFlex(products),
    ]);
  }

  if (text === "久助") {
    await touchUser(userId, "chat");
    setSession(userId, "kusuke_qty", {});
    return client.replyMessage(ev.replyToken, { type: "text", text: "久助の個数を送ってください。\n例）久助 3" });
  }

  if (sess?.mode === "kusuke_qty") {
    await touchUser(userId, "chat");
    const qty = clampInt(text, 1, 99);
    if (!qty) return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 の数字で送ってください。（例：3）" });
    return handleKusukeQty(ev, userId, qty);
  }

  const mK = /^久助\s*(\d{1,2})$/.exec(text.replace(/[　]+/g, " "));
  if (mK) {
    await touchUser(userId, "chat");
    return handleKusukeQty(ev, userId, Number(mK[1]));
  }

  async function handleKusukeQty(ev, userId, qty) {
    const product = await getProductById("kusuke-250");
    if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "久助の商品データが見つかりません。" });

    const stock = Number(product.stock || 0);
    if (stock < qty) return client.replyMessage(ev.replyToken, { type: "text", text: `在庫が不足です（在庫 ${stock}）。` });

    let address = null;
    if (pool && userId) {
      const row = await dbGetAddressByUserId(userId);
      if (row) {
        address = {
          name: row.name || "",
          phone: row.phone || "",
          postal: row.postal || "",
          prefecture: row.prefecture || "",
          city: row.city || "",
          address1: row.address1 || "",
          address2: row.address2 || "",
        };
      }
    }

    setSession(userId, "confirm", { productId: product.id, qty });
    return client.replyMessage(ev.replyToken, [{ type: "text", text: "久助の注文内容です。" }, confirmFlex(product, qty, address)]);
  }
}

// ================= Start =================
(async () => {
  try {
    await ensureDb();

    if (!fs.existsSync(PRODUCTS_FILE)) {
      const initial = await loadProducts();
      await saveProducts(initial);
    }
  } catch (e) {
    console.error("init error:", e);
  }

  // ★超重要：Render 502 対策（IPv4で確実に待つ）
  app.listen(PORT, "0.0.0.0", () => console.log(`server listening on ${PORT}`));
})();
