/**
 * server.js — 追記版 “完全・全部入り” 丸ごと版（修正版）
 *
 * ✅ 今回の追記（重要）
 * 1) 送料をDBから読む（DBテーブル shipping_yamato_taxed を作成＆自動seed）
 *    - region + size → fee をDB参照
 *    - もしDB参照に失敗したら、従来どおりサーバ内テーブル（SHIPPING_YAMATO）へフォールバック
 * 2) LIFF_ID_ADDRESS の“別名対応”を追加（env名ゆれで400にならない）
 *    - LIFF_ID_ADDRESS / LIFF_ID_COD / LIFF_ID_DEFAULT を全部受ける
 * 3) オリジナルセット専用注文APIを追加：POST /api/orders/original（代引き）
 *    - 混載不可をサーバ側で強制
 *    - 送料はDB見積り
 *    - 注文者/管理者へ明細Push（任意：ADMIN_USER_ID）
 *
 * ✅ Render Disk 永続化（超重要）
 * - DATA_DIR=/var/data（デフォルト）: products.json / sessions.json / logs
 * - UPLOAD_DIR=/var/data/uploads（デフォルト）: 画像アップロード永続
 *
 * ✅ 静的配信
 * - /              → __dirname/public
 * - /public        → __dirname/public（互換）
 * - /uploads       → UPLOAD_DIR
 * - /public/uploads→ UPLOAD_DIR
 *
 * ✅ 必須 ENV
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - DATABASE_URL（Postgres）
 *
 * ✅ LIFF（推奨）
 * - LIFF_ID_DEFAULT（まずこれだけでOK）
 *   任意で分けるなら:
 *   - LIFF_ID_ORDER（注文ミニアプリ） ※ original-set/confirm もこれを使うのがシンプル
 *   - LIFF_ID_ADDRESS（住所登録）  ※ LIFF_ID_COD でもOK（別名）
 *
 * ✅ Stripe 利用するなら
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET（Webhook受けるなら）
 * - PUBLIC_BASE_URL（例 https://xxxx.onrender.com）
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const line = require("@line/bot-sdk");
const { Pool } = require("pg");

let Stripe = null;
try { Stripe = require("stripe"); } catch {}

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  DATABASE_URL,

  PUBLIC_BASE_URL,        // 例: https://xxxxx.onrender.com
  LIFF_BASE_URL,          // 例: https://xxxxx.onrender.com
  LIFF_CHANNEL_ID,        // 任意（id_token verifyしたい場合）

  // ✅ LIFF ID（env名ゆれ吸収）
  LIFF_ID_DEFAULT = "",
  LIFF_ID_ORDER = "",
  LIFF_ID_ADDRESS = "",   // ★正式
  LIFF_ID_COD = "",       // ★別名（=住所登録に使ってもOK）

  DATA_DIR = "/var/data",
  UPLOAD_DIR = "/var/data/uploads",

  ADMIN_API_TOKEN = "",

  // ★注文明細を管理者にも送る（任意）
  ADMIN_USER_ID = "",

  STRIPE_SECRET_KEY = "",
  STRIPE_WEBHOOK_SECRET = "",
  STRIPE_SUCCESS_URL = "",
  STRIPE_CANCEL_URL = "",

  COD_FEE = "330",

  KEYWORD_DIRECT = "直接注文",
  KEYWORD_KUSUKE = "久助",

  ORIGINAL_SET_PRODUCT_ID = "original-set-2000",
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const BASE_URL = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
const LIFF_BASE = (LIFF_BASE_URL || BASE_URL || "").replace(/\/$/, "");

if (!BASE_URL) {
  console.warn("[WARN] PUBLIC_BASE_URL が未設定です（URL生成が必要な箇所ではhostから自動推定します）。");
}

// ============== Disk paths ==============
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const APP_LOG_FILE = path.join(LOG_DIR, "app.log");

// ============== Shipping tables (fallback) ==============
const SHIPPING_REGION_BY_PREF = {
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

// サイズ別 送料（税込の例）※あなたの表に合わせて調整OK（フォールバック）
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

// ============== Helpers ==============
function nowISO() { return new Date().toISOString(); }

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function logToFile(line) {
  try {
    await ensureDir(LOG_DIR);
    await fsp.appendFile(APP_LOG_FILE, line + "\n", "utf8");
  } catch (e) {
    console.error("[LOG_WRITE_FAIL]", e?.message || e);
  }
}
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

// ============== products.json ==============
async function ensureProductsFile() {
  await ensureDir(DATA_DIR);
  if (fs.existsSync(PRODUCTS_FILE)) return;

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

// ============== sessions (Map + Disk) ==============
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
  const ttl = 24 * 60 * 60 * 1000; // 24h
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

// ============== Akasha-like (久助含む) ==============
function isAkashaLikeProduct(product) {
  const name = (product?.name || "").toLowerCase();
  const id = (product?.id || "").toLowerCase();
  if (id.includes("akasha") || name.includes("あかしゃ") || name.includes("akasha")) return true;
  if (id.includes("kusuke") || name.includes("久助")) return true;
  return false;
}

// ============== Original set sizing rule ==============
function sizeForOriginalSet(qty) {
  if (qty <= 1) return 80;
  if (qty === 2) return 100;
  if (qty === 3 || qty === 4) return 120;
  return 140; // 5-6想定
}

// ============== Shipping calc unified ==============
function detectRegionFromPref(prefecture) {
  const pref = (prefecture || "").trim();
  return SHIPPING_REGION_BY_PREF[pref] || "chubu";
}

/**
 * ✅ 送料DBキャッシュ（5分）
 */
