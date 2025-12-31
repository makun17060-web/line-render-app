/**
 * server-line.js — 最終 完全版（Disk products.json + uploads + 住所DB + セグメント + 注文DB + 送料計算統一）
 *
 * ✅ 直した点（あなたの現状に合わせて確実に効くやつ）
 * - Render 502対策：/health を常に 200 で返す（ヘルスチェック用）
 * - products.html の画像が出ない対策：/api/products の image を「/public/uploads/xxx」に変換して返す
 * - Disk：UPLOAD_DIR(/var/data/uploads) を /public/uploads で静的配信
 * - DB：addresses に住所を保存 / 取得（/api/address/save /api/address/get）
 * - products.html の起動ログ：/api/liff/open を実装（kind="all" 受ける）
 * - 既存DB列不足で落ちる対策：ensureDb() で ALTER TABLE ... IF NOT EXISTS を実行
 *
 * ✅ 仕様（維持）
 * - 起動キーワード：「直接注文」「久助」だけ（それ以外は無反応）
 * - セッション中の入力（数量など）は受け付ける
 *
 * ✅ 必須ENV
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - DATABASE_URL（DB機能を使うなら必須）
 *
 * ✅ 任意ENV
 * - PRODUCTS_FILE（デフォルト /var/data/products.json）
 * - UPLOAD_DIR（デフォルト /var/data/uploads）
 * - BASE_URL（例 https://xxxxx.onrender.com）※Flex画像URLに使う（無くても動くがFlex画像が相対になりやすい）
 * - ADMIN_USER_ID（管理者へ新規注文通知）
 * - ADMIN_API_KEY（管理API保護）
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

// ===================== ENV =====================
const PORT = process.env.PORT || 10000;

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");

const DATABASE_URL = process.env.DATABASE_URL || "";
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const BASE_URL = String(process.env.BASE_URL || "").replace(/\/+$/, "");
const ADMIN_USER_ID = String(process.env.ADMIN_USER_ID || "").trim();
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();

const PRODUCTS_FILE = process.env.PRODUCTS_FILE || "/var/data/products.json";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/var/data/uploads";

// ===================== LINE SDK =====================
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);

// ===================== APP =====================
const app = express();
app.use(cors());

// --- request log ---
app.use((req, res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ===================== DISK DIR =====================
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDirSync(path.dirname(PRODUCTS_FILE));
ensureDirSync(UPLOAD_DIR);

// ===================== STATIC =====================
// /public はプロジェクト内 public フォルダ
app.use("/public", express.static(path.join(__dirname, "public")));
// /public/uploads は Disk の UPLOAD_DIR を配信
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ===================== HEALTH =====================
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, ts: new Date().toISOString() }));

// ===================== WEBHOOK（json parser より前）=====================
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

// ===================== BODY PARSER（webhookの後）=====================
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ===================== MULTER（Upload）=====================
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}_${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ===================== UTIL =====================
function toNum(x, fallback = 0) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}
function clampInt(x, min, max) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return Math.max(min, Math.min(max, t));
}
function asPublicUploadUrl(filename) {
  if (!filename) return "";
  const f = String(filename).trim();
  if (!f) return "";
  if (/^https?:\/\//i.test(f)) return f;
  if (f.startsWith("/public/")) return f;
  return `/public/uploads/${f}`;
}
function stripUploadPathToFilename(x) {
  const s = String(x || "").trim();
  if (!s) return "";
  const m = s.match(/\/public\/uploads\/([^/?#]+)/);
  if (m) return m[1];
  return s;
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

// ===================== PRODUCTS (Disk) =====================
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
  if (patch.price != null) out.price = toNum(patch.price, 0);
  if (patch.stock != null) out.stock = toNum(patch.stock, 0);
  if (patch.volume != null) out.volume = String(patch.volume);
  if (patch.desc != null) out.desc = String(patch.desc);
  if (patch.image != null) out.image = stripUploadPathToFilename(patch.image);
  return out;
}

// ===================== SHIPPING（統一ロジック）=====================
function isOriginalSet(item) {
  return String(item?.id || "") === "original-set-2000";
}
/**
 * ★重要：久助を akasha 扱いに含める（送料サイズ判定が同じ／混載同梱）
 */
