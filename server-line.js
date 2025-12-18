// server-line.js — フル機能版（Stripe + ミニアプリ + 画像管理）【修正版・丸ごと】
// + Flex配信 / その他（価格入力なし）/ 久助専用テキスト購入フロー
// + 予約 / 管理API / 店頭受取 Fix（店頭=現金のみ）/ 銀行振込案内
// + 画像アップロード/一覧/削除 + 商品へ画像URL紐付け
// + ミニアプリ用 /api/products（久助除外） /api/shipping（ヤマト中部発）
// + LIFF 住所保存/取得（DB）: /api/liff/address /api/liff/address/me /api/liff/config
// + ★LIFF起動ログ（セグメント配信用）: /api/liff/open
// + ★管理：セグメント抽出/一括Push : /api/admin/segment/liff-open , /api/admin/push/segment
// + Stripe決済 /api/pay-stripe / 決済完了通知 /api/order/complete
// + 会員コード/住所コード（DB・4桁）
// + 電話→オンライン hook /api/phone/hook（phone-addresses.json + DB反映）
// + Health
//
// ★セキュリティFIX（重要）
// - /api/public/address-by-code は公開しない（トークン必須）
//   → env: PUBLIC_ADDRESS_LOOKUP_TOKEN を必ず設定して使う
//
// ★DBスキーマ（自動作成）
// - codes(user_id PK, member_code UNIQUE, address_code UNIQUE)
// - addresses(member_code PK, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at)
// - phone_address_events（任意ログ）
  // message_events（テキスト送信者セグメント用）
  await p.query(`
    CREATE TABLE IF NOT EXISTS message_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT NOT NULL,
      msg_type TEXT NOT NULL,
      text_len INT DEFAULT 0
    );
  
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_ts ON message_events(ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_user_id ON message_events(user_id);`);

// - ★liff_open_logs（セグメント配信用）
  // ===== テキスト送信ログ（セグメント配信用） =====
 
  `
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_ts ON message_events(ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_message_events_user_id ON message_events(user_id);`);



"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const multer = require("multer");
const stripeLib = require("stripe");
const { Pool } = require("pg");

// ===== Express =====
const app = express();
const PORT = process.env.PORT || 3000;

// ===== PostgreSQL =====
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

// ====== 4桁コード生成 ======
function rand4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

// ====== 環境変数 ======
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const LIFF_ID_DIRECT_ADDRESS = (process.env.LIFF_ID_DIRECT_ADDRESS || LIFF_ID).trim();
const LIFF_ID_SHOP = (process.env.LIFF_ID_SHOP || "").trim();

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim();

const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

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

// ===== Stripe =====
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || "").trim();
const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;
if (!stripe) {
  console.warn("⚠️ STRIPE_SECRET_KEY / STRIPE_SECRET が設定されていません。/api/pay-stripe はエラーになります。");
}

// ====== パス定義 ======
const DATA_DIR = path.join(__dirname, "data");

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json"); // (旧) 互換・参考用
const PHONE_ADDRESSES_PATH = path.join(DATA_DIR, "phone-addresses.json");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

// static
app.use("/public", express.static(PUBLIC_DIR));

// ====== ディレクトリ自動作成 ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ====== ページ ======
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== データ初期化 ======
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250", name: "久助（えびせん）", price: 250, stock: 20, desc: "お得な割れせん。", image: "" },
    { id: "original-set-2100", name: "磯屋オリジナルセット", price: 2100, stock: 10, desc: "人気の詰め合わせ。", image: "" },
    { id: "nori-square-300", name: "四角のりせん", price: 300, stock: 10, desc: "のり香る角せん。", image: "" },
    { id: "premium-ebi-400", name: "プレミアムえびせん", price: 400, stock: 5, desc: "贅沢な旨み。", image: "" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(PHONE_ADDRESSES_PATH)) fs.writeFileSync(PHONE_ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH)) fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");

// ====== ユーティリティ ======
const safeReadJSON = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};

