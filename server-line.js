/**
 * server-line.js — 超フル機能版（Disk products.json + uploads + 住所DB + セグメント + 注文DB + 送料計算統一 + 管理画面/配信/発送通知/純増）
 *
 * ✅ 修正点（今回）
 * - DB既存テーブルが古くても落ちない：ALTER TABLE ADD COLUMN IF NOT EXISTS でマイグレーション
 * - /api/address/save, /api/address/get 追加（住所はDBに保存される）
 * - /api/shipping は { items, prefecture } を受けて { ok, fee, size, region } を返す
 * - /api/order/complete 追加（代引き確定が動く：DB保存 + products.json 在庫減算）
 * - Web側画像は /public/uploads/ + filename で表示（products.json は filename のみ）
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
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || ""; // 例: https://xxxx.onrender.com

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
app.use(cors());

// ---- request log (health確認に便利) ----
app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

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
function rand4() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ================= Products (Disk single source of truth) =================
async function loadProducts() {
  const fallback = [
    { id: "kusuke-250", name: "久助（われせん）", price: 340, stock: 30, volume: "100g", desc: "お得な割れせん。", image: "" },
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

// ================= DB schema (migrate-safe) =================
async function ensureDb() {
  if (!pool) return;

  // --- create if not exists ---
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

  // --- migrate older tables safely (IMPORTANT) ---
  // orders
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_fee INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS zip TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pref TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_event JSONB;`);

  // segment_users
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_liff_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP;`);

  // liff_logs
  await pool.query(`ALTER TABLE liff_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  // message_events
  await pool.query(`ALTER TABLE message_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  // line_users
  await pool.query(`ALTER TABLE line_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE line_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);

  // addresses
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS member_code TEXT;`);

  // indexes (created_atが無いと落ちてたので migrate後に作る)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_msg_events_created_at ON message_events(created_at DESC);`);
}

// ================= Segment touch =================
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
  return String(item?.id || "") === "original-set-2000";
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
  const base = {
    hokkaido: 1200, tohoku: 950, kanto: 850, shinetsu: 850, hokuriku: 800, chubu: 800,
    kinki: 850, chugoku: 900, shikoku: 950, kyushu: 1050, okinawa: 1400, unknown: 999,
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

// ================= Routes (no body parser BEFORE webhook) =================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ===== LINE Webhook (must be before express.json) =====
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

// ===== body parsers (AFTER webhook) =====
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ================= Public APIs =================

// products（Diskが正）
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();
    res.json({ ok: true, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 送料計算（統一）: {items, prefecture} -> {ok, fee, size, region}
app.post("/api/shipping", async (req, res) => {
  try {
    const { items, prefecture, address } = req.body || {};
    const pref = String(prefecture || address?.prefecture || address?.pref || "").trim();
    if (!pref) return res.status(400).json({ ok: false, error: "prefecture is required" });

    const r = calcShippingUnified(items, pref);
    res.json({ ok: true, fee: r.fee, size: r.size, region: r.region });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// LIFFログ（フロントから）: {userId, event, meta}
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

// 住所取得（DB）: {userId}
app.post("/api/address/get", async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: "DB not configured" });
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId is required" });

    const row = await dbGetAddressByUserId(userId);
    res.json({ ok: true, address: row || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 住所保存（DB）: {userId, address:{...}}
app.post("/api/address/save", async (req, res) => {
  try {
    if (!pool) return res.status(400).json({ ok: false, error: "DB not configured" });

    const userId = String(req.body?.userId || "").trim();
    const a = req.body?.address || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId is required" });

    const postal = String(a.postal || a.zip || "").trim();
    const prefecture = String(a.prefecture || a.pref || "").trim();
    const city = String(a.city || "").trim();
    const address1 = String(a.address1 || "").trim();
    const address2 = String(a.address2 || "").trim();
    const name = String(a.name || "").trim();
    const phone = String(a.phone || a.tel || "").trim();

    if (!postal || !prefecture || !city || !address1 || !name || !phone) {
      return res.status(400).json({ ok: false, error: "required fields missing" });
    }

    // member_code が無ければ生成（既存重複は軽く回避）
    let memberCode = null;
    const cur = await dbGetAddressByUserId(userId);
    if (cur?.member_code) memberCode = cur.member_code;
    if (!memberCode) {
      for (let i = 0; i < 30; i++) {
        const code = rand4();
        const chk = await pool.query(`SELECT 1 FROM addresses WHERE member_code=$1 LIMIT 1`, [code]);
        if (chk.rowCount === 0) { memberCode = code; break; }
      }
      if (!memberCode) memberCode = rand4();
    }

    await pool.query(
      `
      INSERT INTO addresses (user_id, member_code, name, phone, postal, prefecture, city, address1, address2, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
      ON CONFLICT (user_id) DO UPDATE SET
        member_code = COALESCE(addresses.member_code, EXCLUDED.member_code),
        name=$3, phone=$4, postal=$5, prefecture=$6, city=$7, address1=$8, address2=$9, updated_at=now()
      `,
      [userId, memberCode, name, phone, postal, prefecture, city, address1, address2]
    );

    res.json({ ok: true, member_code: memberCode });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 代引き注文確定（オンライン）: /api/order/complete
app.post("/api/order/complete", async (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const userId = String(body.lineUserId || "").trim();
    const address = body.address || {};

    if (!items.length) return res.status(400).json({ ok: false, error: "items is required" });
    if (!userId) return res.status(400).json({ ok: false, error: "lineUserId is required" });

    const name = String(address.name || "").trim();
    const phone = String(address.phone || "").trim();
    const postal = String(address.postal || "").trim();
    const pref = String(address.prefecture || "").trim();
    const city = String(address.city || "").trim();
    const addr1 = String(address.address1 || "").trim();
    const addr2 = String(address.address2 || "").trim();
    if (!name || !phone || !postal || !pref || !city || !addr1) {
      return res.status(400).json({ ok: false, error: "address is incomplete" });
    }

    // サーバ側で送料を再計算（改ざん防止）
    const normItems = items.map((it) => ({
      id: String(it.id || "").trim(),
      name: String(it.name || "").trim(),
      qty: clampInt(it.qty, 1, 99) || 0,
      price: Number(it.price || 0),
    })).filter((it) => it.id && it.qty > 0);

    if (!normItems.length) return res.status(400).json({ ok: false, error: "invalid items" });

    const ship = calcShippingUnified(normItems, pref);
    const itemsTotal = normItems.reduce((s, it) => s + Number(it.price || 0) * Number(it.qty || 0), 0);
    const COD_FEE = 330;
    const total = itemsTotal + ship.fee + COD_FEE;

    // 在庫減算（Disk products.json）
    const products = await loadProducts();
    for (const it of normItems) {
      const idx = products.findIndex((p) => String(p.id) === String(it.id));
      if (idx < 0) return res.status(400).json({ ok: false, error: `product not found: ${it.id}` });
      const stock = Number(products[idx].stock || 0);
      if (stock < it.qty) return res.status(400).json({ ok: false, error: `在庫不足: ${products[idx].name}（在庫${stock}）` });
    }
    for (const it of normItems) {
      const idx = products.findIndex((p) => String(p.id) === String(it.id));
      products[idx].stock = Number(products[idx].stock || 0) - it.qty;
    }
    await saveProducts(products);

    // DB保存
    let orderId = null;
    if (pool) {
      const r = await pool.query(
        `
        INSERT INTO orders (user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        RETURNING id
        `,
        [
          userId,
          "liff",
          normItems,
          total,
          ship.fee,
          "cod",
          "new",
          name,
          postal,
          pref,
          `${city}${addr1}${addr2 ? " " + addr2 : ""}`,
          body || {},
        ]
      );
      orderId = r.rows[0]?.id ?? null;
    }

    // 管理者通知（任意）
    if (ADMIN_USER_ID) {
      const lines = normItems.map((x) => `${x.name} x${x.qty}`).join("\n");
      const msg =
        `【オンライン(代引) 新規注文】\n` +
        `${lines}\n` +
        `商品:${itemsTotal}円\n送料:${ship.fee}円(サイズ${ship.size})\n代引:${COD_FEE}円\n合計:${total}円\n\n` +
        `${name}\n〒${postal}\n${pref}${city}${addr1}\n${addr2 || ""}\n` +
        `${phone}\n` +
        (orderId ? `注文ID: ${orderId}` : "");
      try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
    }

    res.json({ ok: true, order_id: orderId, shipping_fee: ship.fee, total });
  } catch (e) {
    console.error("order complete error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ================= Admin APIs =================
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

// ================= Admin page (簡易) =================
app.get("/admin", (req, res) => {
  if (!adminPageGate(req)) return res.status(401).send("unauthorized");
  res.type("html").send(`<html><body>admin ok</body></html>`);
});

// ================= LINE bot (既存挙動はそのまま) =================
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

function setSession(userId, mode, data = {}) { sessions.set(userId, { mode, data, updatedAt: Date.now() }); }
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) { sessions.delete(userId); return null; }
  return s;
}
function clearSession(userId) { sessions.delete(userId); }

async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";

  if (userId) {
    try { await touchUser(userId, "seen"); await upsertLineProfile(userId); } catch {}
  }

  if (ev.type === "follow") {
    if (userId) { await dbInsertMessageEvent(userId, "follow", ev); }
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
    return client.replyMessage(ev.replyToken, { type: "text", text: `商品一覧はミニアプリをご利用ください。` });
  }

  // ここは必要ならあなたの既存Flex版を戻してOK（今回は省略）
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

  app.listen(PORT, () => console.log(`server listening on ${PORT}`));
})();