function isAkasha6(item) {
  const id = String(item?.id || "");
  const name = String(item?.name || "");
  if (id === "kusuke-250" || /久助/.test(name)) return true;
  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}
function sizeFromAkasha6Qty(qty) {
  if (qty <= 2) return 60;
  if (qty <= 4) return 80;
  if (qty <= 6) return 100;
  if (qty <= 8) return 120;
  return 140;
}
function sizeFromOriginalSetQty(qty) {
  // あなたの仕様：1=80 / 2=100 / 3-4=120 / 5-6=140
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
// ※送料テーブルは必要なら後で差し替えOK（まずは動く統一計算）
function shippingFeeByRegionAndSize(region, size) {
  const base = {
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
  const totalQty = safeItems.reduce((a, it) => a + toNum(it.qty, 0), 0);

  const akashaQty = safeItems.filter(isAkasha6).reduce((a, it) => a + toNum(it.qty, 0), 0);
  const originalQty = safeItems.filter(isOriginalSet).reduce((a, it) => a + toNum(it.qty, 0), 0);

  let size = 60;
  if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else if (akashaQty > 0) size = sizeFromAkasha6Qty(akashaQty);
  else size = sizeFromTotalQty(totalQty);

  const region = prefToRegion(prefecture);
  const fee = shippingFeeByRegionAndSize(region, size);
  return { size, region, fee };
}

// ===================== DB: ensure / helpers =====================
async function ensureDb() {
  if (!pool) return;

  // 1) create tables
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

  // 2) migrate columns (既存DBが古くても落ちない)
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS items JSONB;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS total INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_fee INTEGER;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS zip TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS pref TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS raw_event JSONB;`);

  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS member_code TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS postal TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS prefecture TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS city TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address1 TEXT;`);
  await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address2 TEXT;`);

  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_liff_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMP;`);

  await pool.query(`ALTER TABLE liff_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE message_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE segment_blast ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);

  // 3) index
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
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
  } catch {
    // ignore
  }
}

async function dbGetAddressByUserId(userId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT * FROM addresses WHERE user_id=$1`, [userId]);
  return r.rows[0] || null;
}

async function dbUpsertAddress(userId, a) {
  if (!pool) throw new Error("DB not configured");
  await pool.query(
    `
    INSERT INTO addresses
      (user_id, name, phone, postal, prefecture, city, address1, address2, updated_at)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8, now())
    ON CONFLICT (user_id) DO UPDATE SET
      name=$2, phone=$3, postal=$4, prefecture=$5, city=$6, address1=$7, address2=$8, updated_at=now()
  `,
    [
      userId,
      String(a?.name || ""),
      String(a?.phone || ""),
      String(a?.postal || ""),
      String(a?.prefecture || ""),
      String(a?.city || ""),
      String(a?.address1 || ""),
      String(a?.address2 || ""),
    ]
  );
}

async function dbInsertMessageEvent(userId, kind, raw_event) {
  if (!pool || !userId) return;
  await pool.query(`INSERT INTO message_events (user_id, kind, raw_event) VALUES ($1,$2,$3)`, [
    userId,
    String(kind),
    raw_event || {},
  ]);
}

// ===================== API =====================

