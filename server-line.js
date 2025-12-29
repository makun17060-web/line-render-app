/**
 * server-line.js — フル機能版（Stripe + ミニアプリ + 画像管理 + 住所DB + セグメント配信 + 注文DB永続化）
 * ★店頭受取専用（固定化）＋「リッチメニューのポストバックだけで開始」版
 *
 * ✅ 今回の変更点（“開始”はポストバックのみ）
 * - 「直接注文」「久助」など “開始用キーワード” は無効（テキストで送っても開始しない）
 * - リッチメニューの postback でのみ開始
 *   - data="start_order"  → 商品一覧（店頭受取）
 *   - data="start_kusuke" → 久助開始（数量入力の案内）
 *   - data="start_other"  → その他（商品名入力）
 * - ただし、注文途中の入力（受取名 / その他の商品名 / その他の個数）はテキスト入力を使う（セッション中のみ）
 *
 * ✅ 既存（維持）
 * - UPLOAD_DIR をDiskへ（画像永続）
 * - Flexに内容量表示
 * - 管理API（商品/在庫/画像/注文ログ/DB注文検索/ユーザー一覧）
 * - セグメント抽出ロジック1本化
 * - LINEプロフィールをDB保存（line_users）
 *
 * --- 必須 .env ---
 * LINE_CHANNEL_ACCESS_TOKEN
 * LINE_CHANNEL_SECRET
 * LIFF_ID
 * ADMIN_API_TOKEN  (推奨) もしくは ADMIN_CODE
 *
 * --- 推奨 .env ---
 * DATABASE_URL
 * ADMIN_USER_ID
 * PUBLIC_BASE_URL
 * STRIPE_SECRET_KEY（任意）
 * LINE_CHANNEL_ID（任意）
 * PUBLIC_ADDRESS_LOOKUP_TOKEN（任意）
 *
 * --- 推奨（今回） ---
 * UPLOAD_DIR=/var/data/uploads
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

// 店頭受取固定なので通常は使わないが、管理/表示の互換のため残す
const COD_FEE = Number(process.env.COD_FEE || 330);

// 久助は 250円固定（運用メモに合わせる）
const KUSUKE_UNIT_PRICE = 250;

// セグメント設定
const LIFF_OPEN_KIND_MODE = (process.env.LIFF_OPEN_KIND_MODE || "all").trim(); // "all" or "keep"
const SEGMENT_PUSH_LIMIT = Math.min(20000, Math.max(1, Number(process.env.SEGMENT_PUSH_LIMIT || 5000)));
const SEGMENT_CHUNK_SIZE = Math.min(500, Math.max(50, Number(process.env.SEGMENT_CHUNK_SIZE || 500)));

// ★プロフィール更新の最小間隔（日）
const PROFILE_REFRESH_DAYS = Math.min(365, Math.max(1, Number(process.env.PROFILE_REFRESH_DAYS || 30)));

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

// ✅ /liff へ来たら LIFFへリダイレクト
app.get(["/liff", "/liff/"], (req, res) => {
  const id = process.env.LIFF_ID_MINIAPP || LIFF_ID;
  if (!id) return res.status(500).send("LIFF_ID is not set");
  return res.redirect(302, `https://liff.line.me/${id}`);
});

// =============== ディレクトリ & ファイル ===============
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");

// ★ここが重要：UPLOAD_DIRは env を優先（Disk）
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "/var/data/uploads");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 既存の public 配信（HTML/JS/CSS 等）
app.use("/public", express.static(PUBLIC_DIR));
// ★ここが重要：/public/uploads は Disk の UPLOAD_DIR を配信する
app.use("/public/uploads", express.static(UPLOAD_DIR));

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");
const SEGMENT_USERS_PATH = path.join(DATA_DIR, "segment_users.json");

// ★プロフィール（DBが無い時の保険：ファイル）
const LINE_USERS_PATH = path.join(DATA_DIR, "line_users.json");

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
    { id: "original-set-2100", name: "磯屋オリジナルセット", price: 2100, stock: 10, desc: "人気の詰め合わせ。", volume: "（例）8袋入り", image: "" },
    { id: "nori-square-300", name: "四角のりせん", price: 300, stock: 10, desc: "のり香る角せん。", volume: "（例）1袋 80g", image: "" },
    { id: "premium-ebi-400", name: "プレミアムえびせん", price: 400, stock: 5, desc: "贅沢な旨み。", volume: "（例）1袋 70g", image: "" },
    // 久助はミニアプリ一覧から除外。チャット購入専用（単価250固定）
    { id: "kusuke-250", name: "久助（えびせん）", price: KUSUKE_UNIT_PRICE, stock: 20, desc: "お得な割れせん。", volume: "", image: "" },
  ];
  safeWriteJSON(PRODUCTS_PATH, sample);
}
if (!fs.existsSync(SESSIONS_PATH)) safeWriteJSON(SESSIONS_PATH, {});
if (!fs.existsSync(NOTIFY_STATE_PATH)) safeWriteJSON(NOTIFY_STATE_PATH, {});
if (!fs.existsSync(SEGMENT_USERS_PATH)) safeWriteJSON(SEGMENT_USERS_PATH, {});
if (!fs.existsSync(LINE_USERS_PATH)) safeWriteJSON(LINE_USERS_PATH, {});
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
const readLineUsersFile = () => safeReadJSON(LINE_USERS_PATH, {});
const writeLineUsersFile = (obj) => safeWriteJSON(LINE_USERS_PATH, obj);

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
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);
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

  // ★追加：LINEプロフィール保存用
  await p.query(`
    CREATE TABLE IF NOT EXISTS line_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      language TEXT,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen  TIMESTAMPTZ DEFAULT NOW(),
      profile_updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_line_users_last_seen ON line_users(last_seen DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_line_users_profile_updated_at ON line_users(profile_updated_at DESC);`);

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

// ================================
// ★プロフィール保存（DB / ファイル）
// ================================
function nowIso() {
  return new Date().toISOString();
}

function fileUpsertLineUser(userId, prof = {}, patch = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return;
  const book = readLineUsersFile();
  const now = nowIso();
  if (!book[uid]) {
    book[uid] = {
      user_id: uid,
      display_name: "",
      picture_url: "",
      status_message: "",
      language: "",
      first_seen: now,
      last_seen: now,
      profile_updated_at: now,
      updated_at: now,
    };
  }
  const cur = book[uid];
  book[uid] = {
    ...cur,
    display_name: prof.displayName != null ? String(prof.displayName || "").slice(0, 120) : cur.display_name,
    picture_url: prof.pictureUrl != null ? String(prof.pictureUrl || "").slice(0, 512) : cur.picture_url,
    status_message: prof.statusMessage != null ? String(prof.statusMessage || "").slice(0, 400) : cur.status_message,
    language: prof.language != null ? String(prof.language || "").slice(0, 16) : cur.language,
    last_seen: now,
    profile_updated_at: patch.profileUpdatedAt || cur.profile_updated_at || now,
    updated_at: now,
  };
  writeLineUsersFile(book);
}

async function dbGetLineUserMeta(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const r = await p.query(
    `SELECT user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at FROM line_users WHERE user_id=$1 LIMIT 1`,
    [uid]
  );
  return r.rows[0] || null;
}

async function dbUpsertLineUser(userId, prof = {}, opts = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return;

  const displayName = prof?.displayName != null ? String(prof.displayName || "").slice(0, 120) : null;
  const pictureUrl = prof?.pictureUrl != null ? String(prof.pictureUrl || "").slice(0, 512) : null;
  const statusMessage = prof?.statusMessage != null ? String(prof.statusMessage || "").slice(0, 400) : null;
  const language = prof?.language != null ? String(prof.language || "").slice(0, 16) : null;

  const forceProfile = !!opts.forceProfile;
  const hasProfileAny = !!(displayName || pictureUrl || statusMessage || language);

  await p.query(
    `
    INSERT INTO line_users (user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5, NOW(), NOW(),
      CASE WHEN $6 THEN NOW() ELSE NOW() END,
      NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, line_users.display_name),
      picture_url = COALESCE(EXCLUDED.picture_url, line_users.picture_url),
      status_message = COALESCE(EXCLUDED.status_message, line_users.status_message),
      language = COALESCE(EXCLUDED.language, line_users.language),
      last_seen = NOW(),
      profile_updated_at = CASE
        WHEN $6 THEN NOW()
        WHEN $7 THEN NOW()
        ELSE line_users.profile_updated_at
      END,
      updated_at = NOW()
    `,
    [uid, displayName, pictureUrl, statusMessage, language, forceProfile, hasProfileAny]
  );
}

function daysAgoMs(days) {
  return Number(days || 0) * 24 * 60 * 60 * 1000;
}

async function getLineProfileByEvent(ev) {
  const src = ev?.source || {};
  const type = src.type || "user";
  const userId = src.userId || "";
  if (!userId) return null;

  try {
    if (type === "group" && src.groupId) {
      if (typeof client.getGroupMemberProfile === "function") {
        return await client.getGroupMemberProfile(src.groupId, userId);
      }
      return null;
    }
    if (type === "room" && src.roomId) {
      if (typeof client.getRoomMemberProfile === "function") {
        return await client.getRoomMemberProfile(src.roomId, userId);
      }
      return null;
    }
    return await client.getProfile(userId);
  } catch {
    return null;
  }
}

async function maybeRefreshLineProfile(userId, ev, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return;

  const force = !!opts.force;

  if (!pool) {
    const prof = await getLineProfileByEvent(ev);
    if (prof) fileUpsertLineUser(uid, prof, { profileUpdatedAt: nowIso() });
    else fileUpsertLineUser(uid, {}, {});
    return;
  }

  try {
    const meta = await dbGetLineUserMeta(uid);
    const last = meta?.profile_updated_at ? new Date(meta.profile_updated_at).getTime() : 0;
    const need = force || !last || Date.now() - last > daysAgoMs(PROFILE_REFRESH_DAYS);

    if (!need) {
      await dbUpsertLineUser(uid, {}, { forceProfile: false });
      return;
    }

    const prof = await getLineProfileByEvent(ev);
    if (prof) await dbUpsertLineUser(uid, prof, { forceProfile: force });
    else await dbUpsertLineUser(uid, {}, { forceProfile: false });
  } catch {
    try {
      const prof = await getLineProfileByEvent(ev);
      if (prof) fileUpsertLineUser(uid, prof, { profileUpdatedAt: nowIso() });
      else fileUpsertLineUser(uid, {}, {});
    } catch {}
  }
}

// ★注文DB保存
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
    paymentMethod = null,
    status = "new",
    name = null,
    zip = null,
    pref = null,
    address = null,
    source = null,
    rawEvent = null,
  } = payload || {};

  let pm = String(paymentMethod || "").toLowerCase().trim();
  if (!pm) pm = "store";
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

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// =====================================================
// ✅ セグメント抽出ロジック 1本化
// =====================================================
function normalizeSegmentSource(srcRaw) {
  const s = String(srcRaw || "active").trim().toLowerCase();
  if (["active", "chat", "liff", "seen", "all"].includes(s)) return s;
  return "active";
}
function clampDays(daysRaw) {
  return Math.min(365, Math.max(1, Number(daysRaw || 30)));
}
function buildSegmentWhereSql(source, daysParamIndex) {
  const src = normalizeSegmentSource(source);
  if (src === "all") return { whereSql: `user_id IS NOT NULL AND user_id <> ''`, needsDays: false };
  if (src === "chat") return { whereSql: `last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  if (src === "liff") return { whereSql: `last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  if (src === "seen") return { whereSql: `last_seen >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  return {
    whereSql: `(
      (last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day'))
      OR
      (last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day'))
    )`,
    needsDays: true,
  };
}

async function segmentGetUsersUnified({ days = 30, source = "active", limit = SEGMENT_PUSH_LIMIT } = {}) {
  if (pool) {
    const p = mustPool();
    const src = normalizeSegmentSource(source);
    const d = clampDays(days);
    const lim = Math.min(SEGMENT_PUSH_LIMIT, Math.max(1, Number(limit || SEGMENT_PUSH_LIMIT)));
    const { whereSql, needsDays } = buildSegmentWhereSql(src, 1);

    let countTotal = 0;
    if (needsDays) {
      const rc = await p.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM segment_users WHERE ${whereSql}`, [d]);
      countTotal = Number(rc.rows?.[0]?.c || 0);
    } else {
      const rc = await p.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM segment_users WHERE ${whereSql}`);
      countTotal = Number(rc.rows?.[0]?.c || 0);
    }

    let items = [];
    if (needsDays) {
      const r = await p.query(`SELECT DISTINCT user_id FROM segment_users WHERE ${whereSql} ORDER BY user_id ASC LIMIT $2`, [d, lim]);
      items = r.rows.map((x) => x.user_id).filter(Boolean);
    } else {
      const r = await p.query(`SELECT DISTINCT user_id FROM segment_users WHERE ${whereSql} ORDER BY user_id ASC LIMIT $1`, [lim]);
      items = r.rows.map((x) => x.user_id).filter(Boolean);
    }

    items = Array.from(new Set(items.filter(Boolean)));
    return { source: src, days: src === "all" ? null : d, countTotal, countItems: items.length, items };
  }

  const src = normalizeSegmentSource(source);
  const d = clampDays(days);
  const book = readSegmentUsers();
  const now = Date.now();
  const ms = d * 24 * 60 * 60 * 1000;

  const all = Object.values(book)
    .filter((x) => {
      const lastSeen = x?.lastSeen ? new Date(x.lastSeen).getTime() : 0;
      const lastChat = x?.lastChatAt ? new Date(x.lastChatAt).getTime() : 0;
      const lastLiff = x?.lastLiffAt ? new Date(x.lastLiffAt).getTime() : 0;

      if (src === "all") return !!x?.userId;
      if (src === "chat") return lastChat && now - lastChat <= ms;
      if (src === "liff") return lastLiff && now - lastLiff <= ms;
      if (src === "seen") return lastSeen && now - lastSeen <= ms;
      return (lastChat && now - lastChat <= ms) || (lastLiff && now - lastLiff <= ms);
    })
    .map((x) => x.userId)
    .filter(Boolean);

  const uniq = Array.from(new Set(all));
  const lim = Math.min(SEGMENT_PUSH_LIMIT, Math.max(1, Number(limit || SEGMENT_PUSH_LIMIT)));
  const items = uniq.slice(0, lim);

  return { source: src, days: src === "all" ? null : d, countTotal: uniq.length, countItems: items.length, items };
}

// =============== LIFF idToken verify（任意） ===============
async function verifyLineIdToken(idToken) {
  if (!idToken || !LINE_CHANNEL_ID) return null;
  try {
    const params = new URLSearchParams();
    params.set("id_token", idToken);
    params.set("client_id", LINE_CHANNEL_ID);

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
      UPLOAD_DIR,
      PROFILE_REFRESH_DAYS,
      mode: "store_pickup_only",
      start_mode: "postback_only",
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

    try {
      if (pool) await dbUpsertLineUser(userId, {}, { forceProfile: false });
      else fileUpsertLineUser(userId, {}, {});
    } catch {}

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

// =============== 住所（DB）※店頭運用でも保存は可能（使わないだけ） ===============
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

// ★公開住所取得（トークン必須）
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

// =============== ミニアプリ：送料計算（店頭運用でも互換のため残す） ===============
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const itemsTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    // ★店頭運用固定：送料0
    return res.json({ ok: true, itemsTotal, region: "", size: "", shipping: 0, finalTotal: itemsTotal });
  } catch (e) {
    console.error("/api/shipping error:", e);
    return res.status(400).json({ ok: false, error: e?.message || "shipping_error" });
  }
});

app.get("/api/shipping/config", (_req, res) => {
  return res.json({
    ok: true,
    config: {
      mode: "store_pickup_only",
      shippingAlwaysZero: true,
      codFee: COD_FEE,
    },
  });
});

// =============== Stripe（互換のため残す） ===============
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || "").trim();
const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;

app.post("/api/pay-stripe", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const line_items = [];
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty = Number(it.qty) || 0;
      if (!qty || unit < 0) continue;
      line_items.push({
        price_data: { currency: "jpy", product_data: { name: String(it.name || it.id || "商品") }, unit_amount: unit },
        quantity: qty,
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

// Stripe/代引/振込の完了通知（互換のため残す）
app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.json({ ok: false, error: "no_items" });

    const paymentMethod = String(order.paymentMethod || order.payment || "stripe").toLowerCase();
    const status = paymentMethod === "stripe" ? "paid" : "new";
    const source = "liff";

    try {
      fs.appendFileSync(
        ORDERS_LOG,
        JSON.stringify({ ts: new Date().toISOString(), ...order, source, payment_method: paymentMethod, status }) + "\n",
        "utf8"
      );
    } catch {}

    const itemsTotal = Number(order.itemsTotal || 0) || items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const finalTotal = Number(order.finalTotal ?? order.total ?? 0) || itemsTotal;

    try {
      await dbInsertOrder({
        userId: order.lineUserId || null,
        memberCode: null,
        phone: null,
        items: items.map((it) => ({ id: it.id || "", name: it.name || "", price: Number(it.price || 0), qty: Number(it.qty || 0) })),
        total: finalTotal,
        shippingFee: 0,
        paymentMethod: paymentMethod === "stripe" ? "stripe" : "store",
        status,
        name: order.lineUserName || null,
        zip: null,
        pref: null,
        address: null,
        source,
        rawEvent: order,
      });
    } catch (e) {
      console.error("orders db insert skipped:", e?.message || e);
    }

    if (ADMIN_USER_ID) {
      const itemsLines = items
        .map((it) => `${it.name || it.id || "商品"} ×${Number(it.qty || 0)} = ${yen((Number(it.price) || 0) * (Number(it.qty) || 0))}`)
        .join("\n");

      const adminMsg =
        `🧾【注文完了（ミニアプリ）】\n` +
        `${itemsLines || "（明細なし）"}\n` +
        `\n支払：${paymentMethod === "stripe" ? "カード(Stripe)" : "店頭現金"}\n` +
        `合計：${yen(finalTotal)}\n` +
        `userId：${order.lineUserId || ""}\nsource：${source}`;

      try {
        await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
      } catch {}
    }

    const buyerId = String(order.lineUserId || "").trim();
    if (buyerId) {
      const buyerMsg = `ご注文ありがとうございます！\n合計：${yen(finalTotal)}\n（このメッセージは自動送信です）`;
      try {
        await client.pushMessage(buyerId, { type: "text", text: buyerMsg });
      } catch {}
    }

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
    const volume = req.body?.volume != null ? String(req.body.volume) : product.volume || "";

    const price = id === "kusuke-250" ? KUSUKE_UNIT_PRICE : req.body?.price != null ? Number(req.body.price) : product.price;
    const stock = req.body?.stock != null ? Number(req.body.stock) : product.stock;

    products[idx] = { ...product, name, desc, image, volume, price, stock };
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
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function yyyymmddFromIso(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  const date = String(req.query.date || "").trim();
  let items = readLogLines(ORDERS_LOG, limit);

  if (date && /^\d{8}$/.test(date)) {
    items = items.filter((o) => {
      const ts = o.ts || o.timestamp || o.created_at || "";
      const key = ts ? yyyymmddFromIso(ts) : "";
      return key === date;
    });
  }

  return res.json({ ok: true, items });
});

// ✅ 発送通知API（管理画面→顧客へPush）※店頭運用でも“受取準備完了”通知に使える
app.post("/api/admin/orders/notify-shipped", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const userId = String(req.body?.userId || "").trim();
    const orderKey = String(req.body?.orderKey || "").trim();
    const message = String(req.body?.message || "").trim();

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!message) return res.status(400).json({ ok: false, error: "message_required" });

    await client.pushMessage(userId, { type: "text", text: message });

    try {
      const st = readNotifyState();
      st[orderKey || `${userId}:${Date.now()}`] = { status: "ok", userId, ts: new Date().toISOString() };
      writeNotifyState(st);
    } catch (e) {
      console.warn("notify_state save skipped:", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/admin/orders/notify-shipped error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ ok: false, error: "notify_failed" });
  }
});

// DB注文（検索用）
app.get("/api/admin/orders-db", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const limit = Math.min(2000, Number(req.query.limit || 200));
    const payment = String(req.query.payment || "").trim().toLowerCase();
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

// =====================================
// ★管理：ユーザー一覧（display_name）
// =====================================
app.get("/api/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 500)));
    const q = String(req.query.q || "").trim();

    if (pool) {
      const p = mustPool();
      const params = [];
      let where = "";
      if (q) {
        params.push(`%${q}%`);
        where = `WHERE (display_name ILIKE $1 OR user_id ILIKE $1)`;
      }
      params.push(limit);

      const sql =
        `SELECT user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at
         FROM line_users
         ${where}
         ORDER BY last_seen DESC
         LIMIT $${params.length}`;

      const r = await p.query(sql, params);
      return res.json({ ok: true, count: r.rows.length, items: r.rows });
    }

    const book = readLineUsersFile();
    let items = Object.values(book);
    if (q) {
      const qq = q.toLowerCase();
      items = items.filter((x) => String(x.display_name || "").toLowerCase().includes(qq) || String(x.user_id || "").toLowerCase().includes(qq));
    }
    items.sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));
    items = items.slice(0, limit);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("/api/admin/users error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =====================================================
// ✅ 管理：セグメント（統一抽出）
// =====================================================
app.get("/api/admin/segment/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const source = String(req.query.source || "active");
    const includeProfile = String(req.query.includeProfile || "0") === "1";

    const r = await segmentGetUsersUnified({ days, source, limit: SEGMENT_PUSH_LIMIT });

    let profiles = null;
    if (includeProfile) {
      profiles = {};
      if (pool) {
        const p = mustPool();
        const parts = chunkArray(r.items, 1000);
        for (const part of parts) {
          const rr = await p.query(`SELECT user_id, display_name FROM line_users WHERE user_id = ANY($1::text[])`, [part]);
          for (const row of rr.rows) profiles[row.user_id] = row.display_name || "";
        }
      } else {
        const book = readLineUsersFile();
        for (const uid of r.items) profiles[uid] = book?.[uid]?.display_name || "";
      }
    }

    return res.json({
      ok: true,
      days: r.days,
      source: r.source,
      count: r.countTotal,
      returned: r.countItems,
      limit: SEGMENT_PUSH_LIMIT,
      items: r.items,
      profiles,
    });
  } catch (e) {
    console.error("/api/admin/segment/users error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.get("/api/admin/segment/count", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const source = String(req.query.source || "active");

    const r = await segmentGetUsersUnified({ days, source, limit: 1 });
    return res.json({ ok: true, days: r.days, source: r.source, count: r.countTotal });
  } catch (e) {
    console.error("/api/admin/segment/count error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(Boolean) : [];
    const messageText = String(req.body?.message || "").trim();

    if (!userIds.length) return res.status(400).json({ ok: false, error: "userIds_required" });
    if (!messageText) return res.status(400).json({ ok: false, error: "message_required" });

    const ids = Array.from(new Set(userIds)).slice(0, SEGMENT_PUSH_LIMIT);
    const chunks = chunkArray(ids, SEGMENT_CHUNK_SIZE);

    let okCount = 0;
    let ngCount = 0;

    for (const part of chunks) {
      try {
        await client.multicast(part, { type: "text", text: messageText });
        okCount += part.length;
      } catch (e) {
        ngCount += part.length;
        console.error("segment multicast error:", e?.response?.data || e?.message || e);
      }
    }

    return res.json({ ok: true, requested: ids.length, sent: okCount, failed: ngCount });
  } catch (e) {
    console.error("/api/admin/segment/send error:", e);
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
          p.volume ? { type: "text", text: `内容量：${String(p.volume)}`, size: "sm", wrap: true } : null,
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
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "数量選択", weight: "bold", size: "lg" },
          { type: "text", text: `現在の数量：${q} 個`, size: "md" },
          { type: "text", text: "※店頭受取（現金）のみです。", size: "sm", wrap: true },
        ],
      },
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
          // ★固定化：受取方法へは行かず、店頭へ直行
          { type: "button", style: "primary", action: { type: "postback", label: "店頭受取へ", data: `order_pickup_payment?${qstr({ id, qty: q })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧", data: "order_back" } },
        ],
      },
    },
  };
}

function paymentFlex(id, qty) {
  return {
    type: "flex",
    altText: "店頭受取（現金のみ）",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "お支払い方法", weight: "bold", size: "lg" },
          { type: "text", text: "店頭受取は現金のみです。", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", label: "現金で支払う（店頭）", data: `order_pickup_name?${qstr({ id, qty, method: "pickup", payment: "store" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "← 戻る", data: `order_qty?${qstr({ id, qty })}` } },
        ],
      },
    },
  };
}

function confirmFlex(product, qty, pickupName = "") {
  const subtotal = Number(product.price) * Number(qty);
  const total = subtotal;

  const lines = [
    `受取方法：店頭受取（送料0円）`,
    `支払い：店頭現金`,
    `商品：${product.name}`,
    ...(product.volume ? [`内容量：${String(product.volume)}`] : []),
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
    `送料：0円`,
    `合計：${yen(total)}`,
  ];

  if (pickupName) lines.push(`お名前：${pickupName}`);

  const img = toPublicImageUrl(product.image || "");

  const footerButtons = [];
  if (!pickupName) {
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: "お名前を入力する", data: `order_pickup_name?${qstr({ id: product.id, qty, method: "pickup", payment: "store" })}` },
    });
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
  } else {
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method: "pickup", payment: "store", pickupName })}` },
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
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {}
}

/** =========================================================
 *  ★ 管理者通知（公式アカウント受信 → ADMIN_USER_IDへPush）
 * ========================================================= */
