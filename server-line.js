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
// - ★liff_open_logs（セグメント配信用）
//
// ================================================================

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
      ssl:
        process.env.NODE_ENV === "production"
          ? { rejectUnauthorized: false }
          : false,
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

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

const COD_FEE = Number(process.env.COD_FEE || 330);

// ★電話→オンライン hook（任意）
const PHONE_HOOK_TOKEN = (process.env.PHONE_HOOK_TOKEN || "").trim();
// ★ phone → online 別口通知受信（任意）
const ONLINE_NOTIFY_TOKEN = (process.env.ONLINE_NOTIFY_TOKEN || "").trim();
// ★ 住所取得公開APIを使うなら必須（超重要）
const PUBLIC_ADDRESS_LOOKUP_TOKEN = (process.env.PUBLIC_ADDRESS_LOOKUP_TOKEN || "").trim();

// LINE config
const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (
  !config.channelAccessToken ||
  !config.channelSecret ||
  !LIFF_ID ||
  (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)
) {
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
const stripeSecretKey = (
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET ||
  ""
).trim();

const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;
if (!stripe) {
  console.warn(
    "⚠️ STRIPE_SECRET_KEY / STRIPE_SECRET が設定されていません。/api/pay-stripe はエラーになります。"
  );
}

// ====== パス定義 ======
const DATA_DIR = path.join(__dirname, "data");

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json"); // (旧) 互換・参考用
const PHONE_ADDRESSES_PATH = path.join(DATA_DIR, "phone-addresses.json");
const SURVEYS_LOG = path.join(DATA_DIR, "surveys.log");
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
app.all("/public/confirm-card-success.html", (_req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, "confirm-card-success.html"));
});
app.all("/public/confirm-fail.html", (_req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, "confirm-fail.html"));
});
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
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; }
};

const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (data) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");

const readAddresses = () => safeReadJSON(ADDRESSES_PATH, {});
const writeAddresses = (data) => fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");

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
  return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
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
    if (!ADMIN_USER_ID) {
      return res.status(400).json({ ok: false, error: "ADMIN_USER_ID not set" });
    }
    await client.pushMessage(ADMIN_USER_ID, {
      type: "text",
      text: "✅ LINEサーバー疎通テストOK",
    });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.response?.data || e?.message || String(e),
    });
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

  // codes
  await p.query(`
    CREATE TABLE IF NOT EXISTS codes (
      user_id      TEXT PRIMARY KEY,
      member_code  CHAR(4) UNIQUE,
      address_code CHAR(4) UNIQUE
    );
  `);

  // addresses（member_code 主キー）
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

  // phone_address_events（任意ログ）
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

  // ★LIFF起動ログ（セグメント配信用）
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

  const r = await p.query(
    `SELECT user_id, member_code, address_code FROM codes WHERE user_id=$1 LIMIT 1`,
    [uid]
  );
  return r.rows[0] || null;
}

async function dbGetCodesByMemberCode(memberCode) {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) return null;

  const r = await p.query(
    `SELECT user_id, member_code, address_code FROM codes WHERE member_code=$1 LIMIT 1`,
    [mc]
  );
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
      await p.query(
        `INSERT INTO codes (user_id, member_code, address_code)
         VALUES ($1, $2, $3)`,
        [uid, mc, mc]
      );
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