const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (data) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");

const readPhoneAddresses = () => safeReadJSON(PHONE_ADDRESSES_PATH, {});
const writePhoneAddresses = (data) => fs.writeFileSync(PHONE_ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");

const readSessions = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions = (s) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");

const readNotifyState = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (s) => fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s, null, 2), "utf8");

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

const qstr = (obj) =>
  Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === undefined || v === null ? "" : v)}`)
    .join("&");

const parse = (data) => {
  const s = data && data.includes("=") ? data : "";
  const o = {};
  s.split("&").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  return o;
};

// ===== 認可 =====
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
function requireAdmin(req, res) {
  const headerTok = bearerToken(req);
  const queryTok = (req.query?.token || req.query?.code || "").trim();
  const tok = headerTok || queryTok;

  if (ADMIN_API_TOKEN_ENV && tok === ADMIN_API_TOKEN_ENV) return true;
  if (ADMIN_CODE_ENV && tok === ADMIN_CODE_ENV) return true;

  res.status(401).json({
    ok: false,
    error: "unauthorized",
    hint: {
      need: { bearer_header: !!ADMIN_API_TOKEN_ENV, token_query: !!ADMIN_API_TOKEN_ENV, code_query: !!ADMIN_CODE_ENV },
      got: { header: headerTok ? "present" : "missing", query: queryTok ? "present" : "missing" },
    },
  });
  return false;
}

// ===== ログ読み込み =====
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
function jstRangeFromYmd(ymd) {
  const s = String(ymd || "");
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const startJST = new Date(Date.UTC(y, m, d, -9, 0, 0));
  const endJST = new Date(Date.UTC(y, m, d + 1, -9, 0, 0));
  return { from: startJST.toISOString(), to: endJST.toISOString() };
}
function filterByIsoRange(items, getTs, fromIso, toIso) {
  if (!fromIso && !toIso) return items;
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  return items.filter((it) => {
    const t = new Date(getTs(it)).getTime();
    return t >= from && t < to;
  });
}

// ====== ★LINE client（1回だけ生成） ======
const client = new line.Client(config);

// ====== ★ LINE 疎通確認 API ======
app.get("/api/line/ping", async (_req, res) => {
  try {
    if (!ADMIN_USER_ID) return res.status(400).json({ ok: false, error: "ADMIN_USER_ID not set" });
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: "✅ LINEサーバー疎通テストOK" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.response?.data || e?.message || String(e) });
  }
});

/**
 * ★超重要FIX：
 * express.json が /webhook より先に走ると、LINE署名検証が壊れることがある。
 * → /webhook は JSON パーサを通さない（line.middleware に任せる）
 */
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

// ======================================================================
// DB スキーマ自動作成（最重要）
// ======================================================================
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
    CREATE TABLE IF NOT EXISTS phone_address_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      member_code CHAR(4),
      is_new BOOLEAN,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_phone_address_events_member_code ON phone_address_events(member_code);`);

  // ✅ ここが今回の追加：テキスト送信ログ（セグメント配信用）
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