const shippingCache = {
  loadedAt: 0,
  map: new Map(), // key: `${region}:${size}` -> fee
};
const SHIPPING_CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(region, size) { return `${region}:${String(size)}`; }

async function reloadShippingCacheIfNeeded(pool) {
  const now = Date.now();
  if (shippingCache.loadedAt && (now - shippingCache.loadedAt) < SHIPPING_CACHE_TTL_MS) return;

  try {
    const r = await pool.query(`SELECT region, size, fee FROM shipping_yamato_taxed`);
    const m = new Map();
    for (const row of (r.rows || [])) {
      const region = String(row.region || "").trim();
      const size = Number(row.size || 0);
      const fee = Number(row.fee || 0);
      if (!region || !size) continue;
      m.set(cacheKey(region, size), fee);
    }
    shippingCache.map = m;
    shippingCache.loadedAt = now;
  } catch {
    // ignore
  }
}

/**
 * ✅ DBから送料取得（優先順位）
 * 1) キャッシュ（shipping_yamato_taxed）
 * 2) shipping_yamato_taxed 直接SELECT
 * 3) 旧互換：shipping_yamato_${region}_taxed (size->fee) を試す（あれば）
 * 4) フォールバック：サーバ内 SHIPPING_YAMATO
 */
async function calcShippingFee(pool, prefecture, size) {
  const region = detectRegionFromPref(prefecture);
  const s = Number(size || 0) || 80;

  // 1) cache
  await reloadShippingCacheIfNeeded(pool);
  const ck = cacheKey(region, s);
  if (shippingCache.map.has(ck)) return Number(shippingCache.map.get(ck));

  // 2) unified table
  try {
    const r = await pool.query(
      `SELECT fee FROM shipping_yamato_taxed WHERE region=$1 AND size=$2 LIMIT 1`,
      [region, s]
    );
    if (r.rowCount > 0) {
      const fee = Number(r.rows[0]?.fee || 0);
      shippingCache.map.set(ck, fee);
      return fee;
    }
  } catch {}

  // 3) legacy per-region table (optional)
  try {
    const safeRegion = region.replace(/[^a-z0-9_]/gi, "");
    const table = `shipping_yamato_${safeRegion}_taxed`;
    const r2 = await pool.query(`SELECT fee FROM ${table} WHERE size=$1 LIMIT 1`, [s]);
    if (r2.rowCount > 0) return Number(r2.rows[0]?.fee || 0);
  } catch {}

  // 4) fallback memory table
  const table = SHIPPING_YAMATO[region] || SHIPPING_YAMATO["chubu"];
  return Number(table[s] || table[80] || 0);
}

function calcPackageSizeFromItems(items, productsById) {
  let hasOriginalSet = false;
  let originalQty = 0;

  let smallCount = 0; // akasha-like（久助含む）
  let otherCount = 0;

  for (const it of items || []) {
    const id = String(it.id || "").trim();
    const qty = Number(it.qty || 0);
    if (!id || qty <= 0) continue;

    const p = productsById[id];
    if (!p) continue;

    if (p.id === ORIGINAL_SET_PRODUCT_ID) {
      hasOriginalSet = true;
      originalQty += qty;
      continue;
    }
    if (isAkashaLikeProduct(p)) smallCount += qty;
    else otherCount += qty;
  }

  if (hasOriginalSet) {
    const base = sizeForOriginalSet(originalQty);
    const mix = smallCount + otherCount;
    if (mix <= 0) return base;
    if (base === 80) return 100;
    if (base === 100) return 120;
    if (base === 120) return 140;
    return 140;
  }

  const total = smallCount + otherCount;
  if (total <= 2) return 60;
  if (total <= 4) return 80;
  if (total <= 6) return 100;
  if (total <= 10) return 120;
  return 140;
}

