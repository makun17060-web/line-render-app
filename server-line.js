/**
 * server.js — 真の全部入り “完全・全部入り” 丸ごと版
 *  (LINE Bot + LIFFミニアプリ + 画像管理(Disk永続) + products.json(Disk永続) +
 *   住所DB(Postgres) + セグメント配信 + 注文DB永続化 + Stripe決済 + 送料計算統一)
 *
 * =========================
 * ✅ Render Disk 永続化（超重要）
 * - DATA_DIR=/var/data（デフォルト）
 *   - products.json / sessions.json / logs / etc...
 * - UPLOAD_DIR=/var/data/uploads（デフォルト）
 *   - 画像アップロード永続
 * - 静的配信（Cannot GET 対策）
 *   - /public/uploads/*  → UPLOAD_DIR を直接配信
 *
 * =========================
 * ✅ 重要仕様（あなたの要望）
 * - 「久助」も products.json に従う（価格固定ロジック撤廃）
 * - 久助の送料サイズ判定＝ “あかしゃシリーズ扱い” に含める
 * - 起動キーワードは「直接注文」「久助」だけ（それ以外は無反応）
 *   - ただし“セッション中”の入力は受け付ける
 *
 * =========================
 * ✅ 送料（例：オリジナルセット）
 * - 1個=80 / 2個=100 / 3-4個=120 / 5-6個=140
 *
 * =========================
 * ✅ 必須 ENV
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - DATABASE_URL（Postgres）
 *
 * ✅ Stripe 利用するなら
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET（Webhook受けるなら）
 * - PUBLIC_BASE_URL（例 https://xxxx.onrender.com）
 *
 * ✅ 任意
 * - ADMIN_TOKEN（管理API保護）
 * - LIFF_CHANNEL_ID（id_token verify をやるなら）
 * - LIFF_BASE_URL（FlexのURLに使う：PUBLIC_BASE_URL と同じでOK）
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const line = require("@line/bot-sdk");
const { Pool } = require("pg");

// Stripeは環境変数がある時だけ require（無い環境で落ちないように）
let Stripe = null;
try { Stripe = require("stripe"); } catch {}

// =========================
// 基本ENV
// =========================
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  DATABASE_URL,

  PUBLIC_BASE_URL,        // 例: https://xxxxx.onrender.com
  LIFF_BASE_URL,          // 例: https://xxxxx.onrender.com  (未設定なら PUBLIC_BASE_URL を使う)
  LIFF_CHANNEL_ID,        // id_token verify に使う（任意）

  DATA_DIR = "/var/data",
  UPLOAD_DIR = "/var/data/uploads",

  ADMIN_API_TOKEN = "",

  STRIPE_SECRET_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",

  // Stripeのリダイレクト先（未設定なら PUBLIC_BASE_URL ベースで作る）
  STRIPE_SUCCESS_URL = "",
  STRIPE_CANCEL_URL = "",

  // 代引き手数料（ミニアプリ側の“代引合計”に使う等）
  COD_FEE = "330",

  // LINEの“起動キーワード”
  KEYWORD_DIRECT = "直接注文",
  KEYWORD_KUSUKE = "久助",

  // “オリジナルセット”商品ID（products.json に入れてそれを使う）
  ORIGINAL_SET_PRODUCT_ID = "original-set-2000",

} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const BASE_URL = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
const LIFF_BASE = (LIFF_BASE_URL || BASE_URL || "").replace(/\/$/, "");

if (!BASE_URL) {
  console.warn("[WARN] PUBLIC_BASE_URL が未設定です。Stripe/LIFF URL 生成で困る場合があります。");
}

// =========================
// パス設定（Disk永続）
// =========================
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const APP_LOG_FILE = path.join(LOG_DIR, "app.log");

// =========================
// 送料テーブル（例）
// 実運用は DB テーブル化でもOKだが、まずはサーバ内で統一。
// =========================
const SHIPPING_REGION_BY_PREF = {
  // ※必要なら増やす
  "北海道": "hokkaido",
  "青森県": "tohoku", "岩手県": "tohoku", "宮城県": "tohoku", "秋田県": "tohoku", "山形県": "tohoku", "福島県": "tohoku",
  "東京都": "kanto", "神奈川県": "kanto", "埼玉県": "kanto", "千葉県": "kanto", "茨城県": "kanto", "栃木県": "kanto", "群馬県": "kanto",
  "新潟県": "shinetsu", "長野県": "shinetsu",
  "山梨県": "chubu", "静岡県": "chubu", "愛知県": "chubu", "岐阜県": "chubu", "三重県": "chubu",
  "富山県": "hokuriku", "石川県": "hokuriku", "福井県": "hokuriku",
  "滋賀県": "kinki", "京都府": "kinki", "大阪府": "kinki", "兵庫県": "kinki", "奈良県": "kinki", "和歌山県": "kinki",
  "鳥取県": "chugoku", "島根県": "chugoku", "岡山県": "chugoku", "広島県": "chugoku", "山口県": "chugoku",
  "徳島県": "shikoku", "香川県": "shikoku", "愛媛県": "shikoku", "高知県": "shikoku",
  "福岡県": "kyushu", "佐賀県": "kyushu", "長崎県": "kyushu", "熊本県": "kyushu", "大分県": "kyushu", "宮崎県": "kyushu", "鹿児島県": "kyushu",
  "沖縄県": "okinawa",
};

// サイズ別 送料（例：税込）※あなたの現行表に合わせて調整してOK
// key: region -> size -> yen
const SHIPPING_YAMATO = {
  hokkaido: { 60: 1300, 80: 1550, 100: 1800, 120: 2050, 140: 2300 },
  tohoku:   { 60:  900, 80: 1100, 100: 1300, 120: 1500, 140: 1700 },
  kanto:    { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600 },
  shinetsu: { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600 },
  chubu:    { 60:  750, 80:  950, 100: 1150, 120: 1350, 140: 1550 },
  hokuriku: { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600 },
  kinki:    { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600 },
  chugoku:  { 60:  850, 80: 1050, 100: 1250, 120: 1450, 140: 1650 },
  shikoku:  { 60:  850, 80: 1050, 100: 1250, 120: 1450, 140: 1650 },
  kyushu:   { 60:  900, 80: 1100, 100: 1300, 120: 1500, 140: 1700 },
  okinawa:  { 60: 1350, 80: 1700, 100: 2100, 120: 2600, 140: 3100 },
};

// =========================
// “あかしゃ扱い” 判定（久助をここに含める）
// =========================
function isAkashaLikeProduct(product) {
  const name = (product?.name || "").toLowerCase();
  const id = (product?.id || "").toLowerCase();
  // あかしゃ系 + 久助 を同カテゴリとして扱う
  if (id.includes("akasha") || name.includes("あかしゃ") || name.includes("akasha")) return true;
  if (id.includes("kusuke") || name.includes("久助")) return true; // ← ここが重要
  return false;
}

// =========================
// “オリジナルセット” サイズ決定（あなた指定）
// =========================
function sizeForOriginalSet(qty) {
  if (qty <= 1) return 80;
  if (qty === 2) return 100;
  if (qty === 3 || qty === 4) return 120;
  return 140; // 5-6想定（それ以上は運用で制限/分割など）
}

// =========================
// 汎用：安全にディレクトリ作成
// =========================
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// =========================
// ログ（Diskに保存）
// =========================
async function logToFile(line) {
  try {
    await ensureDir(LOG_DIR);
    await fsp.appendFile(APP_LOG_FILE, line + "\n", "utf8");
  } catch (e) {
    console.error("[LOG_WRITE_FAIL]", e?.message || e);
  }
}
function nowISO() { return new Date().toISOString(); }
function logInfo(...args) {
  const msg = `[${nowISO()}][INFO] ${args.map(String).join(" ")}`;
  console.log(msg);
  logToFile(msg);
}
function logErr(...args) {
  const msg = `[${nowISO()}][ERR] ${args.map(String).join(" ")}`;
  console.error(msg);
  logToFile(msg);
}

// =========================
// JSON 永続（products / sessions）
// =========================
async function readJsonSafe(file, fallback) {
  try {
    const s = await fsp.readFile(file, "utf8");
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, file);
}

// =========================
// products.json 初期化（無ければ作る）
// “久助の価格固定ロジック撤廃” → ここは seed だけ。管理で変更可能。
// =========================
async function ensureProductsFile() {
  await ensureDir(DATA_DIR);
  const exists = fs.existsSync(PRODUCTS_FILE);
  if (exists) return;

  const seed = [
    {
      id: "kusuke-250",
      name: "久助（われせん）",
      price: 250,
      stock: 30,
      volume: "100g",
      desc: "お得な割れせん。価格は管理画面で自由に変更できます。",
      image: ""
    },
    {
      id: "nori-akasha-340",
      name: "のりあかしゃ",
      price: 340,
      stock: 20,
      volume: "80g",
      desc: "海苔の風味。",
      image: ""
    },
    {
      id: ORIGINAL_SET_PRODUCT_ID,
      name: "磯屋オリジナルセット",
      price: 2100,
      stock: 50,
      volume: "セット",
      desc: "人気の詰め合わせ。",
      image: ""
    }
  ];

  await writeJsonAtomic(PRODUCTS_FILE, seed);
  logInfo("products.json created:", PRODUCTS_FILE);
}

async function loadProducts() {
  await ensureProductsFile();
  const arr = await readJsonSafe(PRODUCTS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
async function saveProducts(products) {
  await writeJsonAtomic(PRODUCTS_FILE, products);
}

// =========================
// セッション（“起動キーワード2つだけ”を守る）
// sessions.json に永続化
// =========================
const sessions = new Map(); // userId -> session
async function loadSessions() {
  const data = await readJsonSafe(SESSIONS_FILE, {});
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) sessions.set(k, v);
  }
}
async function persistSessions() {
  const obj = {};
  for (const [k, v] of sessions.entries()) obj[k] = v;
  await writeJsonAtomic(SESSIONS_FILE, obj);
}
function setSession(userId, sess) {
  sessions.set(userId, { ...sess, updatedAt: Date.now() });
  persistSessions().catch(()=>{});
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  // 例：24時間で期限切れ
  const ttl = 24 * 60 * 60 * 1000;
  if (Date.now() - (s.updatedAt || 0) > ttl) {
    sessions.delete(userId);
    persistSessions().catch(()=>{});
    return null;
  }
  return s;
}
function clearSession(userId) {
  sessions.delete(userId);
  persistSessions().catch(()=>{});
}

// =========================
// DB（Postgres）
// =========================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureDb() {
  // users: display_name を保存（販促/管理で使う）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);

  // addresses: 住所DB（オンライン側）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT UNIQUE,
      member_code TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // orders: 注文DB（永続）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      source TEXT,                 -- 'liff' / 'line' / etc
      items JSONB NOT NULL,        -- [{id,name,qty,price,volume,image,...}]
      total INTEGER NOT NULL,      -- 商品合計
      shipping_fee INTEGER NOT NULL,
      payment_method TEXT NOT NULL, -- 'card'/'cod'
      status TEXT NOT NULL DEFAULT 'new', -- new/paid/cancelled/...
      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,
      raw_event JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // segment_users: セグメント抽出用（LIFF起動者等）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);

  // segment_blast: ワンショット配信用（seg_key × user_id）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_blast (
      segment_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(segment_key, user_id)
    );
  `);

  // friend_logs: 友だち追加/ブロック等を“日次”で見える化
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_logs (
      id BIGSERIAL PRIMARY KEY,
      day DATE NOT NULL,
      added_count INTEGER NOT NULL DEFAULT 0,
      blocked_count INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(day)
    );
  `);

  logInfo("DB ensured");
}

async function touchUser(userId, kind, displayName = null) {
  // users upsert
  await pool.query(
    `
    INSERT INTO users (user_id, display_name, last_seen_at, last_liff_at)
    VALUES ($1, $2, CASE WHEN $3='seen' THEN now() ELSE NULL END, CASE WHEN $3='liff' THEN now() ELSE NULL END)
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      last_seen_at = CASE WHEN $3='seen' THEN now() ELSE users.last_seen_at END,
      last_liff_at = CASE WHEN $3='liff' THEN now() ELSE users.last_liff_at END,
      updated_at = now()
    `,
    [userId, displayName, kind]
  );

  // segment_users upsert
  await pool.query(
    `
    INSERT INTO segment_users (user_id, last_seen_at, last_liff_at)
    VALUES ($1, CASE WHEN $2='seen' THEN now() ELSE NULL END, CASE WHEN $2='liff' THEN now() ELSE NULL END)
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at = CASE WHEN $2='seen' THEN now() ELSE segment_users.last_seen_at END,
      last_liff_at = CASE WHEN $2='liff' THEN now() ELSE segment_users.last_liff_at END
    `,
    [userId, kind]
  );
}

async function getAddressByUserId(userId) {
  const r = await pool.query(
    `SELECT user_id, member_code, name, phone, postal, prefecture, city, address1, address2, updated_at
     FROM addresses WHERE user_id=$1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function upsertAddress(userId, addr) {
  // member_code が無ければ発行（4桁）
  let memberCode = (addr.member_code || "").trim();
  if (!memberCode) memberCode = await issueUniqueMemberCode();

  const q = `
    INSERT INTO addresses (user_id, member_code, name, phone, postal, prefecture, city, address1, address2)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (user_id) DO UPDATE SET
      member_code = EXCLUDED.member_code,
      name = EXCLUDED.name,
      phone = EXCLUDED.phone,
      postal = EXCLUDED.postal,
      prefecture = EXCLUDED.prefecture,
      city = EXCLUDED.city,
      address1 = EXCLUDED.address1,
      address2 = EXCLUDED.address2,
      updated_at = now()
    RETURNING user_id, member_code, name, phone, postal, prefecture, city, address1, address2, updated_at
  `;
  const r = await pool.query(q, [
    userId,
    memberCode,
    addr.name || "",
    addr.phone || "",
    addr.postal || "",
    addr.prefecture || "",
    addr.city || "",
    addr.address1 || "",
    addr.address2 || "",
  ]);
  return r.rows[0];
}

async function issueUniqueMemberCode() {
  // 4桁を衝突回避で発行
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const r = await pool.query(`SELECT 1 FROM addresses WHERE member_code=$1`, [code]);
    if (r.rowCount === 0) return code;
  }
  // 最後の手段
  return String(Math.floor(10000 + Math.random() * 90000));
}

// =========================
// 送料計算（オンライン側統一）
// - 商品構成から “サイズ” を決める
//   - 例：オリジナルセットはあなた指定のサイズ表
//   - “久助”は akasha 扱いでサイズ計算へ含める
// =========================
function detectRegionFromPref(prefecture) {
  const pref = (prefecture || "").trim();
  return SHIPPING_REGION_BY_PREF[pref] || "chubu";
}

function calcPackageSizeFromItems(items, productsById) {
  // items: [{id, qty}]
  // ここはあなたの運用ルールで最重要。まずは
  //  - オリジナルセットは専用表
  //  - それ以外はざっくり（あかしゃ/久助を小箱として加算）にしておく
  //
  // ※必要ならここを“完全にあなたの梱包ルール”へ寄せる

  let hasOriginalSet = false;
  let originalQty = 0;

  let smallCount = 0; // あかしゃ・久助等を小袋換算
  let otherCount = 0;

  for (const it of items || []) {
    const p = productsById[it.id];
    const qty = Number(it.qty || 0);
    if (!p || qty <= 0) continue;

    if (p.id === ORIGINAL_SET_PRODUCT_ID) {
      hasOriginalSet = true;
      originalQty += qty;
      continue;
    }

    if (isAkashaLikeProduct(p)) {
      smallCount += qty;
    } else {
      otherCount += qty;
    }
  }

  // オリジナルセットが入る場合：あなた指定のサイズを優先
  if (hasOriginalSet) {
    // まず “セット数”で基本サイズ
    const base = sizeForOriginalSet(originalQty);

    // 他商品が混載される場合：+1段階 など運用ルールを入れたいならここ
    // 今回は “混載なら一段階上げる” の保守的ルール
    const mix = smallCount + otherCount;
    if (mix <= 0) return base;
    if (base === 80) return 100;
    if (base === 100) return 120;
    if (base === 120) return 140;
    return 140;
  }

  // それ以外：ざっくり（小袋合計でサイズ決め）
  const total = smallCount + otherCount;

  if (total <= 2) return 60;
  if (total <= 4) return 80;
  if (total <= 6) return 100;
  if (total <= 10) return 120;
  return 140;
}

function calcShippingFee(prefecture, size) {
  const region = detectRegionFromPref(prefecture);
  const table = SHIPPING_YAMATO[region] || SHIPPING_YAMATO["chubu"];
  return Number(table[size] || table[80] || 0);
}

// =========================
// LINE クライアント
// =========================
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// =========================
// Express
// =========================
const app = express();

// Webhook は raw body が必要になるケースがあるので、Stripe webhook と分離
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// 静的配信（public）
app.use("/public", express.static(path.join(__dirname, "public")));

// ★超重要：アップロード画像を Disk から配信（Cannot GET 対策）
app.use("/public/uploads", express.static(UPLOAD_DIR));
app.use("/uploads", express.static(UPLOAD_DIR)); // 保険（どっちでも見える）

// health
app.get("/health", (req, res) => res.json({ ok: true, time: nowISO() }));

// =========================
// 管理API 認証
// =========================
function requireAdmin(req, res, next) {
 if (!ADMIN_API_TOKEN)
      return res.status(403).json({ ok:false, error:"ADMIN_TOKEN is not set" });

  // ✅ ヘッダ名の揺れを吸収（あなたが色々試したやつ全部通す）
  const token =
    (req.headers["x-admin-token"] ||
     req.headers["x-admin-api-token"] ||
     req.headers["x-admin_api_token"] ||
     req.query.token ||
     "").toString().trim();

if (token !== ADMIN_API_TOKEN)
      return res.status(401).json({ ok:false, error:"unauthorized" });

   next();
 }

// =========================
// Products API
// =========================
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();

    // このAPIを叩いた “そのサーバー自身” を基準にする（最強）
    const origin = `${req.protocol}://${req.get("host")}`;

    const fixed = products.map(p => {
      let img = String(p.image || "").trim();
      if (!img) return p;

      // 入力ゆれ吸収
      img = img.replace(/^public\//, "/public/");
      img = img.replace(/^uploads\//, "/public/uploads/");
      img = img.replace(/^\/uploads\//, "/public/uploads/");

      // filenameだけ → /public/uploads/ に補正
      if (!/^https?:\/\//i.test(img)) {
        if (!img.startsWith("/")) img = "/public/uploads/" + img;
        img = origin + img;
      }
      return { ...p, image: img };
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, products: fixed });
  } catch (e) {
    logErr("GET /api/products", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// 管理：商品一覧（GET）  ← これが無いので 404 になってた
// =========================
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const products = await loadProducts();
    res.json({ ok: true, products });
  } catch (e) {
    console.error("GET /api/admin/products", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// 管理：アップロード済み画像一覧（GET）
// =========================
app.get("/api/admin/images", requireAdmin, async (req, res) => {
  try {
    await ensureDir(UPLOAD_DIR);

    const files = await fsp.readdir(UPLOAD_DIR).catch(() => []);
    const images = files
      .filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, "en"));

    const base =
      (BASE_URL && BASE_URL.startsWith("http")) ? BASE_URL :
      `${req.protocol}://${req.get("host")}`;

    const list = images.map(name => ({
      name,
      url: `${base}/public/uploads/${encodeURIComponent(name)}`
    }));

    res.json({ ok: true, images: list });
  } catch (e) {
    console.error("GET /api/admin/images", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：商品更新（price/stock/volume/desc/name/image）
app.post("/api/admin/products/update", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const id = String(body.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const products = await loadProducts();
    const i = products.findIndex(p => p.id === id);
    if (i < 0) return res.status(404).json({ ok: false, error: "not_found" });

    const p = products[i];
    const next = {
      ...p,
      name: body.name != null ? String(body.name) : p.name,
      price: body.price != null ? Number(body.price) : p.price,
      stock: body.stock != null ? Number(body.stock) : p.stock,
      volume: body.volume != null ? String(body.volume) : (p.volume || ""),
      desc: body.desc != null ? String(body.desc) : (p.desc || ""),
      image: body.image != null ? String(body.image) : (p.image || ""),
    };
    products[i] = next;
    await saveProducts(products);

    res.json({ ok: true, product: next });
  } catch (e) {
    logErr("POST /api/admin/products/update", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：商品追加
app.post("/api/admin/products/add", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const id = String(b.id || "").trim();
    const name = String(b.name || "").trim();
    if (!id || !name) return res.status(400).json({ ok: false, error: "id & name required" });

    const products = await loadProducts();
    if (products.some(p => p.id === id)) return res.status(409).json({ ok: false, error: "id exists" });

    const p = {
      id,
      name,
      price: Number(b.price || 0),
      stock: Number(b.stock || 0),
      volume: String(b.volume || ""),
      desc: String(b.desc || ""),
      image: String(b.image || ""),
    };
    products.push(p);
    await saveProducts(products);
    res.json({ ok: true, product: p });
  } catch (e) {
    logErr("POST /api/admin/products/add", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：商品削除
app.post("/api/admin/products/delete", requireAdmin, async (req, res) => {
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const products = await loadProducts();
    const next = products.filter(p => p.id !== id);
    await saveProducts(next);
    res.json({ ok: true, removed: products.length - next.length });
  } catch (e) {
    logErr("POST /api/admin/products/delete", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 画像アップロード（base64 を受ける簡易版）
// body: { filename?, contentBase64, mime? } -> /public/uploads/<saved>
app.post("/api/admin/upload-image", requireAdmin, async (req, res) => {
  try {
    const { contentBase64, filename, mime } = req.body || {};
    if (!contentBase64) return res.status(400).json({ ok: false, error: "contentBase64 required" });

    await ensureDir(UPLOAD_DIR);

    const ext =
      (mime && mime.includes("png")) ? "png" :
      (mime && mime.includes("webp")) ? "webp" :
      (mime && mime.includes("jpeg")) ? "jpg" :
      (mime && mime.includes("jpg")) ? "jpg" : "png";

    const safeName = (filename ? String(filename) : "").
      replace(/[^\w.\-]/g, "_").
      replace(/\.+/g, ".").
      slice(0, 80);

    const name = safeName || `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const buf = Buffer.from(String(contentBase64).replace(/^data:.*;base64,/, ""), "base64");
    const outPath = path.join(UPLOAD_DIR, name);

    await fsp.writeFile(outPath, buf);

    const url = `${BASE_URL}/public/uploads/${encodeURIComponent(name)}`;
    res.json({ ok: true, name, url });
  } catch (e) {
    logErr("POST /api/admin/upload-image", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// 住所API（LIFFから保存/取得）
// =========================
app.get("/api/address/get", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    const addr = await getAddressByUserId(userId);
    res.json({ ok: true, address: addr });
  } catch (e) {
    logErr("GET /api/address/get", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/address/set", async (req, res) => {
  try {
    const b = req.body || {};
    const userId = String(b.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    const saved = await upsertAddress(userId, {
      member_code: b.member_code,
      name: b.name,
      phone: b.phone,
      postal: b.postal,
      prefecture: b.prefecture,
      city: b.city,
      address1: b.address1,
      address2: b.address2,
    });

    res.json({ ok: true, address: saved });
  } catch (e) {
    logErr("POST /api/address/set", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// id_token verify（任意：LIFF_CHANNEL_ID があれば使える）
app.post("/api/liff/verify", async (req, res) => {
  try {
    if (!LIFF_CHANNEL_ID) return res.status(400).json({ ok: false, error: "LIFF_CHANNEL_ID not set" });
    const idToken = String(req.body?.id_token || "");
    if (!idToken) return res.status(400).json({ ok: false, error: "id_token required" });

    const params = new URLSearchParams();
    params.set("id_token", idToken);
    params.set("client_id", LIFF_CHANNEL_ID);

    const r = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const data = await r.json().catch(()=> ({}));
    if (!r.ok) return res.status(401).json({ ok: false, error: "verify_failed", detail: data });

    // data.sub が userId
    res.json({ ok: true, profile: data });
  } catch (e) {
    logErr("POST /api/liff/verify", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// LIFF 起動ログ（セグメント抽出）
app.post("/api/liff/opened", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await touchUser(userId, "liff");
    res.json({ ok: true });
  } catch (e) {
    logErr("POST /api/liff/opened", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// 注文作成（LIFF → card/cod）
// - items は [{id, qty}] を想定
// - address は userId から DB 取得
// - shippingFee を統一計算
// =========================
async function buildOrderFromRequest(userId, itemsRaw) {
  const products = await loadProducts();
  const productsById = {};
  for (const p of products) productsById[p.id] = p;

  const items = [];
  let subtotal = 0;

  for (const it of (itemsRaw || [])) {
    const id = String(it.id || "").trim();
    const qty = Math.max(0, Number(it.qty || 0));
    if (!id || qty <= 0) continue;

    const p = productsById[id];
    if (!p) continue;

    // 在庫チェック（必要なら“注文確定時に在庫減算”へ）
    if (Number.isFinite(p.stock) && p.stock < qty) {
      const err = new Error(`在庫不足: ${p.name} (stock=${p.stock}, qty=${qty})`);
      err.code = "OUT_OF_STOCK";
      err.productId = id;
      throw err;
    }

    const lineTotal = Number(p.price || 0) * qty;
    subtotal += lineTotal;

    items.push({
      id: p.id,
      name: p.name,
      qty,
      price: Number(p.price || 0),
      volume: p.volume || "",
      image: p.image || "",
      desc: p.desc || "",
      lineTotal,
    });
  }

  if (items.length === 0) {
    const err = new Error("items empty");
    err.code = "EMPTY_ITEMS";
    throw err;
  }

  const addr = await getAddressByUserId(userId);
  if (!addr) {
    const err = new Error("address not found");
    err.code = "NO_ADDRESS";
    throw err;
  }

  // 送料計算
  const size = calcPackageSizeFromItems(items, Object.fromEntries(items.map(x => [x.id, (productsById[x.id] || {})])));
  const shippingFee = calcShippingFee(addr.prefecture, size);

  return {
    items,
    subtotal,
    shippingFee,
    size,
    address: addr,
  };
}

// 注文DB保存
async function insertOrderToDb({ userId, items, subtotal, shippingFee, paymentMethod, status, rawEvent }) {
  const addr = await getAddressByUserId(userId);
  const fullAddr = addr ? `${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""} ${addr.address2 || ""}`.trim() : "";

  const r = await pool.query(
    `
    INSERT INTO orders (user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
    VALUES ($1,'liff',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id
    `,
    [
      userId,
      JSON.stringify(items),
      subtotal,
      shippingFee,
      paymentMethod,
      status,
      addr?.name || "",
      addr?.postal || "",
      addr?.prefecture || "",
      fullAddr,
      rawEvent ? JSON.stringify(rawEvent) : null,
    ]
  );
  return r.rows[0]?.id;
}

// =========================
// Stripe 決済
// =========================
const stripe = (STRIPE_SECRET_KEY && Stripe) ? new Stripe(STRIPE_SECRET_KEY) : null;

function stripeSuccessUrl() {
  if (STRIPE_SUCCESS_URL) return STRIPE_SUCCESS_URL;
  return BASE_URL ? `${BASE_URL}/public/stripe-success.html` : "https://example.com/success";
}
function stripeCancelUrl() {
  if (STRIPE_CANCEL_URL) return STRIPE_CANCEL_URL;
  return BASE_URL ? `${BASE_URL}/public/stripe-cancel.html` : "https://example.com/cancel";
}

// LIFF → Stripe Checkout Session 作成
app.post("/api/checkout", async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok: false, error: "stripe_not_configured" });

    const userId = String(req.body?.userId || "").trim();
    const itemsRaw = req.body?.items || [];
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await touchUser(userId, "seen");

    const built = await buildOrderFromRequest(userId, itemsRaw);

    // Stripe line items
    const lineItems = built.items.map(it => ({
      price_data: {
        currency: "jpy",
        product_data: { name: `${it.name}（${it.volume || ""}）`.replace(/（\s*）$/, "") },
        unit_amount: it.price,
      },
      quantity: it.qty,
    }));

    // 送料を別行として追加
    if (built.shippingFee > 0) {
      lineItems.push({
        price_data: {
          currency: "jpy",
          product_data: { name: `送料（ヤマト ${built.size}サイズ）` },
          unit_amount: built.shippingFee,
        },
        quantity: 1,
      });
    }

    // 先に order を new で入れて、Checkout完了で paid にする設計もOK
    // 今回は “Checkout作成時に仮注文作成” して orderId を metadata に入れる
    const orderId = await insertOrderToDb({
      userId,
      items: built.items,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      paymentMethod: "card",
      status: "new",
      rawEvent: { type: "checkout_create" },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${stripeSuccessUrl()}?orderId=${orderId}`,
      cancel_url: `${stripeCancelUrl()}?orderId=${orderId}`,
      metadata: { orderId: String(orderId), userId },
    });

    res.json({
      ok: true,
      orderId,
      checkoutUrl: session.url,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      size: built.size,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/checkout", code, e?.stack || e);
    if (code === "NO_ADDRESS") return res.status(409).json({ ok: false, error: "NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok: false, error: "OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok: false, error: "EMPTY_ITEMS" });
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Stripe webhook（必要なら）
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(400).send("stripe not configured");

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      logErr("Stripe webhook signature verify failed", err?.message || err);
      return res.status(400).send("Bad signature");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session?.metadata?.orderId;
      if (orderId) {
        await pool.query(`UPDATE orders SET status='paid' WHERE id=$1`, [orderId]);
        logInfo("Order paid:", orderId);
      }
    }

    res.json({ received: true });
  } catch (e) {
    logErr("POST /stripe/webhook", e?.stack || e);
    res.status(500).send("server_error");
  }
});
// 注文ステータス確認（Stripe success画面でポーリングに使う）
app.get("/api/order/status", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok:false, error:"orderId required" });

    const r = await pool.query(
      `SELECT id, status, payment_method, total, shipping_fee, created_at
       FROM orders WHERE id=$1`,
      [orderId]
    );
    const row = r.rows[0];
    if (!row) return res.status(404).json({ ok:false, error:"not_found" });

    res.json({ ok:true, order: row });
  } catch (e) {
    console.error("GET /api/order/status", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// =========================
// 代引注文（LIFF側で“代引”を選ぶ時）
// - DBに保存して status=new のまま（運用で発送/入金管理）
// =========================
app.post("/api/cod/create", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const itemsRaw = req.body?.items || [];
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await touchUser(userId, "seen");

    const built = await buildOrderFromRequest(userId, itemsRaw);

    const orderId = await insertOrderToDb({
      userId,
      items: built.items,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "new",
      rawEvent: { type: "cod_create" },
    });

    res.json({
      ok: true,
      orderId,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee: Number(COD_FEE || 330),
      totalCod: built.subtotal + built.shippingFee + Number(COD_FEE || 330),
      size: built.size,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/cod/create", code, e?.stack || e);
    if (code === "NO_ADDRESS") return res.status(409).json({ ok: false, error: "NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok: false, error: "OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok: false, error: "EMPTY_ITEMS" });
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// 管理：セグメント抽出 & ワンショット配信
// =========================

// 管理：今日の友だち追加/純増（簡易）
app.get("/api/admin/friends/today", requireAdmin, async (req, res) => {
  try {
    const day = new Date();
    const yyyy = day.getFullYear();
    const mm = String(day.getMonth() + 1).padStart(2, "0");
    const dd = String(day.getDate()).padStart(2, "0");
    const key = `${yyyy}-${mm}-${dd}`;

    const r = await pool.query(`SELECT day, added_count, blocked_count FROM friend_logs WHERE day=$1`, [key]);
    const row = r.rows[0] || { day: key, added_count: 0, blocked_count: 0 };
    res.json({ ok: true, ...row, net: (row.added_count || 0) - (row.blocked_count || 0) });
  } catch (e) {
    logErr("GET /api/admin/friends/today", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：segment_key に対して条件抽出して segment_blast に詰める
// 例：昨日の LIFF 起動者を詰める
app.post("/api/admin/segment/fill", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.body?.segment_key || "").trim();
    const mode = String(req.body?.mode || "yesterday_liff").trim();
    if (!segmentKey) return res.status(400).json({ ok: false, error: "segment_key required" });

    let inserted = 0;

    if (mode === "yesterday_liff") {
      // “昨日”の定義：JSTで前日0:00-24:00（DBはTZ付き、簡易に now()-1day の date で見る）
      const q = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, user_id
        FROM segment_users
        WHERE last_liff_at IS NOT NULL
          AND (last_liff_at AT TIME ZONE 'Asia/Tokyo')::date = ((now() AT TIME ZONE 'Asia/Tokyo')::date - 1)
          AND user_id <> ''
        ON CONFLICT DO NOTHING
      `;
      const r = await pool.query(q, [segmentKey]);
      inserted = r.rowCount || 0;
    } else if (mode === "all_liff") {
      const q = `
        INSERT INTO segment_blast (segment_key, user_id)
        SELECT $1, user_id
        FROM segment_users
        WHERE last_liff_at IS NOT NULL
          AND user_id <> ''
        ON CONFLICT DO NOTHING
      `;
      const r = await pool.query(q, [segmentKey]);
      inserted = r.rowCount || 0;
    } else {
      return res.status(400).json({ ok: false, error: "unknown mode" });
    }

    res.json({ ok: true, inserted });
  } catch (e) {
    logErr("POST /api/admin/segment/fill", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：segment_key の対象数
app.get("/api/admin/segment/count", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.query.segment_key || "").trim();
    if (!segmentKey) return res.status(400).json({ ok: false, error: "segment_key required" });
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM segment_blast WHERE segment_key=$1`, [segmentKey]);
    res.json({ ok: true, count: r.rows[0]?.n || 0 });
  } catch (e) {
    logErr("GET /api/admin/segment/count", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：ワンショット配信（multicast）
// body: { segment_key, messages:[{type:'text',text:'...'}] }
app.post("/api/admin/blast/once", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.body?.segment_key || "").trim();
    const messages = req.body?.messages || [{ type: "text", text: "配信テスト" }];
    if (!segmentKey) return res.status(400).json({ ok: false, error: "segment_key required" });

    // 最大500件ずつ（LINE multicast 制限）
    const r = await pool.query(
      `SELECT user_id FROM segment_blast WHERE segment_key=$1 ORDER BY created_at ASC`,
      [segmentKey]
    );
    const userIds = r.rows.map(x => x.user_id).filter(Boolean);

    let sent = 0;
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = userIds.slice(i, i + 500);
      await lineClient.multicast(chunk, messages);
      sent += chunk.length;
    }
    res.json({ ok: true, sent });
  } catch (e) {
    logErr("POST /api/admin/blast/once", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// LINE Webhook
// =========================
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    logErr("Webhook error", e?.stack || e);
    res.status(500).end();
  }
});

async function handleEvent(ev) {
  const type = ev.type;
  const userId = ev?.source?.userId || "";

  if (userId) {
    try { await touchUser(userId, "seen"); } catch {}
  }

  if (type === "follow") {
    await onFollow(ev);
    return;
  }
  if (type === "unfollow") {
    await onUnfollow(ev);
    return;
  }
  if (type === "message" && ev.message?.type === "text") {
    await onTextMessage(ev);
    return;
  }
  if (type === "postback") {
    await onPostback(ev);
    return;
  }
}

async function onFollow(ev) {
  const userId = ev?.source?.userId || "";
  if (!userId) return;

  // 友だち追加を日次で+1
  const day = (new Date()).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD
  await pool.query(
    `
    INSERT INTO friend_logs (day, added_count, blocked_count)
    VALUES ($1, 1, 0)
    ON CONFLICT (day) DO UPDATE SET
      added_count = friend_logs.added_count + 1,
      updated_at = now()
    `,
    [day]
  );

  // display_name 保存
  let displayName = null;
  try {
    const prof = await lineClient.getProfile(userId);
    displayName = prof?.displayName || null;
  } catch {}
  try { await touchUser(userId, "seen", displayName); } catch {}

  await lineClient.pushMessage(userId, {
    type: "text",
    text:
      "友だち追加ありがとうございます！\n\n" +
      `・「${KEYWORD_DIRECT}」でミニアプリ注文\n` +
      `・「${KEYWORD_KUSUKE}」で久助の注文\n\n` +
      "住所登録がまだの場合は、ミニアプリ内の「住所登録」からお願いします。",
  });
}

async function onUnfollow(ev) {
  // ブロック等を日次で+1（厳密ではないが運用上OK）
  const day = (new Date()).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  await pool.query(
    `
    INSERT INTO friend_logs (day, added_count, blocked_count)
    VALUES ($1, 0, 1)
    ON CONFLICT (day) DO UPDATE SET
      blocked_count = friend_logs.blocked_count + 1,
      updated_at = now()
    `,
    [day]
  );
}

function liffUrl(pathname) {
  // LIFFのURLはあなたの運用に合わせて：
  // - LIFFアプリのURL（LINE Developers の LIFF URL）を使う場合は “固定URL”を env に置く方がベター
  // ここは “公開URL + /public/xxx.html” としている（あなたの既存HTMLに合わせて調整OK）
  if (!LIFF_BASE) return pathname;
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return LIFF_BASE + pathname;
}

// 起動キーワード2つだけ + セッション中のみ継続
async function onTextMessage(ev) {
  const userId = ev?.source?.userId || "";
  const text = (ev.message?.text || "").trim();
  if (!userId || !text) return;

  const sess = getSession(userId);

  // セッション中は入力を処理
  if (sess) {
    await handleSessionInput(userId, text, ev);
    return;
  }

  // セッションが無い場合：起動キーワード2つだけ
  if (text === KEYWORD_DIRECT) {
    setSession(userId, { kind: "direct", step: "start" });
    await replyDirectStart(ev.replyToken, userId);
    return;
  }
  if (text.startsWith(KEYWORD_KUSUKE)) {
    // 例： "久助 3" も許可（あなた要望）
    const m = text.match(/^久助\s*([0-9]+)?/);
    const qty = m && m[1] ? Number(m[1]) : null;

    setSession(userId, { kind: "kusuke", step: "ask_qty", presetQty: qty || null });
    await replyKusukeStart(ev.replyToken, userId, qty);
    return;
  }

  // それ以外は無反応（あなた要望）
}

async function onPostback(ev) {
  // 必要なら拡張（店舗受取/注文開始のポストバック等）
}

async function replyDirectStart(replyToken, userId) {
  // ミニアプリ（商品一覧）へ誘導
  const url = liffUrl("/public/liff/index.html"); // あなたの既存パスに合わせて変更OK
  const msg = {
    type: "flex",
    altText: "ミニアプリ注文を開く",
    contents: {
      type: "bubble",
      hero: {
        type: "image",
        url: `${BASE_URL}/public/assets/hero.png`.replace("undefined", ""),
        size: "full",
        aspectMode: "cover",
        aspectRatio: "20:13"
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "ミニアプリで注文", weight: "bold", size: "lg" },
          { type: "text", text: "商品を選んで、住所・支払い方法を選択して注文できます。", wrap: true, size: "sm", color: "#555555" },
          {
            type: "button",
            style: "primary",
            action: { type: "uri", label: "注文をはじめる", uri: url }
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "uri", label: "住所登録", uri: liffUrl("/public/liff-address.html") }
          }
        ]
      }
    }
  };

  // hero画像が無い環境でも落ちないように altText テキスト版も併用可
  await lineClient.replyMessage(replyToken, msg).catch(async () => {
    await lineClient.replyMessage(replyToken, { type: "text", text: `こちらから注文できます：\n${url}` });
  });

  clearSession(userId);
}

async function replyKusukeStart(replyToken, userId, qtyPreset) {
  // 久助は“チャットで個数入力 → 住所DB読んで送料計算”があなた要望
  const addr = await getAddressByUserId(userId);

  if (!addr) {
    // 住所が無ければ住所登録へ誘導
    const url = liffUrl("/public/liff-address.html");
    await lineClient.replyMessage(replyToken, {
      type: "text",
      text:
        "久助の注文を始めます。\n\n" +
        "先に住所登録が必要です。\n" +
        `住所登録はこちら：\n${url}`,
    });
    clearSession(userId);
    return;
  }

  if (qtyPreset && qtyPreset > 0) {
    // すぐ確定計算へ
    await finalizeKusukeOrder(replyToken, userId, qtyPreset);
    clearSession(userId);
    return;
  }

  await lineClient.replyMessage(replyToken, {
    type: "text",
    text:
      "久助の個数を数字で送ってください。\n" +
      "例：3",
  });
  setSession(userId, { kind: "kusuke", step: "wait_qty" });
}

async function handleSessionInput(userId, text, ev) {
  const sess = getSession(userId);
  if (!sess) return;

  if (sess.kind === "kusuke") {
    if (sess.step === "wait_qty") {
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty <= 0) {
        await lineClient.replyMessage(ev.replyToken, { type: "text", text: "数字（例：3）で送ってください。" });
        return;
      }
      await finalizeKusukeOrder(ev.replyToken, userId, qty);
      clearSession(userId);
      return;
    }
  }

  // それ以外のセッションは必要に応じて拡張
}

async function finalizeKusukeOrder(replyToken, userId, qty) {
  try {
    const products = await loadProducts();
    const kusuke = products.find(p => (p.name || "").includes("久助") || (p.id || "").includes("kusuke"));
    if (!kusuke) {
      await lineClient.replyMessage(replyToken, { type: "text", text: "久助の商品が products.json に見つかりませんでした。" });
      return;
    }

    // buildOrderFromRequest を使って統一送料計算（久助は akasha 扱いでサイズ計算へ入る）
    const built = await buildOrderFromRequest(userId, [{ id: kusuke.id, qty }]);

    // “久助”はチャット注文なので、まずは “代引（new）” として作る運用が多いが、
    // あなたの運用に合わせて “card へ誘導” も可能。
    // ここでは「代引注文として仮登録 + 合計案内」にしておく（必要なら変更）
    const orderId = await insertOrderToDb({
      userId,
      items: built.items,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "new",
      rawEvent: { type: "line_kusuke" },
    });

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const addr = built.address;
    const addrText =
      `〒${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""} ${addr.address2 || ""}`.trim();

    await lineClient.replyMessage(replyToken, {
      type: "text",
      text:
        `久助 注文を受け付けました（注文ID: ${orderId}）\n\n` +
        `【内容】\n` +
        `${kusuke.name} × ${qty}\n` +
        `単価：${kusuke.price}円\n\n` +
        `【送料】ヤマト ${built.size}サイズ：${built.shippingFee}円\n` +
        `【代引手数料】${codFee}円\n\n` +
        `【合計（代引）】${totalCod}円\n\n` +
        `【お届け先】\n${addrText}\n\n` +
        `※住所が違う場合は住所登録を更新してください。\n` +
        `${liffUrl("/public/liff-address.html")}`
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("finalizeKusukeOrder", code, e?.stack || e);
    if (code === "NO_ADDRESS") {
      await lineClient.replyMessage(replyToken, {
        type: "text",
        text: `住所が未登録です。\n住所登録：\n${liffUrl("/public/liff-address.html")}`,
      });
      return;
    }
    if (code === "OUT_OF_STOCK") {
      await lineClient.replyMessage(replyToken, { type: "text", text: "在庫が不足しています。個数を減らして試してください。" });
      return;
    }
    await lineClient.replyMessage(replyToken, { type: "text", text: "エラーが発生しました。時間をおいて再度お試しください。" });
  }
}

// =========================
// 起動
// =========================
async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(UPLOAD_DIR);
  await ensureProductsFile();
  await loadSessions();
  await ensureDb();

  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => logInfo(`server started on :${port}`));
}

main().catch(e => {
  logErr("BOOT FAIL", e?.stack || e);
  process.exit(1);
});