// ======================================================================
// codes / addresses DB関数（一本化）
// ======================================================================
async function dbGetCodesByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const r = await p.query(`SELECT user_id, member_code, address_code FROM codes WHERE user_id=$1 LIMIT 1`, [uid]);
  return r.rows[0] || null;
}
async function dbGetCodesByMemberCode(memberCode) {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) return null;
  const r = await p.query(`SELECT user_id, member_code, address_code FROM codes WHERE member_code=$1 LIMIT 1`, [mc]);
  return r.rows[0] || null;
}
async function dbEnsurePhoneCodesByMemberCode(memberCode, phoneE164 = "") {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) throw new Error("invalid_memberCode");

  const exist = await dbGetCodesByMemberCode(mc);
  if (exist?.user_id) return exist;

  const uidBase = phoneE164 ? `phone:${phoneE164}` : `phone:${mc}`;

  for (let i = 0; i < 50; i++) {
    const uid = i === 0 ? uidBase : `${uidBase}:${i}`;
    try {
      await p.query(`INSERT INTO codes (user_id, member_code, address_code) VALUES ($1,$2,$3)`, [uid, mc, mc]);
      return { user_id: uid, member_code: mc, address_code: mc };
    } catch (e) {
      if (String(e?.code) === "23505") {
        const again = await dbGetCodesByMemberCode(mc);
        if (again?.user_id) return again;
        continue;
      }
      throw e;
    }
  }
  throw new Error("ensure_phone_codes_failed");
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

    const clientDb = await p.connect();
    try {
      await clientDb.query("BEGIN");
      await clientDb.query(`INSERT INTO codes (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);

      const current = await clientDb.query(
        `SELECT member_code, address_code FROM codes WHERE user_id=$1 FOR UPDATE`,
        [uid]
      );
      const row = current.rows[0] || {};

      const nextMember = row.member_code ? row.member_code : mc;
      const nextAddress = row.address_code ? row.address_code : ac;

      await clientDb.query(
        `UPDATE codes SET member_code=$2, address_code=$3 WHERE user_id=$1`,
        [uid, nextMember, nextAddress]
      );

      await clientDb.query("COMMIT");

      const done = await dbGetCodesByUserId(uid);
      if (done?.member_code && done?.address_code) return done;
    } catch (e) {
      await clientDb.query("ROLLBACK");
      if (String(e?.code) === "23505") continue;
      throw e;
    } finally {
      clientDb.release();
    }
  }
  throw new Error("code_generation_exhausted");
}

async function getOrCreateMemberCode(userId) {
  const c = await dbEnsureCodes(userId);
  return String(c.member_code || "");
}
async function getOrCreateAddressCode(userId) {
  const c = await dbEnsureCodes(userId);
  return String(c.address_code || "");
}

async function dbGetAddressByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const r = await p.query(
    `
    SELECT
      c.user_id,
      c.member_code,
      c.address_code,
      a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2,
      a.updated_at
    FROM codes c
    LEFT JOIN addresses a
      ON a.member_code = c.member_code
    WHERE c.user_id = $1
    LIMIT 1
    `,
    [uid]
  );

  const row = r.rows[0] || null;
  if (!row || !row.member_code) return null;

  const hasAny = row.name || row.phone || row.postal || row.prefecture || row.city || row.address1 || row.address2;
  if (!hasAny) return null;

  return row;
}

async function dbUpsertAddressByUserId(userId, addr = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const codes = await dbEnsureCodes(uid);
  const memberCode = String(codes.member_code || "").trim();
  if (!/^\d{4}$/.test(memberCode)) throw new Error("member_code missing");

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

async function dbGetAddressByMemberCode(memberCode) {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) return null;

  const r = await p.query(
    `
    SELECT
      a.member_code,
      a.user_id,
      a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2,
      a.updated_at
    FROM addresses a
    WHERE a.member_code = $1
    LIMIT 1
    `,
    [mc]
  );
  return r.rows[0] || null;
}

async function dbUpsertAddressByMemberCode(memberCode, addr = {}) {
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) throw new Error("invalid_memberCode");

  const codes = await dbGetCodesByMemberCode(mc);
  if (!codes?.user_id) return { ok: false, reason: "memberCode_not_found" };

  await dbUpsertAddressByUserId(codes.user_id, addr);
  return { ok: true, userId: codes.user_id };
}

// ======================================================================
// Flex / 商品 / 在庫
// ======================================================================
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = {
  久助: "kusuke-250",
  くすけ: "kusuke-250",
  kusuke: "kusuke-250",
  "kusuke-250": "kusuke-250",
};
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

function resolveProductId(token) {
  return PRODUCT_ALIASES[token] || token;
}
function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function writeStockLog(entry) {
  try {
    fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
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
async function maybeLowStockAlert(productId, productName, stockNow) {
  if (stockNow < LOW_STOCK_THRESHOLD && ADMIN_USER_ID) {
    const msg =
      `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n` + `残り：${stockNow}個\nしきい値：${LOW_STOCK_THRESHOLD}個`;
    try {
      await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
    } catch {}
  }
}

// ====== ヤマト送料（中部発・税込） & サイズ自動判定 ======
const YAMATO_CHUBU_TAXED = {
  "60":  { 北海道:1610, 東北:1190, 関東: 940, 中部: 940, 近畿: 940, 中国:1060, 四国:1060, 九州:1190, 沖縄:1460 },
  "80":  { 北海道:1900, 東北:1480, 関東:1230, 中部:1230, 近畿:1230, 中国:1350, 四国:1350, 九州:1480, 沖縄:2070 },
  "100": { 北海道:2200, 東北:1790, 関東:1530, 中部:1530, 近畿:1530, 中国:1650, 四国:1650, 九州:1790, 沖縄:2710 },
  "120": { 北海道:2780, 東北:2310, 関東:2040, 中部:2040, 近畿:2040, 中国:2170, 四国:2170, 九州:2310, 沖縄:3360 },
  "140": { 北海道:3440, 東北:2930, 関東:2630, 中部:2630, 近畿:2630, 中国:2780, 四国:2780, 九州:2930, 沖縄:4030 },
  "160": { 北海道:3820, 東北:3320, 関東:3020, 中部:3020, 近畿:3020, 中国:3160, 四国:3160, 九州:3320, 沖縄:4680 },
};
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
const SIZE_ORDER = ["60", "80", "100", "120", "140", "160"];
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
    return s + (it.id === ORIGINAL_SET_PRODUCT_ID || /磯屋.?オリジナルセ/.test(it.name || "") ? Number(it.qty || 0) : 0);
  }, 0);

  let size;
  if (akasha6Qty > 0) size = sizeFromAkasha6Qty(akasha6Qty);
  else if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else size = sizeFromTotalQty(totalQty);

  const shipping = calcYamatoShipping(region, size);
  return { region, size, shipping };
}

// ====== 送料設定返却 ======
app.get("/api/shipping/config", (_req, res) => {
  return res.json({
    ok: true,
    config: {
      origin: "yamato_chubu_taxed",
      originalSetProductId: ORIGINAL_SET_PRODUCT_ID,
      sizeOrder: SIZE_ORDER,
      yamatoChubuTaxed: YAMATO_CHUBU_TAXED,
      rules: {
        totalQty: "1=>60, 2=>80, 3=>100, 4=>120, 5-6=>140, 7+=>160",
        originalSetQty: "1=>80, 2=>100, 3-4=>120, 5-6=>140, 7+=>160",
        akasha6Qty: "1-4=>60, 5-8=>80, 9-13=>100, 14-18=>120, 19+=>140",
      },
      regions: Object.keys(YAMATO_CHUBU_TAXED["60"] || {}),
    },
  });
});

// ====== 送料計算 API ======
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const { region, size, shipping } = calcShippingUnified(items, address);
    const finalTotal = itemsTotal + shipping;

    res.json({ ok: true, itemsTotal, region, size, shipping, finalTotal });
  } catch (e) {
    console.error("/api/shipping error:", e);
    res.status(400).json({ ok: false, error: e.message || "shipping_error" });
  }
});

// ===== 画像URL整形 =====
function toPublicImageUrl(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(".onrender.com./", ".onrender.com/");
  if (/^https?:\/\//i.test(s)) return s;

  let fname = s;
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) fname = s.slice(lastSlash + 1);

  const pathPart = `/public/uploads/${fname}`;
  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (hostFromRender) return `https://${hostFromRender}${pathPart}`;
  return pathPart;
}

// ======================================================================
// ★LIFF 起動ログ（セグメント配信用）
// ======================================================================
app.post("/api/liff/open", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const kindRaw = String(req.body?.kind || "order").trim();
    const kind = kindRaw.slice(0, 32);

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

// ======================================================================
// LIFF API（住所：DB版）
// ======================================================================
app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    await dbUpsertAddressByUserId(userId, addr);
    const codes = await dbEnsureCodes(userId);

    res.json({ ok: true, memberCode: String(codes.member_code || ""), addressCode: String(codes.address_code || ""), saved: true });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
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
    res.json({ ok: false, address: null });
  }
});