// --- products（Disk → 画像URL変換して返す）---
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();
    const out = products.map((p) => ({
      ...p,
      image: p.image ? asPublicUploadUrl(p.image) : "",
    }));
    res.json({ ok: true, products: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- shipping（confirm.js 用）---
app.post("/api/shipping", async (req, res) => {
  try {
    const { items, prefecture } = req.body || {};
    const r = calcShippingUnified(items, prefecture);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- LIFF open log（products.html が叩く）---
app.post("/api/liff/open", async (req, res) => {
  try {
    const { userId, kind } = req.body || {};
    if (userId) await touchUser(String(userId), "liff");
    if (pool && userId) {
      await pool.query(`INSERT INTO liff_logs (user_id, event, meta) VALUES ($1,$2,$3)`, [
        String(userId),
        "open",
        { kind: kind || "all" },
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --- address save/get（LIFF住所入力用）---
app.post("/api/address/save", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });

    const { userId, postal, prefecture, city, address1, address2, name, phone } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId is required" });

    if (!postal || !prefecture || !city || !address1 || !name || !phone) {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    await dbUpsertAddress(String(userId), { postal, prefecture, city, address1, address2, name, phone });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/address/get", async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "DB not configured" });
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId is required" });
    const row = await dbGetAddressByUserId(userId);
    res.json({ ok: true, address: row || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===================== ADMIN API（必要なら使う）=====================
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next(); // 未設定なら保護なし
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  if (String(key) !== String(ADMIN_API_KEY)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// 商品更新（Disk products.json）
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
        price: toNum(patch.price, 0),
        stock: toNum(patch.stock, 0),
        volume: patch.volume || "",
        desc: patch.desc || "",
        image: patch.image || "",
      });
    }

    await saveProducts(products);
    res.json({
      ok: true,
      products: products.map((p) => ({ ...p, image: p.image ? asPublicUploadUrl(p.image) : "" })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 画像アップロード（Disk UPLOAD_DIR）
app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const filename = req.file?.filename || "";
    res.json({ ok: true, filename, url: `${BASE_URL}${asPublicUploadUrl(filename)}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 注文一覧（管理）
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

// ===================== LINE BOT（セッション）=====================
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

// Flex（商品一覧）
function productFlex(products) {
  const bubbles = products.slice(0, 10).map((p) => {
    const imgPath = p.image ? asPublicUploadUrl(p.image) : "/public/noimage.png";
    const imgUrl = BASE_URL ? `${BASE_URL}${imgPath}` : imgPath;

    return {
      type: "bubble",
      hero: {
        type: "image",
        url: imgUrl,
        size: "full",
        aspectMode: "cover",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name || "", weight: "bold", wrap: true, size: "md" },
          { type: "text", text: `価格：${toNum(p.price, 0)}円`, size: "sm", color: "#555555" },
          p.volume ? { type: "text", text: `内容量：${p.volume}`, size: "sm", color: "#555555" } : null,
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true, color: "#666666" } : null,
          { type: "text", text: `在庫：${toNum(p.stock, 0)}個`, size: "sm", color: "#555555" },
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "button", style: "primary", action: { type: "message", label: "この商品を注文", text: `注文 ${p.id}` } },
        ],
      },
    };
  });

  return { type: "flex", altText: "商品一覧", contents: { type: "carousel", contents: bubbles } };
}

// Flex（確認）
function confirmFlex(product, qty, addressObj) {
  const price = toNum(product.price, 0);
  const subtotal = price * qty;

  const items = [{ id: product.id, name: product.name, qty, price }];
  const pref = addressObj?.prefecture || "";
  const shipping = pref ? calcShippingUnified(items, pref) : null;
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
          { type: "text", text: "お届け先", weight: "bold" },
          { type: "text", text: addrText, size: "sm", wrap: true, color: "#555555" },
          shipping
            ? {
                type: "box",
                layout: "vertical",
                spacing: "xs",
                contents: [
                  { type: "text", text: `送料：${shipping.fee}円`, size: "sm", color: "#111111" },
                  { type: "text", text: `梱包サイズ：${shipping.size}`, size: "xs", color: "#666666" },
                ],
              }
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

// ===================== LINE EVENT HANDLER（1回だけ定義：ここが最終）=====================
async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";

  // 既知ユーザーtouch
  if (userId) {
    try {
      await touchUser(userId, "seen");
      await upsertLineProfile(userId);
    } catch {}
  }

  // follow/unfollow
  if (ev.type === "follow") {
    if (userId) await dbInsertMessageEvent(userId, "follow", ev);
    return;
  }
  if (ev.type === "unfollow") {
    if (userId) await dbInsertMessageEvent(userId, "unfollow", ev);
    return;
  }

  if (ev.type !== "message" || ev.message.type !== "text") return;

  const text = String(ev.message.text || "").trim();

  const sess = userId ? getSession(userId) : null;
  const isBoot = text === "直接注文" || text === "久助";
  const isKusukeInline = /^久助\s*\d{1,2}$/.test(text.replace(/[　]+/g, " "));
  const isOrderCmd = /^注文\s+/.test(text);
  const isConfirmCmd = /^確定\s+/.test(text);

  // ★起動キーワード以外は無反応（ただしセッション中/注文系は許可）
  if (!sess && !isBoot && !isKusukeInline && !isOrderCmd && !isConfirmCmd) return;

  if (text === "キャンセル") {
    if (userId) clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "キャンセルしました。" });
  }

  // 直接注文：一覧
  if (text === "直接注文") {
    if (userId) await touchUser(userId, "chat");
    const products = await loadProducts();
    return client.replyMessage(ev.replyToken, [
      { type: "text", text: "商品一覧です。『この商品を注文』を押してください。" },
      productFlex(products),
    ]);
  }

  // 久助：数量待ち
  if (text === "久助") {
    if (userId) await touchUser(userId, "chat");
    setSession(userId, "kusuke_qty", {});
    return client.replyMessage(ev.replyToken, { type: "text", text: "久助の個数を送ってください。\n例）久助 3" });
  }

  // 久助 3 形式
  const mK = /^久助\s*(\d{1,2})$/.exec(text.replace(/[　]+/g, " "));
  if (mK) {
    const qty = Number(mK[1]);
    return handleQtyFlow(ev, userId, "kusuke-250", qty);
  }

  // セッション：久助数量
  if (sess?.mode === "kusuke_qty") {
    const qty = clampInt(text, 1, 99);
    if (!qty) return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 の数字で送ってください。（例：3）" });
    return handleQtyFlow(ev, userId, "kusuke-250", qty);
  }

  // 注文 <id>
  const mOrder = /^注文\s+(.+)$/.exec(text);
  if (mOrder) {
    if (userId) await touchUser(userId, "chat");
    const pid = String(mOrder[1]).trim();
    const product = await getProductById(pid);
    if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
    setSession(userId, "qty", { productId: pid });
    return client.replyMessage(ev.replyToken, { type: "text", text: "数量を送ってください（例：3）" });
  }

  // セッション：数量
  if (sess?.mode === "qty") {
    const qty = clampInt(text, 1, 99);
    if (!qty) return client.replyMessage(ev.replyToken, { type: "text", text: "数量は 1〜99 の数字で送ってください。" });
    return handleQtyFlow(ev, userId, sess.data.productId, qty);
  }

  // 確定 <id> <qty>
  const mFix = /^確定\s+(\S+)\s+(\d{1,2})$/.exec(text);
  if (mFix) {
    const pid = String(mFix[1]);
    const qty = Number(mFix[2]);
    return handleConfirmFlow(ev, userId, pid, qty);
  }

  if (sess) {
    return client.replyMessage(ev.replyToken, { type: "text", text: "入力が確認できませんでした。もう一度お願いします。（キャンセルも可）" });
  }
}

// 共通：数量→確認Flex
async function handleQtyFlow(ev, userId, productId, qty) {
  if (userId) await touchUser(userId, "chat");

  const product = await getProductById(productId);
  if (!product) {
    clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
  }

  const stock = toNum(product.stock, 0);
  if (stock < qty) {
    return client.replyMessage(ev.replyToken, { type: "text", text: `在庫が不足です（在庫 ${stock}）。個数を減らして送ってください。` });
  }

  let addressObj = null;
  if (pool && userId) {
    const row = await dbGetAddressByUserId(userId);
    if (row) {
      addressObj = {
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
  return client.replyMessage(ev.replyToken, [{ type: "text", text: "注文内容です。" }, confirmFlex(product, qty, addressObj)]);
}

// 共通：確定→在庫減算→orders保存→通知
async function handleConfirmFlow(ev, userId, productId, qty) {
  if (userId) await touchUser(userId, "chat");

  const product = await getProductById(productId);
  if (!product) {
    clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
  }

  const stock = toNum(product.stock, 0);
  if (stock < qty) {
    clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: `在庫が不足です（在庫 ${stock}）。` });
  }

  if (!pool) {
    clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "DB未設定のため確定できません（DATABASE_URL を設定してください）。" });
  }

  const addressRow = await dbGetAddressByUserId(userId);
  if (!addressRow) {
    clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "住所が未登録のため確定できません。\n先に住所登録（LIFF）をお願いします。" });
  }

  const addressObj = {
    name: addressRow.name || "",
    phone: addressRow.phone || "",
    postal: addressRow.postal || "",
    prefecture: addressRow.prefecture || "",
    city: addressRow.city || "",
    address1: addressRow.address1 || "",
    address2: addressRow.address2 || "",
  };

  const price = toNum(product.price, 0);
  const subtotal = price * qty;

  const items = [{ id: product.id, name: product.name, qty, price }];
  const ship = calcShippingUnified(items, addressObj.prefecture);
  const total = subtotal + ship.fee;

  // 在庫減算（Disk）
  const products = await loadProducts();
  const idx = products.findIndex((p) => String(p.id) === String(product.id));
  if (idx >= 0) {
    const st = toNum(products[idx].stock, 0);
    if (st < qty) {
      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: `在庫が不足です（在庫 ${st}）。` });
    }
    products[idx].stock = st - qty;
    await saveProducts(products);
  }

  // 注文保存（DB）
  await pool.query(
    `
    INSERT INTO orders (user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
  `,
    [
      userId,
      "line",
      items,
      total,
      ship.fee,
      "cod",
      "new",
      addressObj.name,
      addressObj.postal,
      addressObj.prefecture,
      `${addressObj.city}${addressObj.address1}${addressObj.address2 ? " " + addressObj.address2 : ""}`,
      ev,
    ]
  );

  clearSession(userId);

  // 管理者通知
  if (ADMIN_USER_ID) {
    try {
      await client.pushMessage(ADMIN_USER_ID, {
        type: "text",
        text:
          `【新規注文】\n` +
          `${product.name} x${qty}\n` +
          `小計:${subtotal}円\n送料:${ship.fee}円(サイズ${ship.size})\n合計:${total}円\n\n` +
          `${addressObj.name}\n〒${addressObj.postal}\n${addressObj.prefecture}${addressObj.city}${addressObj.address1}\n${addressObj.address2 || ""}`,
      });
    } catch {}
  }

  return client.replyMessage(ev.replyToken, {
    type: "text",
    text:
      `ご注文を受け付けました。\n\n` +
      `${product.name} x${qty}\n` +
      `小計：${subtotal}円\n` +
      `送料：${ship.fee}円（サイズ${ship.size}）\n` +
      `合計：${total}円\n\n` +
      `発送準備ができ次第ご連絡します。`,
  });
}

// ===================== START =====================
(async () => {
  // products.json が無ければ初期作成（上書きしない）
  try {
    if (!fs.existsSync(PRODUCTS_FILE)) {
      const initial = await loadProducts();
      await saveProducts(initial);
    }
  } catch (e) {
    console.error("products init error:", e?.message || e);
  }

  // DB 初期化（失敗してもサーバは立てる：502回避）
  try {
    if (pool) await ensureDb();
  } catch (e) {
    console.error("ensureDb error:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`server listening on ${PORT}`);
    console.log(`PRODUCTS_FILE=${PRODUCTS_FILE}`);
    console.log(`UPLOAD_DIR=${UPLOAD_DIR}`);
  });
})();