// ============== DB (Postgres) ==============
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureDb() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id BIGSERIAL PRIMARY KEY,
      member_code TEXT,
      user_id TEXT,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      address_key TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_id_uidx ON addresses(user_id) WHERE user_id IS NOT NULL;`); }
  catch(e){ logErr("CREATE UNIQUE INDEX addresses_user_id_uidx failed", e?.message||e); }

  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_member_code_uidx ON addresses(member_code) WHERE member_code IS NOT NULL;`); }
  catch(e){ logErr("CREATE UNIQUE INDEX addresses_member_code_uidx failed", e?.message||e); }

  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_address_key_uidx ON addresses(address_key) WHERE address_key IS NOT NULL;`); }
  catch(e){ logErr("CREATE UNIQUE INDEX addresses_address_key_uidx failed", e?.message||e); }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      source TEXT,
      items JSONB NOT NULL,
      total INTEGER NOT NULL,
      shipping_fee INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,
      raw_event JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_blast (
      segment_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(segment_key, user_id)
    );
  `);

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

  // ✅ 送料テーブル（オンライン側もDB参照に統一）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_yamato_taxed (
      region TEXT NOT NULL,
      size   INTEGER NOT NULL,
      fee    INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(region, size)
    );
  `);

  // ✅ 初回seed（空ならサーバ内テーブルから投入）
  try {
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM shipping_yamato_taxed`);
    const n = cnt.rows?.[0]?.n || 0;
    if (n === 0) {
      const rows = [];
      for (const [region, table] of Object.entries(SHIPPING_YAMATO)) {
        for (const [size, fee] of Object.entries(table)) {
          rows.push([region, Number(size), Number(fee)]);
        }
      }
      if (rows.length) {
        const values = [];
        const params = [];
        let i = 1;
        for (const [region, size, fee] of rows) {
          values.push(`($${i++},$${i++},$${i++})`);
          params.push(region, size, fee);
        }
        await pool.query(
          `
          INSERT INTO shipping_yamato_taxed (region, size, fee)
          VALUES ${values.join(",")}
          ON CONFLICT (region, size) DO UPDATE SET
            fee = EXCLUDED.fee,
            updated_at = now()
          `,
          params
        );
        shippingCache.loadedAt = 0;
        await reloadShippingCacheIfNeeded(pool);
        logInfo("shipping_yamato_taxed seeded:", rows.length);
      }
    }
  } catch (e) {
    logErr("shipping_yamato_taxed seed failed", e?.message || e);
  }

  logInfo("DB ensured");
}

async function touchUser(userId, kind, displayName = null) {
  await pool.query(
    `
    INSERT INTO users (user_id, display_name, last_seen_at, last_liff_at)
    VALUES ($1, $2,
      CASE WHEN $3='seen' THEN now() ELSE NULL END,
      CASE WHEN $3='liff' THEN now() ELSE NULL END
    )
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      last_seen_at = CASE WHEN $3='seen' THEN now() ELSE users.last_seen_at END,
      last_liff_at = CASE WHEN $3='liff' THEN now() ELSE users.last_liff_at END,
      updated_at = now()
    `,
    [userId, displayName, kind]
  );

  await pool.query(
    `
    INSERT INTO segment_users (user_id, last_seen_at, last_liff_at)
    VALUES ($1,
      CASE WHEN $2='seen' THEN now() ELSE NULL END,
      CASE WHEN $2='liff' THEN now() ELSE NULL END
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at = CASE WHEN $2='seen' THEN now() ELSE segment_users.last_seen_at END,
      last_liff_at = CASE WHEN $2='liff' THEN now() ELSE segment_users.last_liff_at END
    `,
    [userId, kind]
  );
}

async function getAddressByUserId(userId) {
  const r = await pool.query(
    `SELECT member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
     FROM addresses WHERE user_id=$1`,
    [userId]
  );
  return r.rows[0] || null;
}

async function issueUniqueMemberCode() {
  for (let i = 0; i < 80; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const r = await pool.query(`SELECT 1 FROM addresses WHERE member_code=$1`, [code]);
    if (r.rowCount === 0) return code;
  }
  return String(Math.floor(10000 + Math.random() * 90000));
}

function makeAddressKey(a) {
  const s = [
    a?.postal || "",
    a?.prefecture || "",
    a?.city || "",
    a?.address1 || "",
    a?.address2 || "",
    a?.name || "",
    a?.phone || ""
  ].join("|").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);
}