// user_id 1件に対して member_code / address_code を必ず確保して返す
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

      await clientDb.query(
        `INSERT INTO codes (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [uid]
      );

      const current = await clientDb.query(
        `SELECT member_code, address_code FROM codes WHERE user_id = $1 FOR UPDATE`,
        [uid]
      );
      const row = current.rows[0] || {};

      const nextMember  = row.member_code  ? row.member_code : mc;
      const nextAddress = row.address_code ? row.address_code : ac;

      await clientDb.query(
        `UPDATE codes
         SET member_code = $2, address_code = $3
         WHERE user_id = $1`,
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

// user_id から住所を取る（codes.member_code -> addresses）
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

  const hasAny =
    (row.name || row.phone || row.postal || row.prefecture || row.city || row.address1 || row.address2);
  if (!hasAny) return null;

  return row;
}

// user_id で住所を upsert（内部で member_code を確保して addresses に保存）
async function dbUpsertAddressByUserId(userId, addr = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const codes = await dbEnsureCodes(uid);
  const memberCode = String(codes.member_code || "").trim();
  if (!/^\d{4}$/.test(memberCode)) throw new Error("member_code missing");

  const a = {
    name:       String(addr.name || "").trim(),
    phone:      String(addr.phone || "").trim(),
    postal:     String(addr.postal || "").trim(),
    prefecture: String(addr.prefecture || "").trim(),
    city:       String(addr.city || "").trim(),
    address1:   String(addr.address1 || "").trim(),
    address2:   String(addr.address2 || "").trim(),
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

// member_code から住所を取る
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

// ★電話住所を memberCode で addresses(DB) に反映
async function dbUpsertAddressByMemberCode(memberCode, addr = {}) {
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) throw new Error("invalid_memberCode");

  const codes = await dbGetCodesByMemberCode(mc);
  if (!codes?.user_id) {
    return { ok: false, reason: "memberCode_not_found" };
  }

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
    fs.appendFileSync(
      STOCK_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8"
    );
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
      `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n` +
      `残り：${stockNow}個\nしきい値：${LOW_STOCK_THRESHOLD}個`;
    try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
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

// =============================================================
// ★送料計算 一本化（ここが中核）
// =============================================================
function isAkasha6(item) {
  const name = String(item?.name || "");
  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}
function sizeFromAkasha6Qty(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  if (q <= 4)  return "60";   // 1〜4
  if (q <= 8)  return "80";   // 5〜8
  if (q <= 13) return "100";  // 9〜13
  if (q <= 18) return "120";  // 14〜18
  return "140";               // 19以上（安全側）
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
function maxSize(a, b) {
  if (!a) return b;
  if (!b) return a;
  return SIZE_ORDER.indexOf(a) >= SIZE_ORDER.indexOf(b) ? a : b;
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
    return s + (
      it.id === ORIGINAL_SET_PRODUCT_ID ||
      /磯屋.?オリジナルセ/.test(it.name || "")
        ? Number(it.qty || 0)
        : 0
    );
  }, 0);

  let size;
  if (akasha6Qty > 0) {
    size = sizeFromAkasha6Qty(akasha6Qty);
  } else if (originalQty > 0) {
    size = sizeFromOriginalSetQty(originalQty);
  } else {
    size = sizeFromTotalQty(totalQty);
  }

  const shipping = calcYamatoShipping(region, size);
  return { region, size, shipping };
}

// ====== フロント表示用：送料設定を返す（server-line と完全一致） ======
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

// ====== ミニアプリ用：送料計算 API ======
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    const { region, size, shipping } = calcShippingUnified(items, address);
    const finalTotal = itemsTotal + shipping;

    res.json({
      ok: true,
      itemsTotal,
      region,
      size,
      shipping,
      finalTotal,
    });
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
    (process.env.RENDER_EXTERNAL_URL || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

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

    // ついでに codes を確保（後で便利）
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

    res.json({
      ok: true,
      memberCode: String(codes.member_code || ""),
      addressCode: String(codes.address_code || ""),
      saved: true,
    });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
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
    res.json({ ok: false, address: null });
  }
});

// ★修正版：二重定義を解消（この1本だけ）
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();

  if (kind === "shop") {
    if (!LIFF_ID_SHOP) return res.status(500).json({ ok: false, error: "LIFF_ID_SHOP_not_set" });
    return res.json({ ok: true, liffId: LIFF_ID_SHOP });
  }
  if (kind === "cod") {
    return res.json({ ok: true, liffId: LIFF_ID_DIRECT_ADDRESS || LIFF_ID });
  }
  // order / default
  return res.json({ ok: true, liffId: LIFF_ID });
});

// ★危険：公開住所取得API（トークン必須）
app.get("/api/public/address-by-code", async (req, res) => {
  try {
    const token = String(req.query.token || req.headers["x-public-token"] || "").trim();
    if (!PUBLIC_ADDRESS_LOOKUP_TOKEN) {
      return res.status(500).json({ ok: false, error: "PUBLIC_ADDRESS_LOOKUP_TOKEN_not_set" });
    }
    if (token !== PUBLIC_ADDRESS_LOOKUP_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const code = String(req.query.code || "").trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: "code_required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const addr = await dbGetAddressByMemberCode(code);
    if (!addr) return res.status(404).json({ ok: false, error: "address_not_registered" });

    const r = await mustPool().query(
      `SELECT user_id, member_code, address_code FROM codes WHERE member_code=$1 LIMIT 1`,
      [code]
    );
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
// phone → online 通知 受信（別口：ONLINE_NOTIFY）
// ======================================================================
app.post("/api/phone/address-registered", async (req, res) => {
  try {
    const got = req.headers["x-hook-token"]; // ヘッダは小文字
    const env = (process.env.ONLINE_NOTIFY_TOKEN || "").trim();

    if (env && String(got || "").trim() !== env) {
      return res.status(401).json({ ok: false, error: "invalid token" });
    }
    if (!pool) {
      return res.status(500).json({ ok: false, error: "db_not_configured" });
    }

    const body = req.body || {};
    const event = body.event || "address_registered";
    const payload = body.payload || body;

    if (event !== "address_registered") {
      return res.json({ ok: true, ignored: true, event });
    }

    const memberCode = String(payload.memberCode || "").trim();
    const a = payload.address || {};
    const isNew = payload.isNew === true;

    if (!/^\d{4}$/.test(memberCode)) {
      return res.status(400).json({ ok: false, error: "invalid_memberCode" });
    }

    const addr = {
      name: String(a.name || "").trim(),
      phone: String(a.phone || "").trim(),
      postal: String(a.postal || "").trim(),
      prefecture: String(a.prefecture || "").trim(),
      city: String(a.city || "").trim(),
      address1: String(a.address1 || "").trim(),
      address2: String(a.address2 || "").trim(),
    };

    const phoneE164 = addr.phone;
    await dbEnsurePhoneCodesByMemberCode(memberCode, phoneE164);

    const reflect = await dbUpsertAddressByMemberCode(memberCode, addr);
    if (!reflect?.ok) {
      return res.status(400).json({ ok: false, error: "reflect_failed", detail: reflect });
    }

    try {
      await mustPool().query(
        `INSERT INTO phone_address_events
          (member_code, is_new, name, phone, postal, prefecture, city, address1, address2)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [memberCode, !!isNew, addr.name, addr.phone, addr.postal, addr.prefecture, addr.city, addr.address1, addr.address2]
      );
    } catch (e) {
      console.warn("phone_address_events insert skipped:", e?.message || e);
    }

    return res.json({ ok: true, memberCode, userId: reflect.userId });
  } catch (e) {
    console.error("phone notify error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// ======================================================================
// /api/phone/hook（電話サーバーからの通知受け口）
// ======================================================================
app.post("/api/phone/hook", async (req, res) => {
  try {
    if (PHONE_HOOK_TOKEN) {
      const token = (req.headers["x-hook-token"] || "").toString().trim();
      if (token !== PHONE_HOOK_TOKEN) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    const { event, ts, payload } = req.body || {};
    if (!event) return res.status(400).json({ ok: false, error: "missing_event" });

    if (event === "address_registered") {
      const memberCode = String(payload?.memberCode || "").trim();
      const a = payload?.address || {};

      // 1) JSONに保存（バックアップ用途）
      if (/^\d{4}$/.test(memberCode)) {
        const book = readPhoneAddresses();
        book[memberCode] = {
          memberCode,
          name: String(a.name || "").trim(),
          phone: String(a.phone || "").trim(),
          postal: String(a.postal || "").trim(),
          prefecture: String(a.prefecture || "").trim(),
          city: String(a.city || "").trim(),
          address1: String(a.address1 || "").trim(),
          address2: String(a.address2 || "").trim(),
          ts: ts || new Date().toISOString(),
          source: "phone",
        };
        writePhoneAddresses(book);
      }

      // 2) DBへ反映
      let dbResult = null;
      if (pool && /^\d{4}$/.test(memberCode)) {
        try {
          const phoneE164 = String(a.phone || "").trim();
          await dbEnsurePhoneCodesByMemberCode(memberCode, phoneE164);

          dbResult = await dbUpsertAddressByMemberCode(memberCode, {
            name: String(a.name || "").trim(),
            phone: String(a.phone || "").trim(),
            postal: String(a.postal || "").trim(),
            prefecture: String(a.prefecture || "").trim(),
            city: String(a.city || "").trim(),
            address1: String(a.address1 || "").trim(),
            address2: String(a.address2 || "").trim(),
          });
        } catch (e) {
          console.error("phone hook db reflect error:", e);
          dbResult = { ok: false, reason: "db_error", error: e?.message || String(e) };
        }
      }

      const addrText =
        `${a.postal || ""} ${a.prefecture || ""}${a.city || ""}${a.address1 || ""}` +
        (a.address2 ? ` ${a.address2}` : "");

      if (ADMIN_USER_ID) {
        const statusLine =
          !pool ? "DB：未設定（DATABASE_URLなし）"
          : !/^\d{4}$/.test(memberCode) ? "DB：memberCode不正"
          : dbResult?.ok ? `DB：addresses反映OK（userId=${dbResult.userId}）`
          : `DB：反映NG（${dbResult?.reason || "unknown"}）`;

        const msg =
          "🔔【電話→オンライン 住所登録】\n" +
          `会員コード：${memberCode || "(不明)"}\n` +
          `氏名：${a.name || ""}\n` +
          `電話：${a.phone || ""}\n` +
          `住所：${addrText}\n` +
          `${statusLine}`;

        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
      }

      return res.json({ ok: true, handled: event, db: dbResult || null });
    }

    if (event === "order_created") {
      const type = payload?.type || "";
      const o = payload?.order || {};
      if (ADMIN_USER_ID) {
        const msg =
          "🔔【電話→オンライン 注文通知】\n" +
          `種別：${type}\n` +
          `会員コード：${o.memberCode || ""}\n` +
          `お名前：${o.customerName || ""}\n` +
          `商品：${o.productName || ""}\n` +
          `数量：${o.qty || ""}\n` +
          `合計：${(o.total ?? "").toString()}円`;
        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
      }
      return res.json({ ok: true, handled: event });
    }

    return res.json({ ok: true, handled: "ignored", event });
  } catch (e) {
    console.error("/api/phone/hook error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
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
    const codFee   = Number(order.codFee || 0);

    const line_items = [];
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty  = Number(it.qty)   || 0;
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
    const host  = req.headers.host;
    const base =
      (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") ||
      `${proto}://${host}`;

    const successUrl = `${base}/public/confirm-card-success.html`;
    const cancelUrl  = `${base}/public/confirm-fail.html`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        lineUserId:   order.lineUserId   || "",
        lineUserName: order.lineUserName || "",
      },
    });

    return res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("[pay-stripe] error:", e?.raw || e);
    return res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

// Stripe 決済完了通知（管理者 & 購入者）
app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (items.length === 0) return res.json({ ok: false, error: "no_items" });

    const itemsText = items
      .map((it) => `・${it.name} x ${it.qty} = ${yen((it.price || 0) * (it.qty || 0))}`)
      .join("\n");

    const itemsTotal = Number(order.itemsTotal ?? order.total ?? 0);
    const shipping = Number(order.shipping ?? 0);
    const codFee = Number(order.codFee ?? 0);
    const finalTotal = Number(order.finalTotal ?? order.total ?? 0);

    let addrText = "住所：未登録";
    if (order.address) {
      const a = order.address;
      addrText =
        `住所：${a.zip || a.postal || ""} ` +
        `${a.prefecture || a.pref || ""}${a.city || ""}${a.addr1 || a.address1 || ""}` +
        `${a.addr2 || a.address2 ? " " + (a.addr2 || a.address2) : ""}\n` +
        `氏名：${(a.lastName || "")}${(a.firstName || "") || a.name || ""}\n` +
        `TEL：${a.tel || a.phone || ""}`;
    }

    try {
      const log = { ts: new Date().toISOString(), ...order, source: "liff-stripe" };
      fs.appendFileSync(ORDERS_LOG, JSON.stringify(log) + "\n", "utf8");
    } catch (e) {
      console.error("orders.log write error:", e);
    }

    const adminMsg =
      `🧾【Stripe決済 新規注文】\n` +
      (order.lineUserId ? `ユーザーID：${order.lineUserId}\n` : "") +
      (order.orderNumber ? `注文番号：${order.orderNumber}\n` : "") +
      `\n【内容】\n${itemsText}\n` +
      `\n商品合計：${yen(itemsTotal)}\n` +
      `送料：${yen(shipping)}\n` +
      (codFee ? `代引き手数料：${yen(codFee)}\n` : "") +
      `合計：${yen(finalTotal)}\n` +
      `\n${addrText}`;

    try {
      if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
      if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminMsg });
    } catch (e) {
      console.error("admin push error:", e?.response?.data || e);
    }

    try {
      if (order.lineUserId) {
        const userMsg =
          "ご注文ありがとうございます！\n\n" +
          "【ご注文内容】\n" +
          itemsText +
          "\n\n" +
          `商品合計：${yen(itemsTotal)}\n` +
          `送料：${yen(shipping)}\n` +
          (codFee ? `代引き手数料：${yen(codFee)}\n` : "") +
          `合計：${yen(finalTotal)}\n\n` +
          addrText;

        await client.pushMessage(order.lineUserId, { type: "text", text: userMsg });
      }
    } catch (e) {
      console.error("user receipt push error:", e?.response?.data || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ======================================================================
// Flexメッセージ（商品一覧）
// ======================================================================
function productsFlex(allProducts) {
  const products = (allProducts || []).filter((p) => !HIDE_PRODUCT_IDS.has(p.id));

  const bubbles = products.map((p) => {
    const imgUrl = toPublicImageUrl(p.image);
    return {
      type: "bubble",
      hero: imgUrl
        ? { type: "image", url: imgUrl, size: "full", aspectRatio: "1:1", aspectMode: "cover" }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: "sm", wrap: true },
          p.volume ? { type: "text", text: `内容量：${p.volume}`, size: "sm", wrap: true } : null,
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true } : null,
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "数量を選ぶ", data: `order_qty?${qstr({ id: p.id, qty: 1 })}` },
          },
        ],
      },
    };
  });

  // その他（自由入力）
  bubbles.push({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        { type: "text", text: "商品名と個数だけ入力します。価格入力は不要です。", size: "sm", wrap: true },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        { type: "button", style: "primary", action: { type: "postback", label: "商品名を入力する", data: "other_start" } },
        { type: "button", style: "secondary", action: { type: "postback", label: "← 戻る", data: "order_back" } },
      ],
    },
  });

  return {
    type: "flex",
    altText: "商品一覧",
    contents:
      bubbles.length === 1
        ? bubbles[0]
        : { type: "carousel", contents: bubbles },
  };
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
          { type: "button", style: "primary", action: { type: "postback", label: "店頭での受取名前を入力", data: `order_pickup_name?${qstr({ id, qty: q })}` } },
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
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "受取方法", weight: "bold", size: "lg" },
          { type: "text", text: "宅配 または 店頭受取 を選択してください。", wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "postback", label: "宅配（送料あり）", data: `order_payment?${qstr({ id, qty, method: "delivery" })}` },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "postback", label: "店頭受取（送料0円）", data: `order_payment?${qstr({ id, qty, method: "pickup" })}` },
          },
        ],
      },
    },
  };
}