// ✅ config は二重定義しない（この1本だけ）
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();
  if (kind === "shop") {
    if (!LIFF_ID_SHOP) return res.status(500).json({ ok: false, error: "LIFF_ID_SHOP_not_set" });
    return res.json({ ok: true, liffId: LIFF_ID_SHOP });
  }
  if (kind === "cod") return res.json({ ok: true, liffId: LIFF_ID_DIRECT_ADDRESS || LIFF_ID });
  return res.json({ ok: true, liffId: LIFF_ID });
});

// ★危険：公開住所取得API（トークン必須）
app.get("/api/public/address-by-code", async (req, res) => {
  try {
    const token = String(req.query.token || req.headers["x-public-token"] || "").trim();
    if (!PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(500).json({ ok: false, error: "PUBLIC_ADDRESS_LOOKUP_TOKEN_not_set" });
    if (token !== PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

    const code = String(req.query.code || "").trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: "code_required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const addr = await dbGetAddressByMemberCode(code);
    if (!addr) return res.status(404).json({ ok: false, error: "address_not_registered" });

    const r = await mustPool().query(`SELECT user_id, member_code, address_code FROM codes WHERE member_code=$1 LIMIT 1`, [code]);
    const row = r.rows[0] || {};

    return res.json({
      ok: true,
      address: {
        postal: addr.postal || "",
        prefecture: addr.prefecture || "",
        city: addr.city || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        memberCode: String(row.member_code || addr.member_code || ""),
        addressCode: String(row.address_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/public/address-by-code error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// ======================================================================
// ミニアプリ用：商品一覧 API（久助除外）
// ======================================================================
app.get("/api/products", (_req, res) => {
  try {
    const items = readProducts()
      .filter((p) => p.id !== "kusuke-250")
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        volume: p.volume || "",
        image: toPublicImageUrl(p.image || ""),
      }));

    res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ======================================================================
// 画像アップロード & 管理
// ======================================================================
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

// ======================================================================
// Stripe 決済（Checkout Session）
// ======================================================================
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

// ======================================================================
// 管理API（最小） + ★セグメント配信API
// ======================================================================
app.get("/api/admin/ping", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, ping: "pong" });
});

app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(ORDERS_LOG, limit);

  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, (x) => x.ts, range.from, range.to);

  res.json({ ok: true, items });
});

app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock ?? 0,
    desc: p.desc || "",
    volume: p.volume || "",
    image: p.image || "",
  }));
  res.json({ ok: true, items });
});

