/**
 * server-line.js — フル機能版（Stripe + ミニアプリ + 画像管理 + 住所DB + セグメント配信 + 注文DB永続化）
 *
 * ✅ 重要：このファイルは「省略ゼロで単独で動く」完全版です
 *
 * --- 主な機能 ---
 * [注文]
 * - 商品一覧（Flex）
 * - 数量選択
 * - 受取方法（宅配 or 店頭受取）
 * - 支払方法（代引 / 銀行振込 / 店頭現金）
 * - 最終確認 → 確定（postback）
 * - 「その他（自由入力）」= 価格入力なし（商品名/数量だけ）
 * - 久助（1個250円税込）テキスト購入フロー（1〜99個）
 * - 予約（在庫不足時）
 * - 注文ログ：data/orders.log（JSONL）
 * - ★注文DB永続化：Postgres orders テーブル（再デプロイでも消えない）
 *
 * [Stripe]
 * - /api/pay-stripe（Checkout Session）
 * - /api/order/complete（決済完了通知 + ★DB保存 + 管理者/購入者通知）
 *
 * [住所]
 * - /api/liff/address（userIdでDB保存）
 * - /api/liff/address/me（userIdで取得）
 * - /api/public/address-by-code（トークン必須）
 *
 * [LIFF 起動ログ]
 * - /api/liff/open（kind=all統一運用）
 *
 * [セグメント配信]
 * - segment_users（DB or JSON）へ userId 台帳（チャット/LIFF/seen）
 * - /api/admin/segment/users（抽出）
 * - /api/admin/push/segment（push）
 *
 * [管理]
 * - /api/admin/orders（ファイルログ）
 * - /api/admin/orders-db（DB注文）★payment/sourceフィルタ対応
 * - /api/admin/products（一覧/更新）
 * - /api/admin/stock（在庫増減/設定）
 * - /api/admin/images（一覧/削除）
 * - /api/admin/ping /api/health
 *
 * [画像]
 * - /api/admin/upload（画像アップロード）
 * - /public/uploads に保存
 *
 * --- 必須 .env ---
 * LINE_CHANNEL_ACCESS_TOKEN
 * LINE_CHANNEL_SECRET
 * LIFF_ID
 * ADMIN_API_TOKEN  (推奨) もしくは ADMIN_CODE
 * DATABASE_URL     (orders DB保存したいなら必須)
 *
 * --- 推奨 .env ---
 * ADMIN_USER_ID（管理者へ通知）
 * PUBLIC_BASE_URL（Renderの https://xxxx.onrender.com ）
 * STRIPE_SECRET_KEY（Stripe使うなら）
 * LINE_CHANNEL_ID（LIFF idToken検証するなら）
 *
 * --- セキュリティ ---
 * /api/public/address-by-code は PUBLIC_ADDRESS_LOOKUP_TOKEN 必須
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const multer = require("multer");
const stripeLib = require("stripe");
const { Pool } = require("pg");

// =============== 基本 ===============
const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

const LIFF_ID = (process.env.LIFF_ID || "").trim();
const LIFF_ID_DIRECT_ADDRESS = (process.env.LIFF_ID_DIRECT_ADDRESS || LIFF_ID).trim();
const LIFF_ID_SHOP = (process.env.LIFF_ID_SHOP || "").trim(); // 任意
const LINE_CHANNEL_ID = (process.env.LINE_CHANNEL_ID || "").trim(); // 任意（idToken verify）

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const PUBLIC_ADDRESS_LOOKUP_TOKEN = (process.env.PUBLIC_ADDRESS_LOOKUP_TOKEN || "").trim();

const COD_FEE = Number(process.env.COD_FEE || 330);

// 久助はメモリ情報に基づき 250円で固定（優先）
const KUSUKE_UNIT_PRICE = 250;

// セグメント設定
const LIFF_OPEN_KIND_MODE = (process.env.LIFF_OPEN_KIND_MODE || "all").trim(); // "all" or "keep"
const SEGMENT_PUSH_LIMIT = Math.min(20000, Math.max(1, Number(process.env.SEGMENT_PUSH_LIMIT || 5000)));
const SEGMENT_CHUNK_SIZE = Math.min(500, Math.max(50, Number(process.env.SEGMENT_CHUNK_SIZE || 500)));

if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error(`ERROR: 必須envが不足しています
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- LIFF_ID
- ADMIN_API_TOKEN または ADMIN_CODE`);
  process.exit(1);
}

const client = new line.Client(config);

// =============== DB ===============
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

// =============== ルート / パーサ ===============
const jsonParser = express.json({ limit: "2mb" });
const urlParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  // webhook は署名検証に raw body が必要になるケースがあるためパーサを避ける
  if (req.path.startsWith("/webhook")) return next();
  return jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook")) return next();
  return urlParser(req, res, next);
});

app.use((req, _res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// =============== ディレクトリ & ファイル ===============
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use("/public", express.static(PUBLIC_DIR));

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");
const SEGMENT_USERS_PATH = path.join(DATA_DIR, "segment_users.json");

// 互換（旧JSON）
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");
const PHONE_ADDRESSES_PATH = path.join(DATA_DIR, "phone-addresses.json");

function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function safeWriteJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "original-set-2100", name: "磯屋オリジナルセット", price: 2100, stock: 10, desc: "人気の詰め合わせ。", image: "" },
    { id: "nori-square-300", name: "四角のりせん", price: 300, stock: 10, desc: "のり香る角せん。", image: "" },
    { id: "premium-ebi-400", name: "プレミアムえびせん", price: 400, stock: 5, desc: "贅沢な旨み。", image: "" },
    // 久助はミニアプリ一覧から除外。チャット購入専用（単価250固定）
    { id: "kusuke-250", name: "久助（えびせん）", price: KUSUKE_UNIT_PRICE, stock: 20, desc: "お得な割れせん。", image: "" },
  ];
  safeWriteJSON(PRODUCTS_PATH, sample);
}
if (!fs.existsSync(SESSIONS_PATH)) safeWriteJSON(SESSIONS_PATH, {});
if (!fs.existsSync(NOTIFY_STATE_PATH)) safeWriteJSON(NOTIFY_STATE_PATH, {});
if (!fs.existsSync(SEGMENT_USERS_PATH)) safeWriteJSON(SEGMENT_USERS_PATH, {});
if (!fs.existsSync(ADDRESSES_PATH)) safeWriteJSON(ADDRESSES_PATH, {});
if (!fs.existsSync(PHONE_ADDRESSES_PATH)) safeWriteJSON(PHONE_ADDRESSES_PATH, {});

const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (arr) => safeWriteJSON(PRODUCTS_PATH, arr);
const readSessions = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions = (obj) => safeWriteJSON(SESSIONS_PATH, obj);
const readNotifyState = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (obj) => safeWriteJSON(NOTIFY_STATE_PATH, obj);
const readSegmentUsers = () => safeReadJSON(SEGMENT_USERS_PATH, {});
const writeSegmentUsers = (obj) => safeWriteJSON(SEGMENT_USERS_PATH, obj);

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

// =============== 管理認証 ===============
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

// =============== 画像アップロード ===============
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || "image").replace(/[^\w.\-]+/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  },
});

function toPublicImageUrl(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;

  let fname = s;
  const last = s.lastIndexOf("/");
  if (last >= 0) fname = s.slice(last + 1);

  const pathPart = `/public/uploads/${fname}`;
  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (hostFromRender) return `https://${hostFromRender}${pathPart}`;
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}${pathPart}`;
  return pathPart;
}

// =============== 商品・在庫 ===============
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]); // ミニアプリ一覧から除外
const LOW_STOCK_THRESHOLD = 5;

function findProductById(id) {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === id);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}

function writeStockLog(entry) {
  try {
    fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  if (!ADMIN_USER_ID) return;
  if (stockNow >= LOW_STOCK_THRESHOLD) return;
  const msg = `⚠️ 在庫僅少\n商品：${productName}（${productId}）\n残り：${stockNow}個`;
  try {
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
  } catch {}
}

function addStock(productId, delta, actor = "system") {
  const d = Number(delta) || 0;
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  const after = Math.max(0, before + d);
  products[idx].stock = after;
  writeProducts(products);
  writeStockLog({ action: "add", productId, before, after, delta: d, actor });
  return { before, after };
}
function setStock(productId, qty, actor = "system") {
  const q = Math.max(0, Number(qty) || 0);
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  products[idx].stock = q;
  writeProducts(products);
  writeStockLog({ action: "set", productId, before, after: q, delta: q - before, actor });
  return { before, after: q };
}

// =============== 送料（ヤマト中部 税込） ===============
const YAMATO_CHUBU_TAXED = {
  "60": { 北海道: 1610, 東北: 1190, 関東: 940, 中部: 940, 近畿: 940, 中国: 1060, 四国: 1060, 九州: 1190, 沖縄: 1460 },
  "80": { 北海道: 1900, 東北: 1480, 関東: 1230, 中部: 1230, 近畿: 1230, 中国: 1350, 四国: 1350, 九州: 1480, 沖縄: 2070 },
  "100": { 北海道: 2200, 東北: 1790, 関東: 1530, 中部: 1530, 近畿: 1530, 中国: 1650, 四国: 1650, 九州: 1790, 沖縄: 2710 },
  "120": { 北海道: 2780, 東北: 2310, 関東: 2040, 中部: 2040, 近畿: 2040, 中国: 2170, 四国: 2170, 九州: 2310, 沖縄: 3360 },
  "140": { 北海道: 3440, 東北: 2930, 関東: 2630, 中部: 2630, 近畿: 2630, 中国: 2780, 四国: 2780, 九州: 2930, 沖縄: 4030 },
  "160": { 北海道: 3820, 東北: 3320, 関東: 3020, 中部: 3020, 近畿: 3020, 中国: 3160, 四国: 3160, 九州: 3320, 沖縄: 4680 },
};
const SIZE_ORDER = ["60", "80", "100", "120", "140", "160"];
const ORIGINAL_SET_PRODUCT_ID = (process.env.ORIGINAL_SET_PRODUCT_ID || "original-set-2100").trim();

function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.addr1 || address.address1 || "").trim();
  const hay = pref || addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if (/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿|関西)/.test(hay)) return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if (/(沖縄)/.test(hay)) return "沖縄";
  return "";
}

function isAkasha6(item) {
  const name = String(item?.name || "");
  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}
function sizeFromAkasha6Qty(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  if (q <= 4) return "60";
  if (q <= 8) return "80";
  if (q <= 13) return "100";
  if (q <= 18) return "120";
  return "140";
}
function sizeFromOriginalSetQty(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  if (q === 1) return "80";
  if (q === 2) return "100";
  if (q <= 4) return "120";
  if (q <= 6) return "140";
  return "160";
}
function sizeFromTotalQty(totalQty) {
  const q = Number(totalQty) || 0;
  if (q <= 1) return "60";
  if (q === 2) return "80";
  if (q === 3) return "100";
  if (q <= 4) return "120";
  if (q <= 6) return "140";
  return "160";
}
function calcYamatoShipping(region, size) {
  if (!region) return 0;
  const table = YAMATO_CHUBU_TAXED[String(size)] || null;
  if (!table) return 0;
  return Number(table[region] || 0);
}
function calcShippingUnified(items = [], address = {}) {
  const region = detectRegionFromAddress(address);
  const totalQty = items.reduce((s, it) => s + Number(it.qty || 0), 0);
  const akasha6Qty = items.reduce((s, it) => s + (isAkasha6(it) ? Number(it.qty || 0) : 0), 0);
  const originalQty = items.reduce((s, it) => {
    return s + ((it.id === ORIGINAL_SET_PRODUCT_ID || /磯屋.?オリジナルセ/.test(it.name || "")) ? Number(it.qty || 0) : 0);
  }, 0);

  let size;
  if (akasha6Qty > 0) size = sizeFromAkasha6Qty(akasha6Qty);
  else if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else size = sizeFromTotalQty(totalQty);

  const shipping = calcYamatoShipping(region, size);
  return { region, size, shipping };
}

// =============== DBスキーマ ===============
function rand4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

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
    CREATE TABLE IF NOT EXISTS liff_open_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      opened_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_kind_time ON liff_open_logs(kind, opened_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_user ON liff_open_logs(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen  TIMESTAMPTZ DEFAULT NOW(),
      last_chat_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_seen ON segment_users(last_seen DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_chat ON segment_users(last_chat_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_liff ON segment_users(last_liff_at DESC);`);

  // ★注文 永続保存（payment_method/status は必ず入る）
  await p.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),

      user_id TEXT,
      member_code CHAR(4),
      phone TEXT,

      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total INT NOT NULL DEFAULT 0,
      shipping_fee INT NOT NULL DEFAULT 0,

      payment_method TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'new',

      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,

      source TEXT,
      raw_event JSONB
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_member_code ON orders(member_code);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);`);

  // 既存DBの安全補正（失敗しても起動は続ける）
  try {
    await p.query(`ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT 'unknown'`);
    await p.query(`UPDATE orders SET payment_method='unknown' WHERE payment_method IS NULL OR payment_method=''`);
    await p.query(`ALTER TABLE orders ALTER COLUMN payment_method SET NOT NULL`);

    await p.query(`ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'new'`);
    await p.query(`UPDATE orders SET status='new' WHERE status IS NULL OR status=''`);
    await p.query(`ALTER TABLE orders ALTER COLUMN status SET NOT NULL`);
  } catch (e) {
    console.warn("[BOOT] orders migration skipped:", e?.message || e);
  }
}

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

    const c = await p.connect();
    try {
      await c.query("BEGIN");
      await c.query(`INSERT INTO codes (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);

      const cur = await c.query(`SELECT member_code, address_code FROM codes WHERE user_id=$1 FOR UPDATE`, [uid]);
      const row = cur.rows[0] || {};
      const nextMember = row.member_code ? row.member_code : mc;
      const nextAddress = row.address_code ? row.address_code : ac;

      await c.query(`UPDATE codes SET member_code=$2, address_code=$3 WHERE user_id=$1`, [uid, nextMember, nextAddress]);
      await c.query("COMMIT");

      const done = await dbGetCodesByUserId(uid);
      if (done?.member_code && done?.address_code) return done;
    } catch (e) {
      await c.query("ROLLBACK");
      if (String(e?.code) === "23505") continue;
      throw e;
    } finally {
      c.release();
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
    INSERT INTO addresses (member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
    ON CONFLICT (member_code) DO UPDATE SET
      user_id=EXCLUDED.user_id,
      name=EXCLUDED.name,
      phone=EXCLUDED.phone,
      postal=EXCLUDED.postal,
      prefecture=EXCLUDED.prefecture,
      city=EXCLUDED.city,
      address1=EXCLUDED.address1,
      address2=EXCLUDED.address2,
      updated_at=NOW()
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
    SELECT
      c.user_id, c.member_code, c.address_code,
      a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2, a.updated_at
    FROM codes c
    LEFT JOIN addresses a ON a.member_code = c.member_code
    WHERE c.user_id = $1
    LIMIT 1
    `,
    [uid]
  );

  const row = r.rows[0] || null;
  if (!row?.member_code) return null;
  const hasAny = row.name || row.phone || row.postal || row.prefecture || row.city || row.address1 || row.address2;
  if (!hasAny) return null;
  return row;
}

async function dbGetAddressByMemberCode(memberCode) {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) return null;
  const r = await p.query(`SELECT * FROM addresses WHERE member_code=$1 LIMIT 1`, [mc]);
  return r.rows[0] || null;
}

// ★注文DB保存（payment_method/source を必ず整形してから保存）
async function dbInsertOrder(payload) {
  if (!pool) return { ok: false, skipped: "db_not_configured" };
  const p = mustPool();

  const {
    userId = null,
    memberCode = null,
    phone = null,
    items = [],
    total = 0,
    shippingFee = 0,

    paymentMethod = null, // stripe/cod/bank/store/unknown
    status = "new",

    name = null,
    zip = null,
    pref = null,
    address = null,

    source = null,
    rawEvent = null,
  } = payload || {};

  // --- フェイルセーフ補完 ---
  const src = String(source || rawEvent?.source || "").toLowerCase().trim();
  const payFromEvent = String(rawEvent?.payment_method || rawEvent?.paymentMethod || rawEvent?.payment || "").toLowerCase().trim();

  let pm = String(paymentMethod || payFromEvent || "").toLowerCase().trim();
  if (!pm) {
    if (src.includes("stripe")) pm = "stripe";
    else if (src.includes("cod")) pm = "cod";
    else if (src.includes("bank")) pm = "bank";
    else if (src.includes("store") || src.includes("pickup") || src.includes("cash")) pm = "store";
    else pm = "unknown";
  }
  if (!["stripe", "cod", "bank", "store", "unknown"].includes(pm)) pm = "unknown";

  let st = String(status || "").toLowerCase().trim();
  if (!st) st = pm === "stripe" ? "paid" : "new";

  const safeItems = Array.isArray(items) ? items : [];

  await p.query(
    `
    INSERT INTO orders (
      user_id, member_code, phone,
      items, total, shipping_fee,
      payment_method, status,
      name, zip, pref, address,
      source, raw_event
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `,
    [
      userId,
      memberCode,
      phone,
      JSON.stringify(safeItems),
      Number(total || 0),
      Number(shippingFee || 0),
      pm,
      st,
      name,
      zip,
      pref,
      address,
      source || null,
      rawEvent ? JSON.stringify(rawEvent) : null,
    ]
  );

  return { ok: true, payment_method: pm, status: st };
}

// =============== セグメント台帳 ===============
function normalizeLiffKind(kindRaw) {
  const k = String(kindRaw || "").trim().slice(0, 32);
  if (LIFF_OPEN_KIND_MODE === "keep") return k || "all";
  return "all";
}

async function dbTouchUser(userId, source = "seen") {
  if (!pool) return;
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return;

  const setChat = source === "chat";
  const setLiff = source === "liff";

  await p.query(
    `
    INSERT INTO segment_users (user_id, first_seen, last_seen, last_chat_at, last_liff_at)
    VALUES ($1, NOW(), NOW(),
      CASE WHEN $2 THEN NOW() ELSE NULL END,
      CASE WHEN $3 THEN NOW() ELSE NULL END
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen = NOW(),
      last_chat_at = CASE WHEN $2 THEN NOW() ELSE segment_users.last_chat_at END,
      last_liff_at = CASE WHEN $3 THEN NOW() ELSE segment_users.last_liff_at END
    `,
    [uid, setChat, setLiff]
  );
}

function fileTouchUser(userId, source = "seen") {
  const uid = String(userId || "").trim();
  if (!uid) return;
  const book = readSegmentUsers();
  const now = new Date().toISOString();
  if (!book[uid]) book[uid] = { userId: uid, firstSeen: now, lastSeen: now, lastChatAt: "", lastLiffAt: "" };
  book[uid].lastSeen = now;
  if (source === "chat") book[uid].lastChatAt = now;
  if (source === "liff") book[uid].lastLiffAt = now;
  writeSegmentUsers(book);
}

async function touchUser(userId, source = "seen") {
  try {
    if (pool) await dbTouchUser(userId, source);
    else fileTouchUser(userId, source);
  } catch {
    try {
      fileTouchUser(userId, source);
    } catch {}
  }
}

async function listSegmentUserIds(days = 30, source = "active") {
  const d = Math.min(365, Math.max(1, Number(days || 30)));
  const src = String(source || "active").toLowerCase();

  if (pool) {
    const p = mustPool();
    let where = `last_seen >= NOW() - ($1::int * INTERVAL '1 day')`;
    if (src === "chat") where = `last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($1::int * INTERVAL '1 day')`;
    if (src === "liff") where = `last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($1::int * INTERVAL '1 day')`;
    if (src === "active") where = `(
      (last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($1::int * INTERVAL '1 day'))
      OR
      (last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($1::int * INTERVAL '1 day'))
    )`;

    const r = await p.query(`SELECT user_id FROM segment_users WHERE ${where} ORDER BY user_id ASC LIMIT $2`, [d, SEGMENT_PUSH_LIMIT]);
    return r.rows.map((x) => x.user_id).filter(Boolean);
  }

  const book = readSegmentUsers();
  const now = Date.now();
  const ms = d * 24 * 60 * 60 * 1000;
  const ids = Object.values(book)
    .filter((x) => {
      const lastSeen = x?.lastSeen ? new Date(x.lastSeen).getTime() : 0;
      const lastChat = x?.lastChatAt ? new Date(x.lastChatAt).getTime() : 0;
      const lastLiff = x?.lastLiffAt ? new Date(x.lastLiffAt).getTime() : 0;

      if (src === "chat") return lastChat && now - lastChat <= ms;
      if (src === "liff") return lastLiff && now - lastLiff <= ms;
      if (src === "active") return (lastChat && now - lastChat <= ms) || (lastLiff && now - lastLiff <= ms);
      return lastSeen && now - lastSeen <= ms;
    })
    .map((x) => x.userId)
    .filter(Boolean)
    .slice(0, SEGMENT_PUSH_LIMIT);

  return ids;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// =============== LIFF idToken verify（任意） ===============
async function verifyLineIdToken(idToken) {
  if (!idToken || !LINE_CHANNEL_ID) return null;
  try {
    const params = new URLSearchParams();
    params.set("id_token", idToken);
    params.set("client_id", LINE_CHANNEL_ID);

    // Node 18+ なら fetch が標準
    const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.sub || null;
  } catch {
    return null;
  }
}

// =============== 画面 ===============
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));

app.get("/api/health", async (_req, res) => {
  let pg = null;
  if (pool) {
    try {
      const r = await mustPool().query("SELECT NOW() as now");
      pg = { ok: true, now: r.rows?.[0]?.now || null };
    } catch (e) {
      pg = { ok: false, error: e?.message || String(e) };
    }
  }
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    pg,
    env: {
      LIFF_OPEN_KIND_MODE,
      DATABASE_URL: !!process.env.DATABASE_URL,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
    },
  });
});

// =============== LIFF config ===============
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();
  if (kind === "shop") {
    if (!LIFF_ID_SHOP) return res.status(500).json({ ok: false, error: "LIFF_ID_SHOP_not_set" });
    return res.json({ ok: true, liffId: LIFF_ID_SHOP });
  }
  if (kind === "cod") return res.json({ ok: true, liffId: LIFF_ID_DIRECT_ADDRESS || LIFF_ID });
  return res.json({ ok: true, liffId: LIFF_ID });
});

// =============== LIFF open log（kind=all統一） ===============
app.post("/api/liff/open", async (req, res) => {
  try {
    const kind = normalizeLiffKind(req.body?.kind);
    const idToken = String(req.body?.idToken || "").trim();
    const tokenUserId = await verifyLineIdToken(idToken);
    const userId = String(tokenUserId || req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await touchUser(userId, "liff");

    if (pool) {
      await mustPool().query(`INSERT INTO liff_open_logs (user_id, kind) VALUES ($1,$2)`, [userId, kind]);
      try {
        await dbEnsureCodes(userId);
      } catch {}
    }

    return res.json({ ok: true, kind });
  } catch (e) {
    console.error("/api/liff/open error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== 住所（DB） ===============
app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    await dbUpsertAddressByUserId(userId, addr);
    const codes = await dbEnsureCodes(userId);

    return res.json({
      ok: true,
      memberCode: String(codes.member_code || ""),
      addressCode: String(codes.address_code || ""),
      saved: true,
    });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.get("/api/liff/address/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || req.headers["x-line-userid"] || "").trim();
    if (!userId) return res.json({ ok: true, address: null });
    if (!pool) return res.json({ ok: true, address: null });

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

// ★公開住所取得（超注意：トークン必須）
app.get("/api/public/address-by-code", async (req, res) => {
  try {
    if (!PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(500).json({ ok: false, error: "PUBLIC_ADDRESS_LOOKUP_TOKEN_not_set" });
    const token = String(req.query.token || req.headers["x-public-token"] || "").trim();
    if (token !== PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

    const code = String(req.query.code || "").trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: "code_required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const addr = await dbGetAddressByMemberCode(code);
    if (!addr) return res.status(404).json({ ok: false, error: "address_not_registered" });

    return res.json({
      ok: true,
      address: {
        postal: addr.postal || "",
        prefecture: addr.prefecture || "",
        city: addr.city || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        memberCode: String(addr.member_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/public/address-by-code error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== ミニアプリ：商品一覧（久助除外） ===============
app.get("/api/products", (_req, res) => {
  try {
    const items = readProducts()
      .filter((p) => !HIDE_PRODUCT_IDS.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        volume: p.volume || "",
        image: toPublicImageUrl(p.image || ""),
      }));
    return res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =============== ミニアプリ：送料計算 ===============
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const { region, size, shipping } = calcShippingUnified(items, address);
    const finalTotal = itemsTotal + shipping;

    return res.json({ ok: true, itemsTotal, region, size, shipping, finalTotal });
  } catch (e) {
    console.error("/api/shipping error:", e);
    return res.status(400).json({ ok: false, error: e?.message || "shipping_error" });
  }
});

app.get("/api/shipping/config", (_req, res) => {
  return res.json({
    ok: true,
    config: {
      origin: "yamato_chubu_taxed",
      originalSetProductId: ORIGINAL_SET_PRODUCT_ID,
      sizeOrder: SIZE_ORDER,
      yamatoChubuTaxed: YAMATO_CHUBU_TAXED,
      codFee: COD_FEE,
    },
  });
});

// =============== Stripe ===============
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || "").trim();
const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;

app.post("/api/pay-stripe", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);

    const line_items = [];
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty = Number(it.qty) || 0;
      if (!qty || unit < 0) continue;
      line_items.push({
        price_data: {
          currency: "jpy",
          product_data: { name: String(it.name || it.id || "商品") },
          unit_amount: unit,
        },
        quantity: qty,
      });
    }
    if (shipping > 0) {
      line_items.push({
        price_data: { currency: "jpy", product_data: { name: "送料" }, unit_amount: shipping },
        quantity: 1,
      });
    }
    if (codFee > 0) {
      line_items.push({
        price_data: { currency: "jpy", product_data: { name: "代引き手数料" }, unit_amount: codFee },
        quantity: 1,
      });
    }
    if (!line_items.length) return res.status(400).json({ ok: false, error: "no_valid_line_items" });

    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers.host;
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;

    const successUrl = `${base}/public/confirm-card-success.html`;
    const cancelUrl = `${base}/public/confirm-fail.html`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        lineUserId: order.lineUserId || "",
        lineUserName: order.lineUserName || "",
      },
    });

    return res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("[pay-stripe] error:", e?.raw || e);
    return res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

// Stripe完了通知（管理者/購入者） + ★DB保存
app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.json({ ok: false, error: "no_items" });

    // ★支払方法の判定（ここが重要）
    // 期待：order.paymentMethod または order.payment に "cod" / "bank" / "stripe" が入る
    const pmRaw = String(order.paymentMethod || order.payment || "").trim().toLowerCase();
    const paymentMethod =
      pmRaw === "cod" ? "cod" :
      pmRaw === "bank" ? "bank" :
      "stripe";

    // ★ステータス（cod/bankは未入金扱い）
    const status = paymentMethod === "stripe" ? "paid" : "new";

    // ★sourceも合わせる（後で集計が超楽）
    const source =
      paymentMethod === "cod" ? "liff-cod" :
      paymentMethod === "bank" ? "liff-bank" :
      "liff-stripe";

    // log（ファイル）
    try {
      fs.appendFileSync(
        ORDERS_LOG,
        JSON.stringify({ ts: new Date().toISOString(), ...order, source, payment_method: paymentMethod }) + "\n",
        "utf8"
      );
    } catch {}

    // DB保存
    try {
      const a = order.address || {};
      const name =
        (a.lastName || a.firstName)
          ? `${a.lastName || ""}${a.firstName || ""}`.trim()
          : (a.name || "");
      const zip = a.zip || a.postal || "";
      const pref = a.prefecture || a.pref || "";
      const addrLine = `${a.city || ""}${a.addr1 || a.address1 || ""}${a.addr2 || a.address2 ? " " + (a.addr2 || a.address2) : ""}`.trim();

      await dbInsertOrder({
        userId: order.lineUserId || null,
        memberCode: null,
        phone: a.tel || a.phone || null,
        items: items.map((it) => ({ id: it.id || "", name: it.name || "", price: Number(it.price || 0), qty: Number(it.qty || 0) })),
        total: Number(order.finalTotal ?? order.total ?? 0),
        shippingFee: Number(order.shipping ?? 0),
        paymentMethod,         // ← ★ここが可変になった
        status,                // ← ★ここも
        name: name || null,
        zip: zip || null,
        pref: pref || null,
        address: addrLine || null,
        source,                // ← ★sourceも
        rawEvent: order,
      });
    } catch (e) {
      console.error("orders db insert skipped:", e?.message || e);
    }

    // 通知本文（表示用。代引/振込でも同じ明細を送るならこのままでOK）
    // ※必要なら「支払方法：代引/振込」を本文に入れるのも可能

    return res.json({ ok: true, paymentMethod, status, source });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// =============== 管理API：画像 ===============
app.post("/api/admin/upload", upload.single("file"), (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "no_file" });
    const url = toPublicImageUrl(f.filename);
    return res.json({ ok: true, filename: f.filename, url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "upload_error" });
  }
});

app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs.readdirSync(UPLOAD_DIR).filter((x) => !x.startsWith("."));
    return res.json({ ok: true, items: files.map((name) => ({ name, url: toPublicImageUrl(name) })) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/images/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    const p = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: "not_found" });
    fs.unlinkSync(p);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =============== 管理API：商品/在庫 ===============
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map((p) => ({ ...p, image: toPublicImageUrl(p.image || "") }));
  return res.json({ ok: true, products: items });
});

app.post("/api/admin/products/update", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id_required" });

    const { products, idx, product } = findProductById(id);
    if (!product) return res.status(404).json({ ok: false, error: "not_found" });

    const name = req.body?.name != null ? String(req.body.name) : product.name;
    const desc = req.body?.desc != null ? String(req.body.desc) : product.desc;
    const image = req.body?.image != null ? String(req.body.image) : product.image;

    // 久助は単価固定（250）
    const price = id === "kusuke-250" ? KUSUKE_UNIT_PRICE : req.body?.price != null ? Number(req.body.price) : product.price;
    const stock = req.body?.stock != null ? Number(req.body.stock) : product.stock;

    products[idx] = { ...product, name, desc, image, price, stock };
    writeProducts(products);

    return res.json({ ok: true, product: products[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/stock/add", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    const delta = Number(req.body?.delta || 0);
    const r = addStock(id, delta, "admin");
    const { product } = findProductById(id);
    await maybeLowStockAlert(id, product?.name || id, r.after);
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/stock/set", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    const qty = Number(req.body?.qty || 0);
    const r = setStock(id, qty, "admin");
    const { product } = findProductById(id);
    await maybeLowStockAlert(id, product?.name || id, r.after);
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== 管理API：注文（ファイル）/（DB） ===============
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit) || 100, lines.length));
  return tail.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  const items = readLogLines(ORDERS_LOG, limit);
  return res.json({ ok: true, items });
});

// ★DB注文：payment/source/status で絞り込み可能
// 例）/api/admin/orders-db?payment=cod&limit=200&token=...
app.get("/api/admin/orders-db", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const limit = Math.min(2000, Number(req.query.limit || 200));
    const payment = String(req.query.payment || "").trim().toLowerCase(); // stripe/cod/bank/store/unknown
    const status = String(req.query.status || "").trim().toLowerCase();
    const source = String(req.query.source || "").trim().toLowerCase();

    const wh = [];
    const params = [];
    let i = 1;

    if (payment) {
      wh.push(`payment_method = $${i++}`);
      params.push(payment);
    }
    if (status) {
      wh.push(`status = $${i++}`);
      params.push(status);
    }
    if (source) {
      wh.push(`LOWER(COALESCE(source,'')) LIKE $${i++}`);
      params.push(`%${source}%`);
    }

    params.push(limit);
    const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
    const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT $${i}`;

    const r = await mustPool().query(sql, params);
    return res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error("/api/admin/orders-db error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== 管理：セグメント抽出/Push ===============
app.get("/api/admin/segment/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const source = String(req.query.source || "active"); // active/chat/liff/seen
    const ids = await listSegmentUserIds(days, source);
    return res.json({ ok: true, days, source, count: ids.length, items: ids });
  } catch (e) {
    console.error("/api/admin/segment/users error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/push/segment", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.body?.days || 30);
    const source = String(req.body?.source || "active");
    const message = req.body?.message;
    const dryRun = !!req.body?.dryRun;

    if (!message || !message.type) return res.status(400).json({ ok: false, error: "message_required" });

    const ids = await listSegmentUserIds(days, source);
    const chunks = chunkArray(ids, SEGMENT_CHUNK_SIZE);

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, days, source, target: ids.length, chunks: chunks.length });
    }

    let okCount = 0;
    let ngCount = 0;

    for (const part of chunks) {
      try {
        await client.multicast(part, message);
        okCount += part.length;
      } catch (e) {
        ngCount += part.length;
        console.error("segment multicast error:", e?.response?.data || e?.message || e);
      }
    }

    return res.json({ ok: true, days, source, target: ids.length, pushed: okCount, failed: ngCount });
  } catch (e) {
    console.error("/api/admin/push/segment error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== LINE疎通 ===============
app.get("/api/line/ping", async (_req, res) => {
  try {
    if (!ADMIN_USER_ID) return res.status(400).json({ ok: false, error: "ADMIN_USER_ID not set" });
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: "✅ LINEサーバー疎通OK" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.response?.data || e?.message || String(e) });
  }
});

// =============== 注文フローUI（Flex） ===============
function qstr(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? "" : String(v))}`)
    .join("&");
}
function parseQuery(data) {
  const s = data && data.includes("?") ? data.split("?")[1] : data;
  const o = {};
  String(s || "")
    .split("&")
    .forEach((kv) => {
      const [k, v] = kv.split("=");
      if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
  return o;
}

function productsFlex() {
  const all = readProducts().filter((p) => !HIDE_PRODUCT_IDS.has(p.id));
  const bubbles = all.map((p) => {
    const img = toPublicImageUrl(p.image || "");
    return {
      type: "bubble",
      hero: img ? { type: "image", url: img, size: "full", aspectRatio: "1:1", aspectMode: "cover" } : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: "sm", wrap: true },
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true } : null,
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [{ type: "button", style: "primary", action: { type: "postback", label: "数量を選ぶ", data: `order_qty?${qstr({ id: p.id, qty: 1 })}` } }],
      },
    };
  });

  // その他（自由入力＝価格入力なし）
  bubbles.push({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        { type: "text", text: "商品名と個数だけ入力します（価格入力不要）。", size: "sm", wrap: true },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [{ type: "button", style: "primary", action: { type: "postback", label: "商品名を入力する", data: "other_start" } }],
    },
  });

  return { type: "flex", altText: "商品一覧", contents: { type: "carousel", contents: bubbles } };
}

function qtyFlex(id, qty = 1) {
  const q = Math.max(1, Math.min(99, Number(qty) || 1));
  return {
    type: "flex",
    altText: "数量を選択してください",
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "数量選択", weight: "bold", size: "lg" }, { type: "text", text: `現在の数量：${q} 個`, size: "md" }] },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [
              { type: "button", style: "secondary", action: { type: "postback", label: "-1", data: `order_qty?${qstr({ id, qty: Math.max(1, q - 1) })}` } },
              { type: "button", style: "secondary", action: { type: "postback", label: "+1", data: `order_qty?${qstr({ id, qty: Math.min(99, q + 1) })}` } },
            ],
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [1, 2, 3, 5].map((n) => ({
              type: "button",
              style: n === q ? "primary" : "secondary",
              action: { type: "postback", label: `${n}個`, data: `order_qty?${qstr({ id, qty: n })}` },
            })),
          },
          { type: "button", style: "primary", action: { type: "postback", label: "受取方法へ", data: `order_method?${qstr({ id, qty: q })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧", data: "order_back" } },
        ],
      },
    },
  };
}

function methodFlex(id, qty) {
  return {
    type: "flex",
    altText: "受取方法を選択してください",
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "受取方法", weight: "bold", size: "lg" }, { type: "text", text: "宅配 または 店頭受取 を選択してください。", wrap: true }] },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", label: "宅配（送料あり）", data: `order_payment?${qstr({ id, qty, method: "delivery" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "店頭受取（送料0円）", data: `order_payment?${qstr({ id, qty, method: "pickup" })}` } },
        ],
      },
    },
  };
}

function paymentFlex(id, qty, method) {
  if (method === "pickup") {
    return {
      type: "flex",
      altText: "店頭受取（現金のみ）",
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "お支払い方法", weight: "bold", size: "lg" }, { type: "text", text: "店頭受取は現金のみです。", wrap: true }] },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "button", style: "primary", action: { type: "postback", label: "現金で支払う（店頭）", data: `order_pickup_name?${qstr({ id, qty, method: "pickup", payment: "cash" })}` } },
            { type: "button", style: "secondary", action: { type: "postback", label: "← 戻る", data: `order_method?${qstr({ id, qty })}` } },
          ],
        },
      },
    };
  }

  return {
    type: "flex",
    altText: "お支払い方法を選択してください",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "お支払い方法", weight: "bold", size: "lg" },
          { type: "text", text: "送料は登録住所から自動計算します。", wrap: true },
          { type: "text", text: `代引きは +${yen(COD_FEE)}`, wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", label: `代金引換（+${yen(COD_FEE)}）`, data: `order_confirm_view?${qstr({ id, qty, method: "delivery", payment: "cod" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "銀行振込", data: `order_confirm_view?${qstr({ id, qty, method: "delivery", payment: "bank" })}` } },
        ],
      },
    },
  };
}

function confirmFlex(product, qty, method, payment, address, pickupName) {
  const subtotal = Number(product.price) * Number(qty);

  let region = "";
  let size = "";
  let shipping = 0;
  let addressOk = true;

  if (method === "delivery") {
    if (!address) addressOk = false;
    else {
      const r = calcShippingUnified([{ id: product.id, name: product.name, qty }], address);
      region = r.region;
      size = r.size;
      shipping = r.shipping;
      if (!region) addressOk = false;
    }
  }

  const codFee = payment === "cod" ? COD_FEE : 0;
  const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

  const payText = payment === "cod" ? `代金引換（+${yen(COD_FEE)}）` : payment === "bank" ? "銀行振込" : "現金（店頭）";

  const lines = [
    `受取方法：${method === "pickup" ? "店頭受取（送料0円）" : "宅配（送料あり）"}`,
    `支払い：${payText}`,
    `商品：${product.name}`,
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
  ];

  if (method === "delivery") {
    if (addressOk) {
      lines.push(`配送地域：${region}`);
      lines.push(`サイズ：${size}`);
      lines.push(`送料：${yen(shipping)}`);
    } else {
      lines.push("送料：住所未登録（または都道府県が不明）のため計算できません");
    }
  } else {
    lines.push("送料：0円");
  }

  lines.push(`代引き手数料：${yen(codFee)}`);
  lines.push(`合計：${yen(total)}`);

  if (method === "pickup" && pickupName) lines.push(`お名前：${pickupName}`);

  const img = toPublicImageUrl(product.image || "");

  const footerButtons = [];
  if (method === "delivery" && !addressOk) {
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "uri", label: "住所を入力（LIFF）", uri: `https://liff.line.me/${LIFF_ID_DIRECT_ADDRESS || LIFF_ID}?from=address&need=shipping` },
    });
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
  } else {
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method, payment, pickupName: pickupName || "" })}` },
    });
  }

  return {
    type: "flex",
    altText: "注文内容の最終確認",
    contents: {
      type: "bubble",
      hero: img ? { type: "image", url: img, size: "full", aspectRatio: "1:1", aspectMode: "cover" } : undefined,
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "最終確認", weight: "bold", size: "lg" }, ...lines.map((t) => ({ type: "text", text: t, wrap: true }))] },
      footer: { type: "box", layout: "vertical", spacing: "md", contents: footerButtons },
    },
  };
}

// =============== セッション（注文途中状態） ===============
function setSession(userId, patch) {
  const s = readSessions();
  s[userId] = { ...(s[userId] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeSessions(s);
}
function getSession(userId) {
  const s = readSessions();
  return s[userId] || null;
}
function clearSession(userId) {
  const s = readSessions();
  delete s[userId];
  writeSessions(s);
}

// =============== LINE Webhook ===============
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

// =============== 予約ログ ===============
function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
}

// =============== handleEvent ===============
async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";
  if (userId) {
    try {
      await touchUser(userId, "seen");
    } catch {}
  }

  // 友だち追加
  if (ev.type === "follow") {
    if (userId) await touchUser(userId, "seen");
    const msg =
      "友だち追加ありがとうございます！\n\n" +
      "・「注文」→ 商品一覧から選べます\n" +
      "・「久助」→ 久助（1個250円）をテキストで注文できます\n" +
      "・住所登録（LIFF）もできます";
    return client.replyMessage(ev.replyToken, { type: "text", text: msg });
  }

  // メッセージ
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = String(ev.message.text || "").trim();
    if (userId) {
      await touchUser(userId, "chat");
      try {
        appendJsonl(MESSAGES_LOG, { ts: new Date().toISOString(), userId, textLen: text.length });
      } catch {}
    }

    // 途中入力（その他/店頭名）を扱う
    const sess = userId ? getSession(userId) : null;

    // 「その他」商品名入力待ち
    if (sess?.mode === "other_name") {
      const name = text.replace(/\s+/g, " ").trim();
      if (!name) return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください。" });

      setSession(userId, { mode: "other_qty", otherName: name });
      return client.replyMessage(ev.replyToken, { type: "text", text: `「${name}」ですね。個数を数字で入力してください（例：3）` });
    }

    // 「その他」数量入力待ち
    if (sess?.mode === "other_qty") {
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
        return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 の数字で入力してください。" });
      }

      // その他は価格0で扱い、あとで管理者へ「価格未確定」として通知
      const fakeProduct = { id: `other:${encodeURIComponent(sess.otherName)}:0`, name: sess.otherName, price: 0, stock: 9999, image: "" };
      clearSession(userId);
      return client.replyMessage(ev.replyToken, [
        { type: "text", text: "受取方法を選択してください。" },
        {
          type: "template",
          altText: "受取方法",
          template: {
            type: "buttons",
            text: `商品：${sess.otherName}\n数量：${qty}個`,
            actions: [
              { type: "postback", label: "宅配", data: `order_payment?${qstr({ id: fakeProduct.id, qty, method: "delivery" })}` },
              { type: "postback", label: "店頭受取", data: `order_payment?${qstr({ id: fakeProduct.id, qty, method: "pickup" })}` },
            ],
          },
        },
      ]);
    }

    // 店頭受取 名前入力待ち
    if (sess?.mode === "pickup_name") {
      const name = text.replace(/\s+/g, " ").trim();
      if (!name) return client.replyMessage(ev.replyToken, { type: "text", text: "お名前を入力してください。" });

      const { id, qty, method, payment } = sess;
      clearSession(userId);

      const product = loadProductByOrderId(id);
      const address = null;
      const flex = confirmFlex(product, qty, method, payment, address, name);
      return client.replyMessage(ev.replyToken, flex);
    }

    // コマンド
    if (/^(注文|商品|メニュー)$/i.test(text)) {
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "商品一覧です。" }, productsFlex()]);
    }

    if (/^(久助|くすけ)$/i.test(text)) {
      const msg = "久助の注文方法：\n" + "「久助 3」 のように入力してください。\n" + `単価：${yen(KUSUKE_UNIT_PRICE)}（税込）\n` + "例：久助 5";
      return client.replyMessage(ev.replyToken, { type: "text", text: msg });
    }

    // 久助 数量入力（例: 久助 3）
    const m = /^久助\s*(\d{1,2})$/.exec(text.replace(/[　]+/g, " "));
    if (m) {
      const qty = Number(m[1]);
      if (qty < 1 || qty > 99) return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 で入力してください。" });

      // 久助は在庫チェック
      const { product } = findProductById("kusuke-250");
      if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "久助の商品データが見つかりません。" });

      const stock = Number(product.stock || 0);
      if (stock < qty) {
        appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: product.id, productName: product.name, qty, reason: "stock_shortage" });
        return client.replyMessage(ev.replyToken, [
          { type: "text", text: `在庫不足です（在庫${stock}個）。予約しますか？` },
          {
            type: "template",
            altText: "予約",
            template: {
              type: "confirm",
              text: "予約しますか？",
              actions: [
                { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: product.id, qty })}` },
                { type: "postback", label: "やめる", data: "order_cancel" },
              ],
            },
          },
        ]);
      }

      // フローへ（デフォルトは宅配/代引：最終確認で住所登録を促す）
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "久助の注文内容です。" }, confirmFlex(product, qty, "delivery", "cod", null, null)]);
    }

    // 住所コード/会員コード確認（DBのみ）
    if (/^コード$/i.test(text)) {
      if (!pool) return client.replyMessage(ev.replyToken, { type: "text", text: "DB未設定のためコードは発行できません（DATABASE_URLが必要）。" });
      const codes = await dbEnsureCodes(userId);
      const msg = `会員コード：${codes.member_code}\n` + `住所コード：${codes.address_code}\n\n` + "住所登録（LIFF）から登録すると送料計算が自動になります。";
      return client.replyMessage(ev.replyToken, { type: "text", text: msg });
    }

    // デフォルト
    const help = "使い方：\n" + "・「注文」→ 商品一覧\n" + "・「久助 3」→ 久助を3個\n" + "・「コード」→ 会員コード表示（DBがある場合）";
    return client.replyMessage(ev.replyToken, { type: "text", text: help });
  }

  // postback
  if (ev.type === "postback") {
    const data = String(ev.postback?.data || "");

    if (data === "order_back") {
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "商品一覧に戻ります。" }, productsFlex()]);
    }

    if (data === "other_start") {
      if (!userId) return;
      setSession(userId, { mode: "other_name" });
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください（例：えびせん詰め合わせ）" });
    }

    if (data.startsWith("order_qty?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, qtyFlex(q.id, q.qty));
    }

    if (data.startsWith("order_method?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, methodFlex(q.id, Number(q.qty || 1)));
    }

    if (data.startsWith("order_payment?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, paymentFlex(q.id, Number(q.qty || 1), q.method));
    }

    if (data.startsWith("order_pickup_name?")) {
      // 店頭名入力へ（テキスト入力）
      const q = parseQuery(data);
      setSession(userId, { mode: "pickup_name", id: q.id, qty: Number(q.qty || 1), method: q.method, payment: q.payment });
      return client.replyMessage(ev.replyToken, { type: "text", text: "店頭で受け取るお名前を入力してください。" });
    }

    if (data.startsWith("order_confirm_view?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);
      const method = q.method;
      const payment = q.payment;

      const product = loadProductByOrderId(id);

      let address = null;
      if (method === "delivery" && pool) {
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

      const flex = confirmFlex(product, qty, method, payment, address, null);
      return client.replyMessage(ev.replyToken, flex);
    }

    if (data.startsWith("order_confirm?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);
      const method = q.method;
      const payment = q.payment;
      const pickupName = String(q.pickupName || "").trim();

      const product = loadProductByOrderId(id);

      // 在庫チェック（otherは除外）
      if (!String(product.id).startsWith("other:")) {
        const { product: p } = findProductById(product.id);
        if (!p) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりません。" });

        const stock = Number(p.stock || 0);
        if (stock < qty) {
          appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: p.id, productName: p.name, qty, reason: "stock_shortage" });
          return client.replyMessage(ev.replyToken, [
            { type: "text", text: `在庫不足です（在庫${stock}個）。予約しますか？` },
            {
              type: "template",
              altText: "予約",
              template: {
                type: "confirm",
                text: "予約しますか？",
                actions: [
                  { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: p.id, qty })}` },
                  { type: "postback", label: "やめる", data: "order_cancel" },
                ],
              },
            },
          ]);
        }

        // 在庫減算
        addStock(p.id, -qty, "order_confirm");
        await maybeLowStockAlert(p.id, p.name, Math.max(0, stock - qty));
      }

      // 住所取得（宅配なら）
      let address = null;
      if (method === "delivery" && pool) {
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

      // 送料計算
      let shipping = 0;
      let region = "";
      let size = "";
      if (method === "delivery") {
        const r = calcShippingUnified([{ id: product.id, name: product.name, qty }], address || {});
        shipping = r.shipping;
        region = r.region;
        size = r.size;
      }

      const subtotal = Number(product.price || 0) * qty;
      const codFee = payment === "cod" ? COD_FEE : 0;
      const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

      // 注文オブジェクト（ログ/DB共通）
      const order = {
        ts: new Date().toISOString(),
        userId,
        productId: product.id,
        productName: product.name,
        price: Number(product.price || 0),
        qty,
        method,
        payment,
        pickupName: method === "pickup" ? pickupName : "",
        shipping,
        region,
        size,
        codFee,
        total,
        address: address
          ? {
              name: address.name || "",
              phone: address.phone || "",
              postal: address.postal || "",
              prefecture: address.prefecture || "",
              city: address.city || "",
              address1: address.address1 || "",
              address2: address.address2 || "",
            }
          : null,
        note: String(product.id).startsWith("other:") ? "価格未入力（その他）" : "",
      };

      // ファイルログ
      try {
        appendJsonl(ORDERS_LOG, { ...order, source: "line-postback" });
      } catch {}

      // ★DB保存（orders）
      try {
        let memberCode = null;
        if (pool) {
          const c = await dbGetCodesByUserId(userId);
          memberCode = c?.member_code ? String(c.member_code).trim() : null;
        }

        const nameForDb = method === "pickup" ? pickupName || null : address?.name || null;
        const zip = address?.postal || null;
        const pref = address?.prefecture || null;
        const addrLine = address ? `${address.city || ""}${address.address1 || ""}${address.address2 ? " " + address.address2 : ""}`.trim() || null : null;

        await dbInsertOrder({
          userId,
          memberCode,
          phone: address?.phone || null,
          items: [{ id: product.id, name: product.name, price: Number(product.price || 0), qty }],
          total,
          shippingFee: method === "delivery" ? shipping : 0,
          paymentMethod: payment === "cod" ? "cod" : payment === "bank" ? "bank" : "store",
          status: "new",
          name: nameForDb,
          zip,
          pref,
          address: addrLine,
          source: "line-postback",
          rawEvent: { ...order, source: "line-postback" },
        });
      } catch (e) {
        console.error("orders db insert skipped:", e?.message || e);
      }

      // 管理者通知
      if (ADMIN_USER_ID) {
        const addrText =
          method === "delivery" && address
            ? `住所：${address.postal || ""} ${address.prefecture || ""}${address.city || ""}${address.address1 || ""}${address.address2 ? " " + address.address2 : ""}\n氏名：${address.name || ""}\nTEL：${address.phone || ""}`
            : method === "pickup"
            ? `店頭受取：${pickupName || ""}`
            : "住所：未登録";

        const msg =
          `🧾【新規注文】\n` +
          `商品：${product.name}\n` +
          `数量：${qty}\n` +
          `受取：${method === "pickup" ? "店頭" : "宅配"}\n` +
          `支払：${payment === "cod" ? "代引" : payment === "bank" ? "振込" : "店頭現金"}\n` +
          (method === "delivery" ? `送料：${yen(shipping)}（${region || "不明"} / ${size || "?"}）\n` : "送料：0円\n") +
          (codFee ? `代引手数料：${yen(codFee)}\n` : "") +
          `合計：${yen(total)}\n` +
          (order.note ? `※${order.note}\n` : "") +
          `\n${addrText}`;

        try {
          await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
        } catch {}
      }

      // ユーザー返信
      const userMsg =
        "ご注文ありがとうございます！\n\n" +
        `商品：${product.name}\n` +
        `数量：${qty}\n` +
        (method === "delivery" ? `送料：${yen(shipping)}\n` + (codFee ? `代引手数料：${yen(codFee)}\n` : "") : "送料：0円\n") +
        `合計：${yen(total)}\n` +
        (method === "pickup" ? `\n店頭受取のお名前：${pickupName || ""}\n` : "") +
        (method === "delivery" && !address ? "\n※住所が未登録です。住所登録（LIFF）をお願いします。\n" : "");

      return client.replyMessage(ev.replyToken, { type: "text", text: userMsg });
    }

    if (data.startsWith("order_reserve?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);
      const { product } = findProductById(id);
      appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: id, productName: product?.name || id, qty, action: "reserve" });

      if (ADMIN_USER_ID) {
        const msg = `📌【予約】\n商品：${product?.name || id}\n数量：${qty}\nuserId：${userId}`;
        try {
          await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
        } catch {}
      }

      return client.replyMessage(ev.replyToken, { type: "text", text: "予約を受け付けました。入荷次第ご案内します。" });
    }

    if (data === "order_cancel") {
      return client.replyMessage(ev.replyToken, { type: "text", text: "キャンセルしました。" });
    }
  }

  return null;
}

function loadProductByOrderId(id) {
  // その他
  if (String(id).startsWith("other:")) {
    const parts = String(id).split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    return { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: 9999, image: "" };
  }

  // 通常
  const { product } = findProductById(id);
  if (!product) return { id, name: id, price: 0, stock: 0, image: "" };

  // 久助は価格250固定を担保
  if (id === "kusuke-250") return { ...product, price: KUSUKE_UNIT_PRICE };
  return product;
}

// =============== 起動 ===============
async function start() {
  try {
    await ensureDbSchema();
    console.log("[BOOT] DB schema ensured");
  } catch (e) {
    console.error("[BOOT] ensureDbSchema failed:", e?.message || e);
    // ordersをDBに入れたい運用ならここで落とす方が安全
    // process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[BOOT] server listening on ${PORT}`);
  });
}

start().catch((e) => {
  console.error("[BOOT] start() failed:", e);
  process.exit(1);
});