function paymentFlex(id, qty, method) {
  if (method === "pickup") {
    return {
      type: "flex",
      altText: "お支払い（店頭）",
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
            { type: "button", style: "primary", action: { type: "postback", label: "現金で支払う（店頭）", data: `order_confirm_view?${qstr({ id, qty, method: "pickup", payment: "cash" })}` } },
            { type: "button", style: "secondary", action: { type: "postback", label: "← 受取方法へ戻る", data: `order_method?${qstr({ id, qty })}` } },
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
          { type: "text", text: `送料は登録住所から自動計算します。`, wrap: true },
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

function confirmFlex(product, qty, method, payment, liffIdForBtn, options = {}) {
  const pickupName = (options.pickupName || "").trim();
  const address = options.address || null;

  if (typeof product?.id === "string" && product.id.startsWith("other:")) {
    const parts = product.id.split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    product = { ...product, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0) };
  }

  const subtotal = Number(product.price) * Number(qty);

  let region = "";
  let size = "";
  let shipping = 0;
  let addressOk = true;

  if (method === "delivery") {
    if (!address) addressOk = false;
    else {
      const items = [{ id: product.id, name: product.name, qty }];
      const r = calcShippingUnified(items, address);
      region = r.region;
      size = r.size;
      shipping = r.shipping;
      if (!region) addressOk = false;
    }
  }

  const codFee = payment === "cod" ? COD_FEE : 0;
  const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

  const payText =
    payment === "cod" ? `代金引換（+${yen(COD_FEE)}）`
    : payment === "bank" ? "銀行振込"
    : "現金（店頭）";

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
    lines.push(`送料：0円`);
  }

  lines.push(`代引き手数料：${yen(codFee)}`);
  lines.push(`合計：${yen(total)}`);
  if (method === "pickup" && pickupName) lines.push(`お名前：${pickupName}`);

  const imgUrl = toPublicImageUrl(product.image);

  const footerButtons = [];
  if (method === "delivery" && !addressOk) {
    footerButtons.push({
      type: "button",
      style: "primary",
      action: {
        type: "uri",
        label: "住所を入力（LIFF）",
        uri: `https://liff.line.me/${liffIdForBtn}?${qstr({ from: "address", need: "shipping" })}`,
      },
    });
    footerButtons.push({
      type: "button",
      style: "secondary",
      action: { type: "postback", label: "← 商品一覧へ", data: "order_back" },
    });
  } else {
    footerButtons.push({
      type: "button",
      style: "secondary",
      action: { type: "postback", label: "← 商品一覧へ", data: "order_back" },
    });
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method, payment, pickupName })}` },
    });
  }

  return {
    type: "flex",
    altText: "注文内容の最終確認",
    contents: {
      type: "bubble",
      hero: imgUrl ? { type: "image", url: imgUrl, size: "full", aspectRatio: "1:1", aspectMode: "cover" } : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "最終確認", weight: "bold", size: "lg" },
          ...lines.map((t) => ({ type: "text", text: t, wrap: true })),
          method === "delivery"
            ? { type: "text", text: "※ 送料は登録住所から自動計算します。", size: "sm", wrap: true }
            : null,
        ].filter(Boolean),
      },
      footer: { type: "box", layout: "vertical", spacing: "md", contents: footerButtons },
    },
  };
}

function reserveOffer(product, needQty, stock) {
  return [
    {
      type: "text",
      text: [
        "申し訳ありません。在庫が不足しています。",
        `商品：${product.name}`,
        `希望数量：${needQty}個 / 現在在庫：${stock}個`,
        "",
        "予約しますか？ 入荷次第ご案内します。",
      ].join("\n"),
    },
    {
      type: "template",
      altText: "在庫不足：予約しますか？",
      template: {
        type: "confirm",
        text: "予約しますか？",
        actions: [
          { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: product.id, qty: needQty })}` },
          { type: "postback", label: "やめる", data: "order_cancel" },
        ],
      },
    },
  ];
}