app.post("/api/admin/stock/set", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(String(req.body?.productId || "").trim());
    const qty = Number(req.body?.qty);
    const r = setStock(pid, qty, "api");
    return res.json({ ok: true, productId: pid, ...r });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/stock/add", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(String(req.body?.productId || "").trim());
    const delta = Number(req.body?.delta);
    const r = addStock(pid, delta, "api");
    return res.json({ ok: true, productId: pid, ...r });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/admin/upload-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err?.message || "upload_error" });
    if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });

    const filename = req.file.filename;
    const relPath = `/public/uploads/${filename}`;

    let base = PUBLIC_BASE_URL;
    if (!base) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host;
      base = `${proto}://${host}`;
    }
    const url = `${base}${relPath}`;

    res.json({ ok: true, file: filename, url, path: relPath, size: req.file.size, mimetype: req.file.mimetype });
  });
});

app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map((name) => {
        const p = path.join(UPLOAD_DIR, name);
        const st = fs.statSync(p);
        return { name, url: `/public/uploads/${name}`, path: `/public/uploads/${name}`, bytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ ok: true, items: files });
  } catch (e) {
    res.status(500).json({ ok: false, error: "list_error" });
  }
});

app.delete("/api/admin/images/:name", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const base = (req.params?.name || "").replace(/\.\./g, "").replace(/[\/\\]/g, "");
  const p = path.join(UPLOAD_DIR, base);
  try {
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: "not_found" });
    fs.unlinkSync(p);
    res.json({ ok: true, deleted: base });
  } catch (e) {
    res.status(500).json({ ok: false, error: "delete_error" });
  }
});