async function upsertAddress(userId, addr) {
  let memberCode = (addr.member_code || "").trim();
  if (!memberCode) memberCode = await issueUniqueMemberCode();

  const addressKey = addr.address_key ? String(addr.address_key).trim() : makeAddressKey(addr);

  let saved;
  try {
    const q = `
      INSERT INTO addresses (user_id, member_code, name, phone, postal, prefecture, city, address1, address2, address_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (user_id) DO UPDATE SET
        member_code = EXCLUDED.member_code,
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        postal = EXCLUDED.postal,
        prefecture = EXCLUDED.prefecture,
        city = EXCLUDED.city,
        address1 = EXCLUDED.address1,
        address2 = EXCLUDED.address2,
        address_key = EXCLUDED.address_key,
        updated_at = now()
      RETURNING member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
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
      addressKey
    ]);
    saved = r.rows[0];
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("member_code") || msg.includes("duplicate key")) {
      const newCode = await issueUniqueMemberCode();
      const q2 = `
        INSERT INTO addresses (user_id, member_code, name, phone, postal, prefecture, city, address1, address2, address_key)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (user_id) DO UPDATE SET
          member_code = EXCLUDED.member_code,
          name = EXCLUDED.name,
          phone = EXCLUDED.phone,
          postal = EXCLUDED.postal,
          prefecture = EXCLUDED.prefecture,
          city = EXCLUDED.city,
          address1 = EXCLUDED.address1,
          address2 = EXCLUDED.address2,
          address_key = EXCLUDED.address_key,
          updated_at = now()
        RETURNING member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
      `;
      const r2 = await pool.query(q2, [
        userId,
        newCode,
        addr.name || "",
        addr.phone || "",
        addr.postal || "",
        addr.prefecture || "",
        addr.city || "",
        addr.address1 || "",
        addr.address2 || "",
        addressKey
      ]);
      saved = r2.rows[0];
    } else {
      throw e;
    }
  }

  return saved;
}

// ============== Build order from checkout (anti-tamper) ==============
async function buildOrderFromCheckout(uid, checkout) {
  const userId = String(uid || "").trim();
  if (!userId) {
    const err = new Error("uid required");
    err.code = "NO_UID";
    throw err;
  }

  const addr = await getAddressByUserId(userId);
  if (!addr) {
    const err = new Error("address not found");
    err.code = "NO_ADDRESS";
    throw err;
  }

  const products = await loadProducts();
  const productsById = Object.fromEntries(products.map(p => [p.id, p]));

  const inItems = Array.isArray(checkout?.items) ? checkout.items : [];
  const items = [];
  let subtotal = 0;

  for (const it of inItems) {
    const id = String(it?.id || "").trim();
    const qty = Math.max(0, Math.floor(Number(it?.qty || 0)));
    if (!id || qty <= 0) continue;

    const p = productsById[id];
    if (!p) continue;

    if (Number.isFinite(p.stock) && Number(p.stock) < qty) {
      const err = new Error(`在庫不足: ${p.name} (stock=${p.stock}, qty=${qty})`);
      err.code = "OUT_OF_STOCK";
      err.productId = id;
      throw err;
    }

    const price = Number(p.price || 0);
    const lineTotal = price * qty;
    subtotal += lineTotal;

    items.push({
      id: p.id,
      name: p.name,
      qty,
      price,
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

  const size = calcPackageSizeFromItems(items, productsById);
  const shippingFee = await calcShippingFee(pool, addr.prefecture, size);

  return { userId, addr, items, subtotal, shippingFee, size, productsById };
}

async function insertOrderToDb({ userId, items, total, shippingFee, paymentMethod, status, rawEvent }) {
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
      Number(total || 0),
      Number(shippingFee || 0),
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

// ============== LINE client ==============
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

// ============== Express ==============
const app = express();

// ============== Stripe (webhook must be before json parser) ==============
const stripe = (STRIPE_SECRET_KEY && Stripe) ? new Stripe(STRIPE_SECRET_KEY) : null;

function originFromReq(req) {
  return `${req.protocol}://${req.get("host")}`;
}
function stripeSuccessUrl(req) {
  if (STRIPE_SUCCESS_URL) return STRIPE_SUCCESS_URL;
  const base = BASE_URL || originFromReq(req);
  return `${base}/stripe-success.html`;
}
function stripeCancelUrl(req) {
  if (STRIPE_CANCEL_URL) return STRIPE_CANCEL_URL;
  const base = BASE_URL || originFromReq(req);
  return `${base}/stripe-cancel.html`;
}

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

// ここから通常JSON
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// =========================
// ★ liff-address 廃止 → cod-register へ転送（staticより先に置く）
// =========================
function redirectToCodRegister(req, res) {
  const q = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  const sep = q ? "?" : "";
  res.redirect(302, `/cod-register.html${sep}${q}`);
}
app.get("/liff-address.html", redirectToCodRegister);
app.get("/public/liff-address.html", redirectToCodRegister);
app.get("/address.html", redirectToCodRegister);
app.get("/public/address.html", redirectToCodRegister);
app.get("/address", (req, res) => res.redirect(302, "/cod-register.html"));

// confirm-cod 名称ゆれ吸収（必要なら）
app.get("/confirm_cod.html", (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));
app.get("/confirm-cod",      (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));

// ===== 静的配信（Cannot GET 撃退の肝） =====
app.use(express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/public/uploads", express.static(UPLOAD_DIR)); // 互換

// health
app.get("/health", (req, res) => res.json({ ok: true, time: nowISO() }));

// ============== Admin auth ==============
function requireAdmin(req, res, next) {
  if (!ADMIN_API_TOKEN) return res.status(403).json({ ok:false, error:"ADMIN_API_TOKEN is not set" });

  const token =
    (req.headers["x-admin-token"] ||
     req.headers["x-admin-api-token"] ||
     req.query.token ||
     "").toString().trim();

  if (token !== ADMIN_API_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

// ============== Products API ==============
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();
    const origin = originFromReq(req);

    const fixed = products.map(p => {
      let img = String(p.image || "").trim();
      if (!img) return p;

      img = img.replace(/^public\//, "");
      img = img.replace(/^uploads\//, "uploads/");
      img = img.replace(/^\/uploads\//, "uploads/");

      if (!/^https?:\/\//i.test(img)) {
        if (img.startsWith("uploads/")) img = "/" + img;
        else {
          if (img.startsWith("/")) img = img.slice(1);
          img = "/uploads/" + img;
        }
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

// ============== Admin products ==============
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const products = await loadProducts();
    res.json({ ok: true, products });
  } catch (e) {
    logErr("GET /api/admin/products", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

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

// 管理：アップロード済み画像一覧
app.get("/api/admin/images", requireAdmin, async (req, res) => {
  try {
    await ensureDir(UPLOAD_DIR);
    const files = await fsp.readdir(UPLOAD_DIR).catch(() => []);
    const images = files.filter(f => /\.(png|jpe?g|webp|gif)$/i.test(f)).sort((a,b)=>a.localeCompare(b,"en"));

    const base = BASE_URL || originFromReq(req);
    res.json({
      ok: true,
      images: images.map(name => ({
        name,
        url: `${base}/uploads/${encodeURIComponent(name)}`
      }))
    });
  } catch (e) {
    logErr("GET /api/admin/images", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 管理：画像アップロード（base64簡易）
app.post("/api/admin/upload-image", requireAdmin, async (req, res) => {
  try {
    const { contentBase64, filename, mime } = req.body || {};
    if (!contentBase64) return res.status(400).json({ ok: false, error: "contentBase64 required" });

    await ensureDir(UPLOAD_DIR);

    const ext =
      (mime && mime.includes("png"))  ? "png" :
      (mime && mime.includes("webp")) ? "webp" :
      (mime && (mime.includes("jpeg") || mime.includes("jpg"))) ? "jpg" : "png";

    const safeName = (filename ? String(filename) : "")
      .replace(/[^\w.\-]/g, "_")
      .replace(/\.+/g, ".")
      .slice(0, 80);

    const name = safeName || `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
    const buf = Buffer.from(String(contentBase64).replace(/^data:.*;base64,/, ""), "base64");
    const outPath = path.join(UPLOAD_DIR, name);
    await fsp.writeFile(outPath, buf);

    const base = BASE_URL || originFromReq(req);
    const url = `${base}/uploads/${encodeURIComponent(name)}`;
    res.json({ ok: true, name, url });
  } catch (e) {
    logErr("POST /api/admin/upload-image", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// LIFF config（cod-register.html 等が使用）
// ✅ env名ゆれ吸収：LIFF_ID_ADDRESS / LIFF_ID_COD / LIFF_ID_DEFAULT
// =========================
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();

  const orderId   = (LIFF_ID_ORDER || LIFF_ID_DEFAULT || "").trim();
  const addressId = (LIFF_ID_ADDRESS || LIFF_ID_COD || LIFF_ID_DEFAULT || "").trim();

  let liffId = "";
  if (kind === "address" || kind === "register" || kind === "cod") liffId = addressId;
  else liffId = orderId;

  if (!liffId) return res.status(400).json({ ok:false, error:"LIFF_ID_NOT_SET", kind });
  return res.json({ ok:true, liffId });
});

// ============== Address API (旧/現行) ==============
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
      address_key: b.address_key
    });

    res.json({ ok: true, address: saved });
  } catch (e) {
    logErr("POST /api/address/set", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =========================
// ★互換：cod-register.html 用（/api/liff/address/me, /api/liff/address）
// =========================
app.get("/api/liff/address/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });

    const addr = await getAddressByUserId(userId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok:true, address: addr });
  } catch (e) {
    logErr("GET /api/liff/address/me", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const address = req.body?.address || null;
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });
    if (!address) return res.status(400).json({ ok:false, error:"address required" });

    const saved = await upsertAddress(userId, {
      member_code: address.member_code,
      name: address.name,
      phone: address.phone,
      postal: address.postal,
      prefecture: address.prefecture,
      city: address.city,
      address1: address.address1,
      address2: address.address2,
      address_key: address.address_key
    });

    res.json({ ok:true, memberCode: saved?.member_code, address: saved });
  } catch (e) {
    logErr("POST /api/liff/address", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// id_token verify（任意）
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

    res.json({ ok: true, profile: data });
  } catch (e) {
    logErr("POST /api/liff/verify", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// LIFF 起動ログ（現行：/api/liff/opened）
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

// ★互換：/api/liff/open（cod-register.html が呼ぶ名前）
app.post("/api/liff/open", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });
    await touchUser(userId, "liff");
    res.json({ ok:true });
  } catch (e) {
    logErr("POST /api/liff/open", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ============== Payment / Orders ==============

// Stripe: create checkout session
app.post("/api/pay/stripe/create", async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok:false, error:"stripe_not_configured" });

    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout);

    const lineItems = built.items.map(it => ({
      price_data: {
        currency: "jpy",
        product_data: { name: `${it.name}${it.volume ? `（${it.volume}）` : ""}` },
        unit_amount: it.price,
      },
      quantity: it.qty,
    }));

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

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: built.subtotal + built.shippingFee,
      shippingFee: built.shippingFee,
      paymentMethod: "card",
      status: "new",
      rawEvent: { type: "checkout_create_v2" },
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: `${stripeSuccessUrl(req)}?orderId=${orderId}`,
      cancel_url: `${stripeCancelUrl(req)}?orderId=${orderId}`,
      metadata: { orderId: String(orderId), userId: built.userId },
    });

    res.json({
      ok: true,
      orderId,
      url: session.url,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      size: built.size,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/pay/stripe/create", code, e?.stack || e);

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 見積り（confirmで送料表示用）
app.post("/api/order/quote", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout);

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    res.json({
      ok: true,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee,
      totalCod,
      size: built.size,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/order/quote", code, e?.stack || e);

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 代引き：作成
app.post("/api/order/cod/create", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout);

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "new",
      rawEvent: { type: "cod_create_v2" },
    });

    res.json({
      ok: true,
      orderId,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee,
      totalCod,
      size: built.size,
      message: `代引き注文を受け付けました（注文ID: ${orderId}）`,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/order/cod/create", code, e?.stack || e);

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ✅ 追加：オリジナルセット専用（混載不可）代引き注文
app.post("/api/orders/original", async (req, res) => {
  try {
    const uid = String(req.body?.uid || req.body?.userId || "").trim();
    const cart = req.body?.cart || null;
    if (!uid) return res.status(400).json({ ok:false, error:"uid required" });
    if (!cart || !Array.isArray(cart.items)) return res.status(400).json({ ok:false, error:"cart.items required" });

    await touchUser(uid, "seen");

    // 混載不可を強制：1件だけ、かつ ORIGINAL_SET_PRODUCT_ID のみ
    const items = cart.items.filter(x => x && x.id && Number(x.qty) > 0);
    if (items.length !== 1) {
      return res.status(409).json({ ok:false, error:"MIX_NOT_ALLOWED" });
    }
    const it = items[0];
    const id = String(it.id || "").trim();
    const qty = Math.max(1, Math.floor(Number(it.qty || 1)));

    if (id !== ORIGINAL_SET_PRODUCT_ID) {
      return res.status(409).json({ ok:false, error:"NOT_ORIGINAL_SET" });
    }
    if (qty > 6) {
      return res.status(400).json({ ok:false, error:"QTY_TOO_LARGE", max: 6 });
    }

    const built = await buildOrderFromCheckout(uid, { items: [{ id, qty }] });

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "confirmed",
      rawEvent: { type: "original_set_cod" },
    });

    // 注文者/管理者へPush（任意）
    const a = built.addr;
    const addrText = `〒${a.postal || ""} ${a.prefecture || ""}${a.city || ""}${a.address1 || ""} ${a.address2 || ""}`.trim();
    const itemLines = built.items.map(x => `・${x.name} × ${x.qty}（${x.price}円）`).join("\n");

    const msgForUser =
      `ご注文ありがとうございます。\n` +
      `【注文ID】${orderId}\n\n` +
      `【内容】\n${itemLines}\n\n` +
      `【送料】ヤマト ${built.size}サイズ：${built.shippingFee}円\n` +
      `【代引手数料】${codFee}円\n` +
      `【合計】${totalCod}円\n\n` +
      `【お届け先】\n${addrText}\n\n` +
      `住所変更：\n${liffUrl("/cod-register.html")}`;

    try { await lineClient.pushMessage(built.userId, { type:"text", text: msgForUser }); } catch(e) {
      logErr("push to user failed", e?.message || e);
    }

    if (ADMIN_USER_ID) {
      const msgForAdmin =
        `【新規注文】オリジナルセット\n` +
        `注文ID: ${orderId}\n` +
        `userId: ${built.userId}\n\n` +
        `${itemLines}\n\n` +
        `送料: ${built.shippingFee}円（${built.size}）\n` +
        `代引手数料: ${codFee}円\n` +
        `合計: ${totalCod}円\n\n` +
        `お届け先:\n${a.name || ""}\n${addrText}\nTEL:${a.phone || ""}`;
      try { await lineClient.pushMessage(ADMIN_USER_ID, { type:"text", text: msgForAdmin }); } catch(e) {
        logErr("push to admin failed", e?.message || e);
      }
    }

    res.json({
      ok: true,
      orderId,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee,
      totalCod,
      size: built.size,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/orders/original", code, e?.stack || e);

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 代引き確定 → confirm-cod.html へ（必要なら使う）
app.post("/api/order/cod/confirm", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout);

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "confirmed",
      rawEvent: { type: "cod_confirm_v1" },
    });

    res.json({
      ok: true,
      orderId,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee,
      totalCod,
      size: built.size,
      redirect: `/confirm-cod.html?orderId=${encodeURIComponent(orderId)}`
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/order/cod/confirm", code, e?.stack || e);

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 注文ステータス確認
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
    logErr("GET /api/order/status", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ============== Segment / blast admin ==============
app.post("/api/admin/segment/fill", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.body?.segment_key || "").trim();
    const mode = String(req.body?.mode || "yesterday_liff").trim();
    if (!segmentKey) return res.status(400).json({ ok:false, error:"segment_key required" });

    let inserted = 0;

    if (mode === "yesterday_liff") {
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
      return res.status(400).json({ ok:false, error:"unknown mode" });
    }

    res.json({ ok:true, inserted });
  } catch (e) {
    logErr("POST /api/admin/segment/fill", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.get("/api/admin/segment/count", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.query.segment_key || "").trim();
    if (!segmentKey) return res.status(400).json({ ok:false, error:"segment_key required" });

    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM segment_blast WHERE segment_key=$1`, [segmentKey]);
    res.json({ ok:true, count: r.rows[0]?.n || 0 });
  } catch (e) {
    logErr("GET /api/admin/segment/count", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.post("/api/admin/blast/once", requireAdmin, async (req, res) => {
  try {
    const segmentKey = String(req.body?.segment_key || "").trim();
    const messages = req.body?.messages || [{ type:"text", text:"配信テスト" }];
    if (!segmentKey) return res.status(400).json({ ok:false, error:"segment_key required" });

    const r = await pool.query(`SELECT user_id FROM segment_blast WHERE segment_key=$1 ORDER BY created_at ASC`, [segmentKey]);
    const userIds = r.rows.map(x => x.user_id).filter(Boolean);

    let sent = 0;
    for (let i = 0; i < userIds.length; i += 500) {
      const chunk = userIds.slice(i, i + 500);
      await lineClient.multicast(chunk, messages);
      sent += chunk.length;
    }

    res.json({ ok:true, sent });
  } catch (e) {
    logErr("POST /api/admin/blast/once", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ============== LINE Webhook ==============
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

function liffUrl(pathname, reqForFallback = null) {
  const base = LIFF_BASE || (reqForFallback ? originFromReq(reqForFallback) : "");
  if (!base) return pathname;
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return base + pathname;
}

async function handleEvent(ev) {
  const type = ev.type;
  const userId = ev?.source?.userId || "";

  if (userId) {
    try { await touchUser(userId, "seen"); } catch {}
  }

  if (type === "follow") return onFollow(ev);
  if (type === "unfollow") return onUnfollow(ev);

  if (type === "message" && ev.message?.type === "text") return onTextMessage(ev);
  if (type === "postback") return onPostback(ev);
}

async function onFollow(ev) {
  const userId = ev?.source?.userId || "";
  if (!userId) return;

  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
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

  let displayName = null;
  try {
    const prof = await lineClient.getProfile(userId);
    displayName = prof?.displayName || null;
  } catch {}
  try { await touchUser(userId, "seen", displayName); } catch {}

  const urlProducts = liffUrl("/products.html");
  const urlAddress  = liffUrl("/cod-register.html");

  await lineClient.pushMessage(userId, {
    type: "text",
    text:
      "友だち追加ありがとうございます！\n\n" +
      `・「${KEYWORD_DIRECT}」でミニアプリ注文\n` +
      `・「${KEYWORD_KUSUKE}」で久助の注文\n\n` +
      "住所登録がまだの場合は、ミニアプリ内の「住所登録」からお願いします。\n\n" +
      `商品一覧：\n${urlProducts}\n\n住所登録：\n${urlAddress}`,
  });
}

async function onUnfollow() {
  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
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

async function onPostback() {
  // 必要なら拡張
}

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

  // 起動キーワード2つだけ
  if (text === KEYWORD_DIRECT) {
    setSession(userId, { kind: "direct", step: "start" });
    await replyDirectStart(ev.replyToken);
    return;
  }

  if (text.startsWith(KEYWORD_KUSUKE)) {
    const m = text.match(/^久助\s*([0-9]+)?/);
    const qty = m && m[1] ? Number(m[1]) : null;

    setSession(userId, { kind: "kusuke", step: "ask_qty", presetQty: qty || null });
    await replyKusukeStart(ev.replyToken, userId, qty);
    return;
  }

  // それ以外は無反応（要望）
}

async function replyDirectStart(replyToken) {
  const urlProducts = liffUrl("/products.html");
  const urlAddress  = liffUrl("/cod-register.html");
  await lineClient.replyMessage(replyToken, {
    type: "text",
    text: `ミニアプリで注文できます：\n${urlProducts}\n\n住所登録：\n${urlAddress}`
  });
}

async function replyKusukeStart(replyToken, userId, qtyPreset) {
  const addr = await getAddressByUserId(userId);
  if (!addr) {
    const url = liffUrl("/cod-register.html");
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
    await finalizeKusukeOrder(replyToken, userId, qtyPreset);
    clearSession(userId);
    return;
  }

  await lineClient.replyMessage(replyToken, { type:"text", text:"久助の個数を数字で送ってください。\n例：3" });
  setSession(userId, { kind: "kusuke", step: "wait_qty" });
}

async function handleSessionInput(userId, text, ev) {
  const sess = getSession(userId);
  if (!sess) return;

  if (sess.kind === "kusuke" && sess.step === "wait_qty") {
    const qty = Number(text);
    if (!Number.isFinite(qty) || qty <= 0) {
      await lineClient.replyMessage(ev.replyToken, { type:"text", text:"数字（例：3）で送ってください。" });
      return;
    }
    await finalizeKusukeOrder(ev.replyToken, userId, qty);
    clearSession(userId);
    return;
  }
}

async function finalizeKusukeOrder(replyToken, userId, qty) {
  try {
    const products = await loadProducts();
    const kusuke = products.find(p => (p.name || "").includes("久助") || (p.id || "").includes("kusuke"));
    if (!kusuke) {
      await lineClient.replyMessage(replyToken, { type:"text", text:"久助の商品が products.json に見つかりませんでした。" });
      return;
    }

    const fakeCheckout = { items: [{ id: kusuke.id, qty }] };
    const built = await buildOrderFromCheckout(userId, fakeCheckout);

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "confirmed",
      rawEvent: { type: "line_kusuke" },
    });

    const a = built.addr;
    const addrText =
      `〒${a.postal || ""} ${a.prefecture || ""}${a.city || ""}${a.address1 || ""} ${a.address2 || ""}`.trim();

    await lineClient.replyMessage(replyToken, {
      type:"text",
      text:
        `久助 注文を受け付けました（注文ID: ${orderId}）\n\n` +
        `【内容】\n${kusuke.name} × ${qty}\n単価：${kusuke.price}円\n\n` +
        `【送料】ヤマト ${built.size}サイズ：${built.shippingFee}円\n` +
        `【代引手数料】${codFee}円\n\n` +
        `【合計（代引）】${totalCod}円\n\n` +
        `【お届け先】\n${addrText}\n\n` +
        `住所変更：\n${liffUrl("/cod-register.html")}`
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("finalizeKusukeOrder", code, e?.stack || e);

    if (code === "NO_ADDRESS") {
      await lineClient.replyMessage(replyToken, { type:"text", text:`住所が未登録です。\n${liffUrl("/cod-register.html")}` });
      return;
    }
    if (code === "OUT_OF_STOCK") {
      await lineClient.replyMessage(replyToken, { type:"text", text:"在庫が不足しています。個数を減らして試してください。" });
      return;
    }
    await lineClient.replyMessage(replyToken, { type:"text", text:"エラーが発生しました。時間をおいて再度お試しください。" });
  }
}

// ============== Boot ==============
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