function eventSourceText(ev) {
  const s = ev?.source || {};
  const type = s.type || "unknown";
  if (type === "user") return `user:${s.userId || ""}`;
  if (type === "group") return `group:${s.groupId || ""} user:${s.userId || ""}`;
  if (type === "room") return `room:${s.roomId || ""} user:${s.userId || ""}`;
  return `${type}:${s.userId || ""}`;
}

async function notifyAdminIncomingMessage(ev, bodyText, extra = {}) {
  if (!ADMIN_USER_ID) return;

  const userId = ev?.source?.userId || "";
  const ts = ev?.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString();
  const src = eventSourceText(ev);

  const msg =
    `📩【受信メッセージ】\n` +
    `時刻：${ts}\n` +
    `送信元：${src}\n` +
    (userId ? `userId：${userId}\n` : "") +
    (extra?.kind ? `種別：${extra.kind}\n` : "") +
    (extra?.session ? `セッション：${extra.session}\n` : "") +
    `\n` +
    `${String(bodyText || "").slice(0, 1800)}`;

  try {
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
  } catch (e) {
    console.error("[ADMIN PUSH] incoming message failed:", e?.response?.data || e?.message || e);
  }
}

// =============== handleEvent ===============
async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";

  // ★まず台帳更新（seen）
  if (userId) {
    try {
      await touchUser(userId, "seen");
    } catch {}
    try {
      const force = ev.type === "follow";
      await maybeRefreshLineProfile(userId, ev, { force });
    } catch {}
  }

  // ==============================
  // 会員コード照会（チャット）
  // ==============================
  if (ev.type === "message" && ev.message?.type === "text" && ev.message.text.trim() === "会員コード") {
    try {
      if (!pool) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "現在、会員コード照会（DB）が未設定です。住所登録（LIFF）後にDB設定をご確認ください。",
        });
      }

      const { rows } = await mustPool().query(
        `
        SELECT member_code
        FROM addresses
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1
        `,
        [userId]
      );

      if (rows.length === 0) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "まだ会員コードが発行されていません。\n先にミニアプリから住所登録をお願いします。",
        });
      }

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `あなたの会員コードは【${rows[0].member_code}】です。\n\n📞 電話注文の際にお伝えください。`,
      });
    } catch (err) {
      console.error("会員コード取得エラー", err);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "会員コードの取得に失敗しました。時間をおいてお試しください。",
      });
    }
  }

  // 友だち追加（開始キーワードは案内しない）
  if (ev.type === "follow") {
    if (userId) await touchUser(userId, "seen");
    const msg =
      "友だち追加ありがとうございます！\n\n" +
      "ご注文はリッチメニューから開始してください（店頭受取・現金のみ）。\n" +
      "※注文途中の入力（お名前など）は案内に沿って送信してください。\n" +
      "住所登録（LIFF）もできます（※店頭運用でも登録可）";
    return client.replyMessage(ev.replyToken, { type: "text", text: msg });
  }

  // ===========================
  // テキスト以外も管理者へ通知（返信はしない）
  // ===========================
  if (ev.type === "message" && ev.message && ev.message.type && ev.message.type !== "text") {
    const m = ev.message;

    if (m.type === "sticker") {
      await notifyAdminIncomingMessage(ev, `（スタンプ）packageId=${m.packageId} stickerId=${m.stickerId}`, { kind: "sticker" });
      return null;
    }
    if (m.type === "location") {
      const t =
        `（位置情報）\n` + `タイトル：${m.title || ""}\n` + `住所：${m.address || ""}\n` + `緯度経度：${m.latitude},${m.longitude}`;
      await notifyAdminIncomingMessage(ev, t, { kind: "location" });
      return null;
    }
    if (m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "file") {
      await notifyAdminIncomingMessage(ev, `（${m.type}）messageId=${m.id || ""}`, { kind: m.type });
      return null;
    }

    await notifyAdminIncomingMessage(ev, `（${m.type}）受信`, { kind: m.type });
    return null;
  }

  // ===========================
  // ✅ テキストメッセージ
  // ===========================
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = String(ev.message.text || "").trim();
    const sess = userId ? getSession(userId) : null;

    // ★管理者通知：受信テキストは全部転送
    try {
      await notifyAdminIncomingMessage(ev, text, { kind: "text", session: sess?.mode || "" });
    } catch {}

    // --- セッション入力：店頭受取名 ---
    if (sess?.mode === "pickup_name") {
      await touchUser(userId, "chat");
      const pickupName = text.slice(0, 40);
      const id = sess.id;
      const qty = Number(sess.qty || 1);
      clearSession(userId);

      const product = loadProductByOrderId(id);
      return client.replyMessage(ev.replyToken, [
        { type: "text", text: `店頭受取のお名前「${pickupName}」で進めます。` },
        confirmFlex(product, qty, pickupName),
      ]);
    }

    // --- セッション入力：その他（商品名） ---
    if (sess?.mode === "other_name") {
      await touchUser(userId, "chat");
      const name = text.replace(/\s+/g, " ").slice(0, 60);
      if (!name) return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください。" });
      setSession(userId, { mode: "other_qty", otherName: name });
      return client.replyMessage(ev.replyToken, { type: "text", text: `「${name}」ですね。個数を数字で入力してください（例：3）` });
    }

    if (sess?.mode === "other_qty") {
      await touchUser(userId, "chat");
      const m = /^(\d{1,2})$/.exec(text);
      if (!m) return client.replyMessage(ev.replyToken, { type: "text", text: "個数を数字で入力してください（例：3）" });
      const qty = Number(m[1]);
      if (qty < 1 || qty > 99) return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 で入力してください。" });

      const otherName = String(sess.otherName || "その他");
      clearSession(userId);

      const id = `other:${encodeURIComponent(otherName)}:0`;
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "数量を選んでください。" }, qtyFlex(id, qty)]);
    }

    // ★開始キーワードは無効化（ポストバックのみで開始）
    // それ以外は無反応（仕様）
    return null;
  }

  // ===========================
  // Postback（開始もここだけ）
  // ===========================
  if (ev.type === "postback") {
    const data = String(ev.postback?.data || "");

    // ✅ リッチメニュー開始（ここだけで開始）
    if (data === "start_order") {
      await touchUser(userId, "chat");
      return client.replyMessage(ev.replyToken, [
        { type: "text", text: "店頭受取でのご注文を開始します。商品を選んでください。" },
        productsFlex(),
      ]);
    }
    if (data === "start_kusuke") {
      await touchUser(userId, "chat");
      const msg =
        "久助のご注文を開始します。（店頭受取のみ）\n" +
        `単価：${yen(KUSUKE_UNIT_PRICE)}（税込）\n\n` +
        "久助は「テキストで数量」を送ってください。\n例：\n久助 3";
      return client.replyMessage(ev.replyToken, { type: "text", text: msg });
    }
    if (data === "start_other") {
      if (!userId) return null;
      setSession(userId, { mode: "other_name" });
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください（例：えびせん詰め合わせ）" });
    }

    // 既存の戻る/その他開始
    if (data === "order_back") {
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "商品一覧に戻ります。" }, productsFlex()]);
    }

    if (data === "other_start") {
      if (!userId) return null;
      setSession(userId, { mode: "other_name" });
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください（例：えびせん詰め合わせ）" });
    }

    if (data.startsWith("order_qty?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, qtyFlex(q.id, q.qty));
    }

    // ★店頭固定：数量→店頭支払へ
    if (data.startsWith("order_pickup_payment?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, paymentFlex(q.id, Number(q.qty || 1)));
    }

    if (data.startsWith("order_pickup_name?")) {
      const q = parseQuery(data);
      setSession(userId, { mode: "pickup_name", id: q.id, qty: Number(q.qty || 1) });
      return client.replyMessage(ev.replyToken, { type: "text", text: "店頭で受け取るお名前を入力してください。" });
    }

    // ★保険：confirm_view が呼ばれても店頭固定で表示
    if (data.startsWith("order_confirm_view?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);
      const pickupName = String(q.pickupName || "").trim();
      const product = loadProductByOrderId(id);
      return client.replyMessage(ev.replyToken, confirmFlex(product, qty, pickupName));
    }

    if (data.startsWith("order_confirm?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);

      // ★店頭固定（強制）
      const method = "pickup";
      const payment = "store";
      const pickupName = String(q.pickupName || "").trim();

      if (!pickupName) {
        const product = loadProductByOrderId(id);
        return client.replyMessage(ev.replyToken, [
          { type: "text", text: "お名前が未入力です。先に入力してください。" },
          confirmFlex(product, qty, ""),
        ]);
      }

      const product = loadProductByOrderId(id);

      // 在庫チェック（otherは在庫無限扱い）
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

        addStock(p.id, -qty, "order_confirm");
        await maybeLowStockAlert(p.id, p.name, Math.max(0, stock - qty));
      }

      const shipping = 0;
      const subtotal = Number(product.price || 0) * qty;
      const total = subtotal;

      const order = {
        ts: new Date().toISOString(),
        userId,
        productId: product.id,
        productName: product.name,
        price: Number(product.price || 0),
        qty,
        method,
        payment,
        pickupName,
        shipping,
        total,
        note: String(product.id).startsWith("other:") ? "価格未入力（その他）" : "",
      };

      try {
        appendJsonl(ORDERS_LOG, { ...order, source: "line-postback" });
      } catch {}

      // DB保存
      try {
        let memberCode = null;
        if (pool) {
          const c = await dbGetCodesByUserId(userId);
          memberCode = c?.member_code ? String(c.member_code).trim() : null;
        }

        await dbInsertOrder({
          userId,
          memberCode,
          phone: null,
          items: [{ id: product.id, name: product.name, price: Number(product.price || 0), qty }],
          total,
          shippingFee: 0,
          paymentMethod: "store",
          status: "new",
          name: pickupName || null,
          zip: null,
          pref: null,
          address: null,
          source: "line-postback",
          rawEvent: { ...order, source: "line-postback" },
        });
      } catch (e) {
        console.error("orders db insert skipped:", e?.message || e);
      }

      // 管理者通知
      if (ADMIN_USER_ID) {
        const msg =
          `🧾【新規注文（店頭受取）】\n` +
          `商品：${product.name}\n` +
          `数量：${qty}\n` +
          `支払：店頭現金\n` +
          `合計：${yen(total)}\n` +
          (order.note ? `※${order.note}\n` : "") +
          `\n店頭受取名：${pickupName}\nuserId：${userId}`;

        try {
          await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
        } catch {}
      }

      const userMsg =
        "ご注文ありがとうございます！（店頭受取）\n\n" +
        `商品：${product.name}\n` +
        `数量：${qty}\n` +
        `合計：${yen(total)}\n` +
        `\n店頭受取のお名前：${pickupName}\n` +
        "※店頭でお声がけください。";

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
  if (String(id).startsWith("other:")) {
    const parts = String(id).split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    return { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: 9999, image: "", volume: "" };
  }

  const { product } = findProductById(id);
  if (!product) return { id, name: id, price: 0, stock: 0, image: "", volume: "" };

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
  }

  app.listen(PORT, () => {
    console.log(`[BOOT] server listening on ${PORT}`);
    console.log(`[BOOT] UPLOAD_DIR=${UPLOAD_DIR}`);
    console.log(`[BOOT] PROFILE_REFRESH_DAYS=${PROFILE_REFRESH_DAYS}`);
    console.log(`[BOOT] MODE=store_pickup_only`);
    console.log(`[BOOT] START=postback_only`);
  });
}

start().catch((e) => {
  console.error("[BOOT] start() failed:", e);
  process.exit(1);
});