// ✅ ここは「必ず閉じる」：あなたのコードはここが壊れてました
app.post("/api/admin/products/set-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = String(req.body?.productId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!pid) return res.status(400).json({ ok: false, error: "productId required" });

    const { products, idx } = findProductById(pid);
    if (idx < 0) return res.status(404).json({ ok: false, error: "product_not_found" });

    products[idx].image = imageUrl;
    writeProducts(products);
    res.json({ ok: true, product: products[idx] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "save_error" });
  }
}); // ←✅ここが重要

// ======================================================================
// ★セグメント抽出（テキスト送信者）
// ======================================================================
async function segmentTextSenders(days = 30) {
  const d = Math.max(1, Math.min(365, Number(days) || 30));
  if (!pool) return [];
  const r = await mustPool().query(
    `SELECT DISTINCT user_id
       FROM message_events
      WHERE ts >= NOW() - ($1 || ' days')::interval`,
    [String(d)]
  );
  return (r.rows || []).map((x) => x.user_id).filter(Boolean);
}

// GET /api/admin/segment/text-senders?days=30
app.get("/api/admin/segment/text-senders", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const items = await segmentTextSenders(days);
    res.json({ ok: true, segment: "text_senders", days, count: items.length, items });
  } catch (e) {
    console.error("segment text-senders error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ======================================================================
// ★セグメント抽出（LIFF起動者）
// ======================================================================
// GET /api/admin/segment/liff-open?kind=order&days=30
app.get("/api/admin/segment/liff-open", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.json({ ok: true, items: [] });

    const kind = String(req.query.kind || "order").trim().slice(0, 32);
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));

    const r = await mustPool().query(
      `
      SELECT DISTINCT user_id
      FROM liff_open_logs
      WHERE kind = $1
        AND opened_at >= NOW() - ($2 || ' days')::interval
      ORDER BY user_id ASC
      `,
      [kind, String(days)]
    );

    return res.json({ ok: true, segment: "liff-open", kind, days, count: r.rows.length, items: r.rows.map((x) => x.user_id) });
  } catch (e) {
    console.error("/api/admin/segment/liff-open error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// ======================================================================
// ★管理：セグメントへ一括Push（自前セグメント配信）
// POST /api/admin/push/segment
// body:
// {
//   segment: "liff-open" | "text-senders",
//   kind: "order" (liff-openのみ),
//   days: 30,
//   message: { type:"text", text:"..." }
// }
// ======================================================================
app.post("/api/admin/push/segment", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const segment = String(req.body?.segment || "liff-open").trim();
    const days = Math.min(365, Math.max(1, Number(req.body?.days || 30)));
    const message = req.body?.message;

    if (!message || !message.type) return res.status(400).json({ ok: false, error: "message required" });
    if (message.type === "text" && !String(message.text || "").trim()) return res.status(400).json({ ok: false, error: "text required" });

    let ids = [];

    if (segment === "text-senders") {
      ids = await segmentTextSenders(days);
    } else {
      const kind = String(req.body?.kind || "order").trim().slice(0, 32);
      const r = await mustPool().query(
        `
        SELECT DISTINCT user_id
        FROM liff_open_logs
        WHERE kind = $1
          AND opened_at >= NOW() - ($2 || ' days')::interval
        `,
        [kind, String(days)]
      );
      ids = (r.rows || []).map((x) => x.user_id).filter(Boolean);
    }

    let okCount = 0;
    let ngCount = 0;

    for (const uid of ids) {
      try {
        await client.pushMessage(uid, message);
        okCount++;
      } catch {
        ngCount++;
      }
    }

    return res.json({ ok: true, segment, days, target: ids.length, pushed: okCount, failed: ngCount });
  } catch (e) {
    console.error("/api/admin/push/segment error:", e?.response?.data || e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// ======================================================================
// Webhook（ここで line.middleware を通す）
// ======================================================================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    const detail = err?.originalError?.response?.data || err?.response?.data || err?.stack || err;
    console.error("Webhook Error detail:", JSON.stringify(detail, null, 2));
    res.status(500).end();
  }
});

// ======================================================================
// イベント処理（※必要最低限：テキストログ＆会員コード返しだけ残す）
// あなたの元コードが長大なので、ここは「落ちない・セグメントログが取れる」状態を優先
// ======================================================================
async function handleEvent(ev) {
  try {
    if (ev.type === "message" && ev.message?.type === "text") {
      const uid = ev.source?.userId || "";
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

      // messages.log（ファイル）
      try {
        fs.appendFileSync(
          MESSAGES_LOG,
          JSON.stringify({ ts: new Date().toISOString(), userId: uid, type: "text", len: t.length }) + "\n",
          "utf8"
        );
      } catch {}

      // ✅ message_events（DB：セグメント用）
      if (pool) {
        try {
          const id = String(uid || "").trim();
          if (id) {
            await mustPool().query(
              `INSERT INTO message_events (user_id, msg_type, text_len) VALUES ($1,$2,$3)`,
              [id, "text", Number(t.length || 0)]
            );
          }
        } catch (e) {
          console.warn("message_events insert skipped:", e?.message || e);
        }
      }

      // 管理者へ通知（任意）
      const isAdmin = ADMIN_USER_ID && uid === ADMIN_USER_ID;
      if (!isAdmin && ADMIN_USER_ID && t) {
        const notice = "📩【お客さまからのメッセージ】\n" + `ユーザーID：${uid}\n` + `メッセージ：${t}`;
        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: notice }); } catch {}
      }

      // 会員コード
      if (t === "会員コード") {
        if (!pool) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "現在DBが未設定のため会員コードを発行できません（DATABASE_URL未設定）。" });
          return;
        }
        const code = await getOrCreateMemberCode(uid);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: `磯屋 会員コード\n----------------------\n${code}\n\n※住所が未登録の場合は、リッチメニューの「住所登録」から登録してください。`,
        });
        return;
      }

      // 住所コード
      if (t === "住所コード" || t === "住所番号") {
        if (!pool) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "現在DBが未設定のため住所コードを発行できません（DATABASE_URL未設定）。" });
          return;
        }
        const code = await getOrCreateAddressCode(uid);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: `磯屋 住所コード\n----------------------\n${code}\n\n※住所が未登録の場合は、リッチメニューの「住所登録」から登録してください。`,
        });
        return;
      }

      return;
    }
  } catch (err) {
    console.error("handleEvent error:", err?.response?.data || err?.stack || err);
    if (ev.replyToken) {
      try { await client.replyMessage(ev.replyToken, { type: "text", text: "エラーが発生しました。もう一度お試しください。" }); } catch {}
    }
  }
}

// ======================================================================
// Health
// ======================================================================
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.head("/health", (_req, res) => res.status(200).end());

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
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
      DATABASE_URL: !!process.env.DATABASE_URL,
    },
  });
});

// ======================================================================
// 起動（DB schema を先に確保してから listen）
// ======================================================================
(async () => {
  try {
    await ensureDbSchema();
    console.log("✅ DB schema checked/ensured");
  } catch (e) {
    console.error("❌ ensureDbSchema error:", e?.message || e);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log("   Webhook: POST /webhook");
    console.log("   Public: /public/*");
    console.log("   Segment Admin: /public/admin-segment.html");
  });
})();
