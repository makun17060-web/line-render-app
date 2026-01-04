/**
 * server.js — 追記版 “完全・全部入り” 丸ごと版（修正版）
 *
 * ✅ 今回の修正（あなたの依頼）
 * - 「直接注文」ボット起動をポストバックで動作させる
 *   postback: action=direct_order で replyDirectStart() を起動
 * - onPostback(ev) を実装（今まで空＆引数なしだった）
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

// =========================
// ✅ ENV
// =========================
const env = process.env;

// ---- required
const LINE_CHANNEL_ACCESS_TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = env.LINE_CHANNEL_SECRET;
const DATABASE_URL              = env.DATABASE_URL;

// ---- optional
const PUBLIC_BASE_URL  = env.PUBLIC_BASE_URL;
const LIFF_BASE_URL    = env.LIFF_BASE_URL;
const LIFF_CHANNEL_ID  = env.LIFF_CHANNEL_ID;

const LIFF_ID_DEFAULT  = (env.LIFF_ID_DEFAULT || "").trim();
const LIFF_ID_ORDER    = (env.LIFF_ID_ORDER   || "").trim();
const LIFF_ID_ADDRESS  = (env.LIFF_ID_ADDRESS || "").trim();
const LIFF_ID_ADD      = (env.LIFF_ID_ADD || "").trim();
const LIFF_ID_COD      = (env.LIFF_ID_COD  || "").trim();

const DATA_DIR   = env.DATA_DIR   || "/var/data";
const UPLOAD_DIR = env.UPLOAD_DIR || "/var/data/uploads";

const ADMIN_API_TOKEN = env.ADMIN_API_TOKEN || "";
const ADMIN_CODE      = env.ADMIN_CODE || "";
const ADMIN_USER_ID   = env.ADMIN_USER_ID || "";

const STRIPE_SECRET_KEY     = env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_SUCCESS_URL    = env.STRIPE_SUCCESS_URL || "";
const STRIPE_CANCEL_URL     = env.STRIPE_CANCEL_URL || "";

const COD_FEE = env.COD_FEE || "330";

const KEYWORD_DIRECT = env.KEYWORD_DIRECT || "直接注文";
const KEYWORD_KUSUKE = env.KEYWORD_KUSUKE || "久助";

const ORIGINAL_SET_PRODUCT_ID = (env.ORIGINAL_SET_PRODUCT_ID || "original-set-2000").trim();

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const BASE_URL = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
const LIFF_BASE = (LIFF_BASE_URL || BASE_URL || "").replace(/\/$/, "");

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

// サイズ別 送料（税込の例）※フォールバック（DBが無い/空の時だけ使う）
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

function nowJstString() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); }

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
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return fallback; }
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
    { id: "kusuke-250", name: "久助（われせん）", price: 250, stock: 30, volume: "100g", desc: "お得な割れせん。価格は管理画面で自由に変更できます。", image: "" },
    { id: "nori-akasha-340", name: "のりあかしゃ", price: 340, stock: 20, volume: "80g", desc: "海苔の風味。", image: "" },
    { id: ORIGINAL_SET_PRODUCT_ID, name: "磯屋オリジナルセット", price: 2100, stock: 50, volume: "セット", desc: "人気の詰め合わせ。", image: "" }
  ];

  await writeJsonAtomic(PRODUCTS_FILE, seed);
  logInfo("products.json created:", PRODUCTS_FILE);
}
async function loadProducts() {
  await ensureProductsFile();
  const arr = await readJsonSafe(PRODUCTS_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
async function saveProducts(products) { await writeJsonAtomic(PRODUCTS_FILE, products); }

// ============== sessions (Map + Disk) ==============
const sessions = new Map();
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
  return 140;
}

function detectRegionFromPref(prefecture) {
  const pref = (prefecture || "").trim();
  return SHIPPING_REGION_BY_PREF[pref] || "chubu";
}

// ✅ 送料DBキャッシュ（5分）
const shippingCache = { loadedAt: 0, map: new Map() };
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
      const size = Number(row.size);
      const fee = Number(row.fee);
      if (!region || !Number.isInteger(size)) continue;
      m.set(cacheKey(region, size), Number.isFinite(fee) ? fee : 0);
    }
    shippingCache.map = m;
    shippingCache.loadedAt = now;
  } catch {
    // ignore
  }
}

async function calcShippingFee(pool, prefecture, size) {
  const region = detectRegionFromPref(prefecture);
  const s = Number(size || 0) || 80;

  await reloadShippingCacheIfNeeded(pool);
  const ck = cacheKey(region, s);
  if (shippingCache.map.has(ck)) return Number(shippingCache.map.get(ck));

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

  try {
    const safeRegion = region.replace(/[^a-z0-9_]/gi, "");
    const table = `shipping_yamato_${safeRegion}_taxed`;
    const r2 = await pool.query(`SELECT fee FROM ${table} WHERE size=$1 LIMIT 1`, [s]);
    if (r2.rowCount > 0) return Number(r2.rows[0]?.fee || 0);
  } catch {}

  const table = SHIPPING_YAMATO[region] || SHIPPING_YAMATO["chubu"];
  return Number(table[s] || table[80] || 0);
}

function calcPackageSizeFromItems(items, productsById) {
  let hasOriginalSet = false;
  let originalQty = 0;

  let smallCount = 0;
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

  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_id_uidx ON addresses(user_id) WHERE user_id IS NOT NULL;`); } catch(e){ logErr("addresses_user_id_uidx failed", e?.message||e); }
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_member_code_uidx ON addresses(member_code) WHERE member_code IS NOT NULL;`); } catch(e){ logErr("addresses_member_code_uidx failed", e?.message||e); }
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_address_key_uidx ON addresses(address_key) WHERE address_key IS NOT NULL;`); } catch(e){ logErr("addresses_address_key_uidx failed", e?.message||e); }

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

  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`); }
  catch (e) { logErr("ALTER TABLE orders notified_at failed", e?.message || e); }

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_yamato_taxed (
      region TEXT NOT NULL,
      size   INTEGER NOT NULL,
      fee    INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(region, size)
    );
  `);

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

function originFromReq(req) { return `${req.protocol}://${req.get("host")}`; }
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
function liffUrl(pathname, reqForFallback = null) {
  const base = LIFF_BASE || (reqForFallback ? originFromReq(reqForFallback) : "");
  if (!base) return pathname;
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return base + pathname;
}

// =========================
// ★★ 注文完了通知（統一実装）
// =========================
function yen(n) {
  const x = Number(n || 0);
  return `${x.toLocaleString("ja-JP")}円`;
}
function joinAddrText(a) {
  if (!a) return "";
  const line1 = `〒${a.postal || ""} ${a.prefecture || ""}${a.city || ""}${a.address1 || ""} ${a.address2 || ""}`.trim();
  const line2 = `${a.name || ""}`.trim();
  const line3 = a.phone ? `TEL:${a.phone}` : "";
  return [line2, line1, line3].filter(Boolean).join("\n");
}
function buildItemLines(items) {
  return (items || []).map(x => {
    const v = x.volume ? `（${x.volume}）` : "";
    return `・${x.name}${v} × ${x.qty}（${yen(x.price)}）`;
  }).join("\n");
}
async function pushTextSafe(to, text) {
  if (!to) return;
  try {
    await lineClient.pushMessage(to, { type: "text", text: String(text || "") });
  } catch (e) {
    logErr("pushTextSafe failed", to, e?.message || e);
  }
}

// ====== friend notify functions（あなたの元コードのまま） ======
async function notifyAdminFriendAdded({ userId, displayName, day }) {
  if (!ADMIN_USER_ID) return;

  let todayCounts = null;
  try {
    const r = await pool.query(`SELECT added_count, blocked_count FROM friend_logs WHERE day=$1`, [day]);
    if (r.rowCount > 0) todayCounts = r.rows[0];
  } catch {}

  const name = displayName ? `「${displayName}」` : "（表示名取得不可）";
  const counts = todayCounts
    ? `\n今日の累計：追加 ${Number(todayCounts.added_count || 0)} / ブロック ${Number(todayCounts.blocked_count || 0)}`
    : "";

  const msg =
    `【友だち追加】\n` +
    `日時：${nowJstString()}\n` +
    `表示名：${name}\n` +
    `userId：${userId}` +
    counts;

  await pushTextSafe(ADMIN_USER_ID, msg);
}

async function notifyAdminFriendBlocked({ userId, displayName, day }) {
  if (!ADMIN_USER_ID) return;

  let todayCounts = null;
  try {
    const r = await pool.query(`SELECT added_count, blocked_count FROM friend_logs WHERE day=$1`, [day]);
    if (r.rowCount > 0) todayCounts = r.rows[0];
  } catch {}

  const name = displayName ? `「${displayName}」` : "（表示名不明：DB未保存の可能性）";
  const counts = todayCounts
    ? `\n今日の累計：追加 ${Number(todayCounts.added_count || 0)} / ブロック ${Number(todayCounts.blocked_count || 0)}`
    : "";

  const msg =
    `【ブロック（解除）】\n` +
    `日時：${nowJstString()}\n` +
    `表示名：${name}\n` +
    `userId：${userId}` +
    counts;

  await pushTextSafe(ADMIN_USER_ID, msg);
}

async function getOrderRow(orderId) {
  const r = await pool.query(
    `SELECT id, user_id, items, total, shipping_fee, payment_method, status, notified_at, created_at
     FROM orders WHERE id=$1`,
    [orderId]
  );
  return r.rows[0] || null;
}
async function markOrderNotified(orderId) {
  try {
    await pool.query(`UPDATE orders SET notified_at=now() WHERE id=$1 AND notified_at IS NULL`, [orderId]);
  } catch (e) {
    logErr("markOrderNotified failed", orderId, e?.message || e);
  }
}

async function notifyOrderCompleted({
  orderId,
  userId,
  items,
  shippingFee,
  total,
  paymentMethod,
  codFee = 0,
  size = null,
  addr = null,
  title = "新規注文",
  isPaid = false,
}) {
  const row = await getOrderRow(orderId);
  if (row?.notified_at) {
    logInfo("notify skipped (already notified):", orderId);
    return { ok: true, skipped: true };
  }

  const a = addr || (await getAddressByUserId(userId).catch(()=>null));
  const addrText = joinAddrText(a);

  let computedSize = size;
  if (!computedSize) {
    try {
      const products = await loadProducts();
      const productsById = Object.fromEntries(products.map(p => [p.id, p]));
      computedSize = calcPackageSizeFromItems(items || [], productsById);
    } catch {}
  }

  const itemLines = buildItemLines(items || []);
  const shipLine = (computedSize ? `ヤマト ${computedSize}サイズ` : "ヤマト") + `：${yen(shippingFee)}`;

  const payLabel = paymentMethod === "card" ? "クレジット" : "代引";
  const paidLine = paymentMethod === "card"
    ? (isPaid ? "決済：完了" : "決済：未完了")
    : "支払い：代引（到着時）";

  const msgForUser =
    `ご注文ありがとうございます。\n` +
    `【注文ID】${orderId}\n` +
    `【支払い】${payLabel}\n` +
    `${paidLine}\n\n` +
    `【内容】\n${itemLines}\n\n` +
    `【送料】${shipLine}\n` +
    (paymentMethod === "cod" ? `【代引手数料】${yen(codFee)}\n` : "") +
    `【合計】${yen(total)}\n\n` +
    (addrText ? `【お届け先】\n${addrText}\n\n` : "") +
    `住所変更：\n${liffUrl("/cod-register.html")}`;

  await pushTextSafe(userId, msgForUser);

  if (ADMIN_USER_ID) {
    const msgForAdmin =
      `【${title}】\n` +
      `注文ID: ${orderId}\n` +
      `userId: ${userId}\n` +
      `支払い: ${payLabel}${paymentMethod === "card" ? (isPaid ? "（決済完了）" : "（未決済）") : ""}\n\n` +
      `${itemLines}\n\n` +
      `送料: ${yen(shippingFee)}${computedSize ? `（${computedSize}）` : ""}\n` +
      (paymentMethod === "cod" ? `代引手数料: ${yen(codFee)}\n` : "") +
      `合計: ${yen(total)}\n\n` +
      (addrText ? `お届け先:\n${addrText}` : "お届け先:（住所未取得）");
    await pushTextSafe(ADMIN_USER_ID, msgForAdmin);
  }

  await markOrderNotified(orderId);
  return { ok: true };
}

// Stripe webhook（raw 必須）
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
      const userId  = session?.metadata?.userId;

      if (orderId) {
        await pool.query(`UPDATE orders SET status='paid' WHERE id=$1`, [orderId]);
        logInfo("Order paid:", orderId);

        const row = await getOrderRow(orderId);
        if (row) {
          const items = Array.isArray(row.items) ? row.items : (row.items || []);
          await notifyOrderCompleted({
            orderId: row.id,
            userId: row.user_id || userId || "",
            items,
            shippingFee: row.shipping_fee,
            total: row.total,
            paymentMethod: row.payment_method || "card",
            codFee: 0,
            title: "新規注文（カード）",
            isPaid: true,
          });
        }
      }
    }

    res.json({ received: true });
  } catch (e) {
    logErr("POST /stripe/webhook", e?.stack || e);
    res.status(500).send("server_error");
  }
});

// ここから通常JSON
app.use("/webhook", express.raw({ type: "*/*" }));
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t0}ms)`);
  });
  next();
});
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// favicon 404 を消す
app.get("/favicon.ico", (req, res) => res.status(204).end());

// address.html など（あなたの元コード維持）
app.get("/address.html", (req, res) => res.sendFile(path.join(__dirname, "public", "address.html")));
app.get("/public/address.html", (req, res) => {
  const q = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  res.redirect(302, `/address.html${q ? "?" + q : ""}`);
});
app.get("/address", (req, res) => {
  const q = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  res.redirect(302, `/address.html${q ? "?" + q : ""}`);
});
function redirectToAddress(req, res) {
  const q = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
  res.redirect(302, `/address.html${q ? "?" + q : ""}`);
}
app.get("/liff-address.html", redirectToAddress);
app.get("/public/liff-address.html", redirectToAddress);

app.get("/confirm_cod.html", (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));
app.get("/confirm-cod",      (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));

// 静的配信
app.use(express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/public/uploads", express.static(UPLOAD_DIR));

app.get("/health", (req, res) => res.json({ ok: true, time: nowISO() }));

// =========================
// ✅ Admin auth
// =========================
const ADMIN_TOKEN = (ADMIN_API_TOKEN || ADMIN_CODE || "").trim();
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ ok:false, error:"ADMIN_API_TOKEN is not set" });

  const token =
    (req.headers["x-admin-token"] ||
     req.headers["x-admin-api-token"] ||
     req.query.token ||
     "").toString().trim();

  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

/* =========================
   （ここから下：あなたの元コードの API 群はそのまま）
   ・・・長いので「省略」せずに入れてもいいけど、
   今回の目的は postback 対応なので、必要なら
   “あなたが貼った続き全部”をこの下にそのまま残してください。
   ========================= */

// --- ここから「あなたの貼ったまま」の各API（admin/orders など）を続ける ---
// （省略：あなたの元のままでOK）

/* =========================
   ✅ ここが今回の本題：LINE Webhook
   ========================= */

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  const events = req.body?.events || [];
  res.status(200).end();

  for (const ev of events) {
    try { await handleEvent(ev); }
    catch (e) { logErr("handleEvent failed", e?.stack || e); }
  }
});

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

/**
 * ✅ 追加：postback 対応（今回の目的）
 * - action=direct_order で「直接注文」と同じ replyDirectStart() を起動
 * - action=pickup_start も例として返信（必要に応じて）
 */
async function onPostback(ev) {
  const userId = ev?.source?.userId || "";
  const data = String(ev?.postback?.data || "");
  if (!userId || !data) return;

  const params = new URLSearchParams(data);
  const action = String(params.get("action") || "").trim();

  // ✅ 直接注文（ポストバック起動）
  if (action === "direct_order" || action === "direct_start" || action === "order_start") {
    setSession(userId, { kind: "direct", step: "start" });
    await replyDirectStart(ev.replyToken);
    return;
  }

  // ✅ 店頭受取（あなたのリッチメニューに合わせた）
  if (action === "pickup_start") {
    // ここは運用に合わせて自由に書き換えてOK
    await lineClient.replyMessage(ev.replyToken, {
      type: "text",
      text:
        "店頭受取ですね！\n\n" +
        "（ここに店頭受取の手順や営業時間、来店予約URLなどを入れてください）"
    });
    return;
  }

  // その他は無視でOK
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

  try { await notifyAdminFriendAdded({ userId, displayName, day }); }
  catch (e) { logErr("notifyAdminFriendAdded failed", e?.message || e); }

  const urlProducts = "https://liff.line.me/2008406620-8CWfgEKh";
  const urlAddress  = "https://liff.line.me/2008406620-4QJ06JLv";

  await lineClient.pushMessage(userId, {
    type: "text",
    text:
      "友だち追加ありがとうございます！\n\n" +
      `・「${KEYWORD_DIRECT}」でミニアプリ注文\n` +
      `・「${KEYWORD_KUSUKE}」で久助の注文\n\n` +
      "住所登録がまだの場合は、ミニアプリ内の「住所登録」からお願いします。\n\n" +
      `商品一覧：\n${urlProducts}\n\n住所登録：\n${urlAddress}`
  });
}

async function onUnfollow(ev) {
  const userId = ev?.source?.userId || "";
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

  if (userId) {
    let displayName = null;
    try {
      const r = await pool.query(`SELECT display_name FROM users WHERE user_id=$1`, [userId]);
      displayName = r.rows?.[0]?.display_name || null;
    } catch {}

    try { await notifyAdminFriendBlocked({ userId, displayName, day }); }
    catch (e) { logErr("notifyAdminFriendBlocked failed", e?.message || e); }
  }
}

async function onTextMessage(ev) {
  const userId = ev?.source?.userId || "";
  const text = (ev.message?.text || "").trim();
  if (!userId || !text) return;

  const sess = getSession(userId);
  if (sess) {
    await handleSessionInput(userId, text, ev);
    return;
  }

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

  // それ以外は無反応
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

    await notifyOrderCompleted({
      orderId,
      userId,
      items: built.items,
      shippingFee: built.shippingFee,
      total: totalCod,
      paymentMethod: "cod",
      codFee,
      size: built.size,
      addr: built.addr,
      title: "新規注文（久助/代引）",
      isPaid: false,
    });

    await lineClient.replyMessage(replyToken, {
      type:"text",
      text: `久助 注文を受け付けました（注文ID: ${orderId}）`
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

  const port = Number(env.PORT || 3000);
  app.listen(port, () => logInfo(`server started on :${port}`));
}

main().catch(e => {
  logErr("BOOT FAIL", e?.stack || e);
  process.exit(1);
});