// ======================================================================
// 管理API（最小） + ★セグメント配信API
// ======================================================================
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, ping: "pong" }); });

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

app.get("/api/admin/orders/shipped", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const state = readNotifyState();
    const shipped = state.shippedOrders || {};
    res.json({ ok: true, shipped });
  } catch (e) {
    console.error("/api/admin/orders/shipped error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/orders/mark-shipped", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const orderKey = String(req.body?.orderKey || "").trim();
    if (!orderKey) return res.status(400).json({ ok: false, error: "orderKey required" });

    const state = readNotifyState();
    if (!state.shippedOrders) state.shippedOrders = {};
    state.shippedOrders[orderKey] = {
      ts: new Date().toISOString(),
      userId: String(req.body?.userId || "").trim(),
      productName: String(req.body?.productName || "").trim(),
      orderNumber: String(req.body?.orderNumber || "").trim(),
    };
    writeNotifyState(state);
    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/admin/orders/mark-shipped error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/orders/notify-shipped", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userId      = String(req.body?.userId || "").trim();
    const orderNumber = String(req.body?.orderNumber || "").trim();
    const productName = String(req.body?.productName || "").trim();
    const message     = String(req.body?.message || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    const baseMsg = message || [
      "ご注文いただいた商品を発送いたしました。",
      productName ? `商品：${productName}` : "",
      orderNumber ? `注文番号：${orderNumber}` : "",
      "",
      "お受け取りまで今しばらくお待ちください。"
    ].filter(Boolean).join("\n");

    await client.pushMessage(userId, { type: "text", text: baseMsg });
    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/admin/orders/notify-shipped error:", e?.response?.data || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/admin/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(RESERVATIONS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, (x) => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});

// ★管理：住所（DB版）
app.get("/api/admin/addresses", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.json({ ok: true, items: [] });

    const limit = Math.min(2000, Number(req.query.limit || 500));
    const r = await mustPool().query(
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
      ORDER BY a.updated_at DESC NULLS LAST, c.user_id ASC
      LIMIT $1
      `,
      [limit]
    );

    res.json({ ok: true, items: r.rows || [] });
  } catch (e) {
    console.error("/api/admin/addresses error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 参考：電話住所（JSONバックアップ）
app.get("/api/admin/phone-addresses", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, items: readPhoneAddresses() }); });

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

app.get("/api/admin/connection-test", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, uploads: true, uploadDir: "/public/uploads" });
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
});

// ======================================================================
// ★管理：LIFF起動セグメント対象 userId 取得
// 例) /api/admin/segment/liff-open?kind=order&days=30&token=XXXX
// ======================================================================
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

    return res.json({ ok: true, kind, days, count: r.rows.length, items: r.rows.map(x => x.user_id) });
  } catch (e) {
    console.error("/api/admin/segment/liff-open error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// ======================================================================
// ★管理：LIFF起動者セグメントへ一括Push（自前セグメント配信）
// POST /api/admin/push/segment?token=XXXX
// body: { kind:"order", days:30, message:{type:"text",text:"..."} }
// ======================================================================
app.post("/api/admin/push/segment", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const kind = String(req.body?.kind || "order").trim().slice(0, 32);
    const days = Math.min(365, Math.max(1, Number(req.body?.days || 30)));
    const message = req.body?.message;

    if (!message || !message.type) {
      return res.status(400).json({ ok: false, error: "message required" });
    }

    const r = await mustPool().query(
      `
      SELECT DISTINCT user_id
      FROM liff_open_logs
      WHERE kind = $1
        AND opened_at >= NOW() - ($2 || ' days')::interval
      `,
      [kind, String(days)]
    );

    const ids = r.rows.map(x => x.user_id).filter(Boolean);

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

    return res.json({ ok: true, kind, days, target: ids.length, pushed: okCount, failed: ngCount });
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
    const detail =
      err?.originalError?.response?.data ||
      err?.response?.data ||
      err?.stack ||
      err;
    console.error("Webhook Error detail:", JSON.stringify(detail, null, 2));
    res.status(500).end();
  }
});

// ======================================================================
// イベント処理
// ======================================================================
async function handleEvent(ev) {
  try {
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        fs.appendFileSync(
          MESSAGES_LOG,
          JSON.stringify({ ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "text", len: (ev.message.text || "").length }) + "\n",
          "utf8"
        );
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

      const isAdmin = ADMIN_USER_ID && uid === ADMIN_USER_ID;
      if (!isAdmin && ADMIN_USER_ID && t) {
        const notice =
          "📩【お客さまからのメッセージ】\n" +
          `ユーザーID：${uid}\n` +
          `メッセージ：${t}`;
        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: notice }); } catch {}
      }

      if (t === "問い合わせ") {
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "お問い合わせありがとうございます。\nこのままトークにご質問内容を送ってください。\nスタッフが確認して返信します。",
        });
        return;
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
          text:
            `磯屋 会員コード\n----------------------\n${code}\n\n` +
            `※住所が未登録の場合は、リッチメニューの「住所登録」から登録してください。`,
        });
        return;
      }

      if (t === "住所コード" || t === "住所番号") {
        if (!pool) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "現在DBが未設定のため住所コードを発行できません（DATABASE_URL未設定）。" });
          return;
        }
        const code = await getOrCreateAddressCode(uid);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text:
            `磯屋 住所コード\n----------------------\n${code}\n\n` +
            `※住所が未登録の場合は、リッチメニューの「住所登録」から登録してください。`,
        });
        return;
      }

      // 久助テキスト購入
      const kusukeRe = /^久助(?:\s+(\d+))?$/i;
      const km = kusukeRe.exec(text);
      if (km) {
        const qtyStr = km[1];
        if (!qtyStr) {
          sessions[uid] = { await: "kusukeQty" };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type: "text", text: "久助の個数を半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(qtyStr)));
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }

      if (sess?.await === "kusukeQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        delete sessions[uid];
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }

      // その他フロー
      if (sess?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください。" });
          return;
        }
        sessions[uid] = { await: "otherQty", temp: { name } };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type: "text", text: `「${name}」ですね。個数を半角数字で入力してください。例：2` });
        return;
      }

      if (sess?.await === "otherQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "個数は半角数字で入力してください。例：2" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        const name = sess.temp?.name || "その他";
        delete sessions[uid];
        writeSessions(sessions);
        const id = `other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      // 店頭受取：名前入力
      if (sess?.await === "pickupName") {
        const nameText = (text || "").trim();
        if (!nameText) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "お名前が空です。注文者のお名前を入力してください。" });
          return;
        }

        const temp = sess.temp || {};
        const id = temp.id;
        const qty = Math.max(1, Math.min(99, Number(temp.qty) || 1));

        delete sessions[uid];
        writeSessions(sessions);

        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0) };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
        }

        if (!product) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。もう一度最初からお試しください。" });
          return;
        }

        await client.replyMessage(ev.replyToken, confirmFlex(product, qty, "pickup", "cash", LIFF_ID_DIRECT_ADDRESS, { pickupName: nameText }));
        return;
      }

      if (text === "直接注文") {
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }

      return;
    }

    if (ev.type === "postback") {
      const d = ev.postback?.data || "";

      if (d === "other_start") {
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await: "otherName" };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type: "text", text: "その他の商品名を入力してください。" });
        return;
      }

      if (d.startsWith("order_qty?")) {
        const { id, qty } = parse(d.replace("order_qty?", ""));
        await client.replyMessage(ev.replyToken, qtyFlex(id, qty));
        return;
      }

      if (d.startsWith("order_pickup_name?")) {
        const { id, qty } = parse(d.replace("order_pickup_name?", ""));
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await: "pickupName", temp: { id, qty } };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type: "text", text: "注文者の氏名を入力してください。\n例：磯屋 太郎" });
        return;
      }

      if (d.startsWith("order_method?")) {
        const { id, qty } = parse(d.replace("order_method?", ""));
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      if (d.startsWith("order_payment?")) {
        const { id, qty, method } = parse(d.replace("order_payment?", ""));
        await client.replyMessage(ev.replyToken, paymentFlex(id, qty, (method || "").trim()));
        return;
      }

      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, payment } = parse(d.replace("order_confirm_view?", ""));

        const uid = ev.source?.userId || "";

        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
          if (!product) {
            await client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
            return;
          }
        }

        let addr = null;
        if (pool) {
          const row = await dbGetAddressByUserId(uid);
          addr = row ? {
            name: row.name || "",
            phone: row.phone || "",
            postal: row.postal || "",
            prefecture: row.prefecture || "",
            city: row.city || "",
            address1: row.address1 || "",
            address2: row.address2 || "",
          } : null;
        }

        await client.replyMessage(
          ev.replyToken,
          confirmFlex(product, qty, (method || "").trim(), (payment || "").trim(), LIFF_ID_DIRECT_ADDRESS, { address: addr })
        );
        return;
      }

      if (d === "order_back") {
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }

      if (d.startsWith("order_confirm?")) {
        const parsed = parse(d.replace("order_confirm?", ""));
        const id = parsed.id;
        const need = Math.max(1, Number(parsed.qty) || 1);
        const method = (parsed.method || "").trim();
        const payment = (parsed.payment || "").trim();
        const pickupName = (parsed.pickupName || "").trim();

        let product = null;
        let products = readProducts();
        let idx = products.findIndex((p) => p.id === id);

        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
          idx = -1;
        } else {
          if (idx === -1) {
            await client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
            return;
          }
          product = products[idx];
          if (!product.stock || product.stock < need) {
            await client.replyMessage(ev.replyToken, reserveOffer(product, need, product.stock || 0));
            return;
          }
        }

        const uid = ev.source?.userId || "";

        let addr = null;
        if (pool) {
          const row = await dbGetAddressByUserId(uid);
          addr = row ? {
            name: row.name || "",
            phone: row.phone || "",
            postal: row.postal || "",
            prefecture: row.prefecture || "",
            city: row.city || "",
            address1: row.address1 || "",
            address2: row.address2 || "",
          } : null;
        }

        let region = "";
        let size = "";
        let shipping = 0;

        if (method === "delivery") {
          if (!addr) {
            await client.replyMessage(ev.replyToken, { type: "text", text: "住所が未登録のため確定できません。リッチメニューの住所登録から登録してください。" });
            return;
          }
          const items = [{ id: product.id, name: product.name, qty: need }];
          const r = calcShippingUnified(items, addr);
          region = r.region;
          size = r.size;
          shipping = r.shipping;

          if (!region) {
            await client.replyMessage(ev.replyToken, { type: "text", text: "都道府県が判定できず送料計算ができません。住所情報（都道府県）を確認して登録し直してください。" });
            return;
          }
        }

        if (idx >= 0) {
          products[idx].stock = Number(product.stock) - need;
          writeProducts(products);
          await maybeLowStockAlert(product.id, product.name, products[idx].stock);
        }

        const subtotal = Number(product.price) * need;
        const codFee = payment === "cod" ? COD_FEE : 0;
        const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

        const order = {
          ts: new Date().toISOString(),
          userId: uid,
          productId: product.id,
          productName: product.name,
          qty: need,
          price: Number(product.price),
          subtotal,
          method,
          payment,
          region,
          size,
          shipping,
          codFee,
          total,
          address: addr,
          image: product.image || "",
          pickupName,
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order) + "\n", "utf8");

        const payText =
          payment === "cod" ? `代金引換（+${yen(COD_FEE)}）`
          : payment === "bank" ? "銀行振込"
          : "現金（店頭）";

        const userLines = [
          "ご注文ありがとうございます！",
          `受取方法：${method === "pickup" ? "店頭受取（送料0円）" : "宅配"}`,
          `支払い：${payText}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)}`,
        ];

        if (method === "delivery") {
          userLines.push(`配送地域：${region}`);
          userLines.push(`サイズ：${size}`);
          userLines.push(`送料：${yen(shipping)}`);
        } else {
          userLines.push(`送料：0円`);
        }

        userLines.push(`代引き手数料：${yen(codFee)}`);
        userLines.push(`合計：${yen(total)}`);
        if (method === "pickup" && pickupName) userLines.push("", `お名前：${pickupName}`);

        if (method === "delivery") {
          userLines.push("");
          userLines.push(
            addr
              ? `お届け先：${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name || ""}\n電話：${addr.phone || ""}`
              : "住所未登録です。メニューの住所登録から登録してください。"
          );
        } else {
          userLines.push("", "店頭でのお受け取りをお待ちしています。");
        }

        if (payment === "bank" && (BANK_INFO || BANK_NOTE)) {
          userLines.push("");
          if (BANK_INFO) userLines.push("【銀行振込先】", BANK_INFO);
          if (BANK_NOTE) userLines.push("", BANK_NOTE);
        }

        await client.replyMessage(ev.replyToken, { type: "text", text: userLines.join("\n") });

        const adminMsg = [
          "🧾 新規注文",
          `ユーザーID：${uid}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)} / 送料：${yen(method === "delivery" ? shipping : 0)} / 代引：${yen(codFee)} / 合計：${yen(total)}`,
          method === "delivery" ? `配送：${region} / サイズ：${size}` : "受取：店頭",
          `支払：${payment}`,
          pickupName ? `店頭お呼び出し名：${pickupName}` : "",
          addr
            ? `住所：${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name || ""} / TEL：${addr.phone || ""}`
            : method === "delivery" ? "住所：未登録" : "",
        ].filter(Boolean).join("\n");

        try {
          if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
          if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminMsg });
        } catch {}

        return;
      }

      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parse(d.replace("order_reserve?", ""));
        const products = readProducts();
        const product = products.find((p) => p.id === id);
        if (!product) {
          await client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
          return;
        }

        const r = {
          ts: new Date().toISOString(),
          userId: ev.source?.userId || "",
          productId: product.id,
          productName: product.name,
          qty: Math.max(1, Number(qty) || 1),
          status: "reserved",
        };
        fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r) + "\n", "utf8");

        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: ["予約を受け付けました。入荷次第ご案内します。", `商品：${product.name}`, `数量：${r.qty}個`].join("\n"),
        });

        try {
          const adminReserve = ["📝 予約受付", `ユーザーID：${ev.source?.userId || ""}`, `商品：${product.name}`, `数量：${r.qty}個`].join("\n");
          if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminReserve });
          if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminReserve });
        } catch {}
        return;
      }
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
      LIFF_ID_DIRECT_ADDRESS: !!process.env.LIFF_ID_DIRECT_ADDRESS,
      LIFF_ID_SHOP: !!process.env.LIFF_ID_SHOP,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
      BANK_INFO: !!BANK_INFO,
      BANK_NOTE: !!BANK_NOTE,
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      ORIGINAL_SET_PRODUCT_ID: !!process.env.ORIGINAL_SET_PRODUCT_ID,
      COD_FEE: COD_FEE,
      PHONE_HOOK_TOKEN: !!PHONE_HOOK_TOKEN,
      ONLINE_NOTIFY_TOKEN: !!ONLINE_NOTIFY_TOKEN,
      DATABASE_URL: !!process.env.DATABASE_URL,
      PUBLIC_ADDRESS_LOOKUP_TOKEN: !!PUBLIC_ADDRESS_LOOKUP_TOKEN,
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
    // DB必須運用なら止める（必要ならON）
    // process.exit(1);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server started on port ${PORT}`);
    console.log("   Webhook: POST /webhook");
    console.log("   Public: /public/*");
    console.log("   Phone hook: POST /api/phone/hook");
    console.log("   Ping: GET /api/line/ping");
  });
})();
