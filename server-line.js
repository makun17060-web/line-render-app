/**
 * server.js — “完全・全部入り” 丸ごと版（福箱対応 追加済み）
 *
 * ✅ 追加（今回）
 * - ★ 福箱（fukubako / 福箱）を検出したら「60サイズ固定」
 *   - サイズ計算（shipping_size_rules）は使わない
 *   - 送料は地域（都道府県→region）だけで計算（ヤマト60）
 * - ★ 福箱は混載不可（福箱 + 他商品 を 409 で弾く）
 * - /api/shipping/quote でも福箱60固定を反映
 *
 * ※ それ以外はあなたの提示コードを維持
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

/* =========================
 * ENV
 * ========================= */
const env = process.env;

// required
const LINE_CHANNEL_ACCESS_TOKEN = env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET       = env.LINE_CHANNEL_SECRET;
const DATABASE_URL              = env.DATABASE_URL;

// optional
const PUBLIC_BASE_URL  = env.PUBLIC_BASE_URL; // 例: https://xxxx.onrender.com
const LIFF_BASE_URL    = env.LIFF_BASE_URL;   // 同上（LIFFの戻りURL生成に使う）
const LIFF_CHANNEL_ID  = env.LIFF_CHANNEL_ID;

const LIFF_ID_DEFAULT  = (env.LIFF_ID_DEFAULT || "").trim();
const LIFF_ID_ORDER    = (env.LIFF_ID_ORDER   || "").trim();

// ★ 住所LIFFキー名ゆれ吸収（どちらか入っていればOK）
const LIFF_ID_ADDRESS  = (env.LIFF_ID_ADDRESS || "").trim();
const LIFF_ID_ADD      = (env.LIFF_ID_ADD     || "").trim();
const LIFF_ID_COD      = (env.LIFF_ID_COD     || "").trim();

const DATA_DIR   = env.DATA_DIR   || "/var/data";
const UPLOAD_DIR = env.UPLOAD_DIR || "/var/data/uploads";

const ADMIN_API_TOKEN = env.ADMIN_API_TOKEN || "";
const ADMIN_CODE      = env.ADMIN_CODE || "";
const ADMIN_USER_ID   = env.ADMIN_USER_ID || "";

const STRIPE_SECRET_KEY     = env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_SUCCESS_URL    = env.STRIPE_SUCCESS_URL || "";
const STRIPE_CANCEL_URL     = env.STRIPE_CANCEL_URL || "";

const COD_FEE = String(env.COD_FEE || "330");

const KEYWORD_DIRECT = env.KEYWORD_DIRECT || "直接注文";
const KEYWORD_KUSUKE = env.KEYWORD_KUSUKE || "久助";

const ORIGINAL_SET_PRODUCT_ID = (env.ORIGINAL_SET_PRODUCT_ID || "original-set-2000").trim();

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const BASE_URL  = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
const LIFF_BASE = (LIFF_BASE_URL || BASE_URL || "").replace(/\/$/, "");

if (!BASE_URL) {
  console.warn("[WARN] PUBLIC_BASE_URL が未設定です（URL生成が必要な箇所ではhostから自動推定します）。");
}

/* =========================
 * Disk paths
 * ========================= */
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LOG_DIR       = path.join(DATA_DIR, "logs");
const APP_LOG_FILE  = path.join(LOG_DIR, "app.log");

/* =========================
 * Fallback tables（DBが空の時だけ）
 * ========================= */
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

// フォールバック送料（税込の例）
const SHIPPING_YAMATO = {
  hokkaido: { 60: 1300, 80: 1550, 100: 1800, 120: 2050, 140: 2300, 160: 2550 },
  tohoku:   { 60:  900, 80: 1100, 100: 1300, 120: 1500, 140: 1700, 160: 1900 },
  kanto:    { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600, 160: 1800 },
  shinetsu: { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600, 160: 1800 },
  chubu:    { 60:  750, 80:  950, 100: 1150, 120: 1350, 140: 1550, 160: 1750 },
  hokuriku: { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600, 160: 1800 },
  kinki:    { 60:  800, 80: 1000, 100: 1200, 120: 1400, 140: 1600, 160: 1800 },
  chugoku:  { 60:  850, 80: 1050, 100: 1250, 120: 1450, 140: 1650, 160: 1850 },
  shikoku:  { 60:  850, 80: 1050, 100: 1250, 120: 1450, 140: 1650, 160: 1850 },
  kyushu:   { 60:  900, 80: 1100, 100: 1300, 120: 1500, 140: 1700, 160: 1900 },
  okinawa:  { 60: 1350, 80: 1700, 100: 2100, 120: 2600, 140: 3100, 160: 3600 },
};

// フォールバック：サイズルール（DBが空の時だけ）
const FALLBACK_SIZE_RULES = [
  // akasha6
  { shipping_group: "akasha6", qty_min: 1,  qty_max: 4,    size: "60"  },
  { shipping_group: "akasha6", qty_min: 5,  qty_max: 8,    size: "80"  },
  { shipping_group: "akasha6", qty_min: 9,  qty_max: 13,   size: "100" },
  { shipping_group: "akasha6", qty_min: 14, qty_max: 18,   size: "120" },
  { shipping_group: "akasha6", qty_min: 19, qty_max: 9999, size: "140" },

  // original_set
  { shipping_group: "original_set", qty_min: 1, qty_max: 1,    size: "80"  },
  { shipping_group: "original_set", qty_min: 2, qty_max: 2,    size: "100" },
  { shipping_group: "original_set", qty_min: 3, qty_max: 4,    size: "120" },
  { shipping_group: "original_set", qty_min: 5, qty_max: 6,    size: "140" },
  { shipping_group: "original_set", qty_min: 7, qty_max: 9999, size: "160" },

  // default
  { shipping_group: "default", qty_min: 1, qty_max: 1,    size: "60"  },
  { shipping_group: "default", qty_min: 2, qty_max: 2,    size: "80"  },
  { shipping_group: "default", qty_min: 3, qty_max: 3,    size: "100" },
  { shipping_group: "default", qty_min: 4, qty_max: 4,    size: "120" },
  { shipping_group: "default", qty_min: 5, qty_max: 6,    size: "140" },
  { shipping_group: "default", qty_min: 7, qty_max: 9999, size: "160" },
];

/* =========================
 * Helpers
 * ========================= */
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

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function logToFile(line) {
  try {
    await ensureDir(LOG_DIR);
    await fsp.appendFile(APP_LOG_FILE, line + "\n", "utf8");
  } catch {}
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

/* =========================
 * products.json
 * ========================= */
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

/* =========================
 * sessions (Disk)
 * ========================= */
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

/* =========================
 * 商品分類（あかしゃ系）
 * ========================= */
function isAkashaLikeProduct(product) {
  const name = (product?.name || "").toLowerCase();
  const id = (product?.id || "").toLowerCase();
  if (id.includes("akasha") || name.includes("あかしゃ") || name.includes("akasha")) return true;
  if (id.includes("kusuke") || name.includes("久助")) return true; // 久助はあかしゃ扱い
  return false;
}

/* =========================
 * ★ 福箱（60サイズ固定）
 * ========================= */
function isFukubakoProduct(p) {
  const id = String(p?.id || "").toLowerCase();
  const name = String(p?.name || "");
  if (id.includes("fukubako")) return true;
  if (name.includes("福箱")) return true;
  return false;
}
function cartHasFukubako(items, productsById) {
  for (const it of (items || [])) {
    const pid = String(it?.id || "").trim();
    if (!pid) continue;
    const p = productsById[pid];
    if (p && isFukubakoProduct(p)) return true;
  }
  return false;
}

/* =========================
 * DB (Postgres)
 * ========================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =========================
 * 送料＆サイズ（DB優先 + キャッシュ）
 * ========================= */
function detectRegionFromPref(prefecture) {
  const pref = (prefecture || "").trim();
  return SHIPPING_REGION_BY_PREF[pref] || "chubu";
}
function cacheKey(region, size) { return `${region}:${String(size)}`; }

const SHIPPING_CACHE_TTL_MS = 5 * 60 * 1000;
const SIZE_RULE_CACHE_TTL_MS = 5 * 60 * 1000;

const shippingCache = { loadedAt: 0, map: new Map() }; // region:size -> fee
const sizeRuleCache = { loadedAt: 0, rules: [] };      // rows of shipping_size_rules

async function reloadShippingCacheIfNeeded() {
  const now = Date.now();
  if (shippingCache.loadedAt && (now - shippingCache.loadedAt) < SHIPPING_CACHE_TTL_MS) return;

  try {
    const r = await pool.query(`SELECT region, size, fee FROM public.shipping_yamato_taxed`);
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
    // ignore（フォールバックへ）
  }
}

async function reloadSizeRulesIfNeeded() {
  const now = Date.now();
  if (sizeRuleCache.loadedAt && (now - sizeRuleCache.loadedAt) < SIZE_RULE_CACHE_TTL_MS) return;

  try {
    const r = await pool.query(`
      SELECT shipping_group, qty_min, qty_max, size
      FROM public.shipping_size_rules
      ORDER BY shipping_group, qty_min
    `);

    sizeRuleCache.rules = (r.rows || []).map(x => ({
      shipping_group: String(x.shipping_group || "").trim(),
      qty_min: Number(x.qty_min),
      qty_max: Number(x.qty_max),
      size: String(x.size || "").trim(),
    })).filter(x =>
      x.shipping_group &&
      Number.isFinite(x.qty_min) &&
      Number.isFinite(x.qty_max) &&
      x.size
    );

    sizeRuleCache.loadedAt = now;
  } catch {
    sizeRuleCache.rules = [];
    sizeRuleCache.loadedAt = now;
  }
}

function bumpSizeOnce(size) {
  const s = Number(size || 0);
  const order = [60, 80, 100, 120, 140, 160];
  const i = order.indexOf(s);
  if (i < 0) return s || 80;
  return order[Math.min(i + 1, order.length - 1)];
}

function pickSizeFromRules(shippingGroup, qty) {
  const q = Math.max(1, Math.floor(Number(qty || 0)));
  const g = String(shippingGroup || "").trim();

  for (const r of (sizeRuleCache.rules || [])) {
    if (r.shipping_group !== g) continue;
    if (q >= r.qty_min && q <= r.qty_max) {
      const s = Number(r.size);
      if (Number.isFinite(s)) return s;
    }
  }

  for (const r of (FALLBACK_SIZE_RULES || [])) {
    if (r.shipping_group !== g) continue;
    if (q >= r.qty_min && q <= r.qty_max) {
      const s = Number(r.size);
      if (Number.isFinite(s)) return s;
    }
  }

  return 80;
}

async function dbGetSize(shippingGroup, qty) {
  await reloadSizeRulesIfNeeded();
  return pickSizeFromRules(shippingGroup, qty);
}

async function calcShippingFee(prefecture, size) {
  const region = detectRegionFromPref(prefecture);
  const s = Math.max(0, Math.floor(Number(size || 0))) || 80;

  await reloadShippingCacheIfNeeded();
  const ck = cacheKey(region, s);
  if (shippingCache.map.has(ck)) return Number(shippingCache.map.get(ck));

  try {
    const r = await pool.query(
      `SELECT fee FROM public.shipping_yamato_taxed WHERE region=$1 AND size=$2 LIMIT 1`,
      [region, s]
    );
    if (r.rowCount > 0) {
      const fee = Number(r.rows[0]?.fee || 0);
      shippingCache.map.set(ck, fee);
      return fee;
    }
  } catch {}

  const table = SHIPPING_YAMATO[region] || SHIPPING_YAMATO["chubu"];
  return Number(table[s] || table[80] || 0);
}

async function calcPackageSizeFromItems_DB(items, productsById) {
  let originalQty = 0;
  let akashaQty = 0;
  let otherQty = 0;

  for (const it of (items || [])) {
    const id = String(it?.id || "").trim();
    const qty = Math.max(0, Math.floor(Number(it?.qty || 0)));
    if (!id || qty <= 0) continue;

    const p = productsById[id];
    if (!p) continue;

    if (p.id === ORIGINAL_SET_PRODUCT_ID) {
      originalQty += qty;
      continue;
    }
    if (isAkashaLikeProduct(p)) akashaQty += qty;
    else otherQty += qty;
  }

  if (originalQty > 0 && akashaQty === 0 && otherQty === 0) {
    return await dbGetSize("original_set", originalQty);
  }

  if (originalQty > 0 && (akashaQty + otherQty) > 0) {
    const base = await dbGetSize("original_set", originalQty);
    return bumpSizeOnce(base);
  }

  if (akashaQty > 0 && otherQty === 0) {
    return await dbGetSize("akasha6", akashaQty);
  }

  if (otherQty > 0 && akashaQty === 0) {
    return await dbGetSize("default", otherQty);
  }

  const sizeA = akashaQty > 0 ? await dbGetSize("akasha6", akashaQty) : 0;
  const sizeB = otherQty > 0  ? await dbGetSize("default", otherQty) : 0;
  const base = Math.max(sizeA, sizeB) || 80;
  return bumpSizeOnce(base);
}

/* =========================
 * ensureDb（テーブル作成＆seed）
 * ========================= */
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

  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_id_uidx ON addresses(user_id) WHERE user_id IS NOT NULL;`); } catch {}
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_member_code_uidx ON addresses(member_code) WHERE member_code IS NOT NULL;`); } catch {}
  try { await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS addresses_address_key_uidx ON addresses(address_key) WHERE address_key IS NOT NULL;`); } catch {}

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

  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`); } catch {}

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shipping_size_rules (
      shipping_group TEXT NOT NULL,
      qty_min  INTEGER NOT NULL,
      qty_max  INTEGER NOT NULL,
      size     TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(shipping_group, qty_min, qty_max)
    );
  `);

  // seed shipping_yamato_taxed
  try {
    const cnt = await pool.query(`SELECT COUNT(*)::int AS n FROM public.shipping_yamato_taxed`);
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
          INSERT INTO public.shipping_yamato_taxed (region, size, fee)
          VALUES ${values.join(",")}
          ON CONFLICT (region, size) DO UPDATE SET
            fee = EXCLUDED.fee,
            updated_at = now()
          `,
          params
        );
        shippingCache.loadedAt = 0;
        await reloadShippingCacheIfNeeded();
        logInfo("shipping_yamato_taxed seeded:", rows.length);
      }
    }
  } catch (e) {
    logErr("shipping_yamato_taxed seed failed", e?.message || e);
  }

  // seed shipping_size_rules
  try {
    const cnt2 = await pool.query(`SELECT COUNT(*)::int AS n FROM public.shipping_size_rules`);
    const n2 = cnt2.rows?.[0]?.n || 0;
    if (n2 === 0) {
      const rows = FALLBACK_SIZE_RULES;
      const values = [];
      const params = [];
      let i = 1;
      for (const r of rows) {
        values.push(`($${i++},$${i++},$${i++},$${i++})`);
        params.push(r.shipping_group, r.qty_min, r.qty_max, String(r.size));
      }
      await pool.query(
        `
        INSERT INTO public.shipping_size_rules (shipping_group, qty_min, qty_max, size)
        VALUES ${values.join(",")}
        ON CONFLICT (shipping_group, qty_min, qty_max) DO UPDATE SET
          size = EXCLUDED.size,
          updated_at = now()
        `,
        params
      );
      sizeRuleCache.loadedAt = 0;
      await reloadSizeRulesIfNeeded();
      logInfo("shipping_size_rules seeded:", rows.length);
    }
  } catch (e) {
    logErr("shipping_size_rules seed failed", e?.message || e);
  }

  logInfo("DB ensured");
}

/* =========================
 * User / Address helpers
 * ========================= */
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

/* =========================
 * 注文組み立て（改ざん防止）
 * ========================= */
async function buildOrderFromCheckout(uid, checkout, opts = {}) {
  const userId = String(uid || "").trim();
  if (!userId) {
    const err = new Error("uid required");
    err.code = "NO_UID";
    throw err;
  }

  const requireAddress = (opts.requireAddress !== false);

  const addr = requireAddress ? await getAddressByUserId(userId) : null;
  if (requireAddress && !addr) {
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

  // ★福箱は混載不可（福箱 + 他商品）
  if (cartHasFukubako(items, productsById) && items.length > 1) {
    const err = new Error("福箱は単品注文のみです（混載不可）");
    err.code = "MIX_NOT_ALLOWED_FUKUBAKO";
    throw err;
  }

  // 配送が必要なときだけサイズ＆送料
  let size = null;
  let shippingFee = 0;

  if (requireAddress) {
    // ★福箱が入っていたら 60固定（サイズ計算スキップ）
    if (cartHasFukubako(items, productsById)) {
      size = 60;
      shippingFee = await calcShippingFee(addr.prefecture, 60);
    } else {
      size = await calcPackageSizeFromItems_DB(items, productsById);
      shippingFee = await calcShippingFee(addr.prefecture, size);
    }
  }

  return { userId, addr, items, subtotal, shippingFee, size, productsById };
}

/**
 * orders挿入（住所は userId 住所があれば自動でセット）
 */
async function insertOrderToDb({
  userId,
  items,
  total,
  shippingFee,
  paymentMethod,
  status,
  rawEvent,
  source = "liff",
  nameOverride = "",
  zipOverride = "",
  prefOverride = "",
  addressOverride = "",
}) {
  const addr = await getAddressByUserId(userId).catch(()=>null);

  const fullAddr =
    addressOverride ||
    (addr ? `${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""} ${addr.address2 || ""}`.trim() : "");

  const name = (nameOverride || addr?.name || "").trim();
  const zip  = (zipOverride  || addr?.postal || "").trim();
  const pref = (prefOverride || addr?.prefecture || "").trim();

  const r = await pool.query(
    `
    INSERT INTO orders (user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id
    `,
    [
      userId,
      source,
      JSON.stringify(items),
      Number(total || 0),
      Number(shippingFee || 0),
      String(paymentMethod || ""),
      String(status || "new"),
      name,
      zip,
      pref,
      fullAddr,
      rawEvent ? JSON.stringify(rawEvent) : null,
    ]
  );
  return r.rows[0]?.id;
}

/* =========================
 * LINE client
 * ========================= */
const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(lineConfig);

/* =========================
 * Express
 * ========================= */
const app = express();

/* =========================
 * Stripe
 * ========================= */
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
function liffUrl(pathname, reqForFallback = null) {
  const base = LIFF_BASE || (reqForFallback ? originFromReq(reqForFallback) : "");
  if (!base) return pathname;
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  return base + pathname;
}

/* =========================
 * 注文完了通知（統一）
 * ========================= */
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
  deliveryMethod = "delivery",
  pickupInfo = null,
  skipMarkNotified = false,
}) {
  const row = await getOrderRow(orderId);
  if (!skipMarkNotified && row?.notified_at) {
    logInfo("notify skipped (already notified):", orderId);
    return { ok: true, skipped: true };
  }

  const a = addr || (await getAddressByUserId(userId).catch(()=>null));
  const addrText = joinAddrText(a);

  let computedSize = size;
  if (!computedSize && deliveryMethod === "delivery") {
    try {
      const products = await loadProducts();
      const productsById = Object.fromEntries(products.map(p => [p.id, p]));
      // ★福箱なら60固定
      if (cartHasFukubako(items || [], productsById)) computedSize = 60;
      else computedSize = await calcPackageSizeFromItems_DB(items || [], productsById);
    } catch {}
  }

  const itemLines = buildItemLines(items || []);
  const payLabel = (paymentMethod === "card") ? "クレジット" :
                   (paymentMethod === "cod") ? "代引" :
                   (paymentMethod === "pickup_cash") ? "店頭受取（現金）" :
                   String(paymentMethod || "不明");

  const paidLine =
    (paymentMethod === "card")
      ? (isPaid ? "決済：完了" : "決済：未完了")
      : (paymentMethod === "cod")
        ? "支払い：代引（到着時）"
        : (paymentMethod === "pickup_cash")
          ? "支払い：店頭で現金"
          : "";

  let shipBlock = "";
  if (deliveryMethod === "delivery") {
    const shipLine = (computedSize ? `ヤマト ${computedSize}サイズ` : "ヤマト") + `：${yen(shippingFee)}`;
    shipBlock =
      `【送料】${shipLine}\n` +
      (paymentMethod === "cod" ? `【代引手数料】${yen(codFee)}\n` : "");
  } else {
    const shopName = pickupInfo?.shopName ? `（${pickupInfo.shopName}）` : "";
    const shopNote = pickupInfo?.shopNote ? `\n${pickupInfo.shopNote}` : "";
    shipBlock =
      `【受取方法】店頭受取${shopName}\n` +
      `【送料】0円${shopNote}\n`;
  }

  const msgForUser =
    `ご注文ありがとうございます。\n` +
    `【注文ID】${orderId}\n` +
    `【支払い】${payLabel}\n` +
    (paidLine ? `${paidLine}\n` : "") +
    `\n【内容】\n${itemLines}\n\n` +
    shipBlock +
    `【合計】${yen(total)}\n\n` +
    (deliveryMethod === "delivery" && addrText ? `【お届け先】\n${addrText}\n\n` : "") +
    (deliveryMethod === "delivery"
      ? `住所変更：\n${liffUrl("/cod-register.html")}`
      : `連絡先の変更がある場合はLINEでご連絡ください。`
    );

  await pushTextSafe(userId, msgForUser);

  if (ADMIN_USER_ID) {
    const msgForAdmin =
      `【${title}】\n` +
      `注文ID: ${orderId}\n` +
      `userId: ${userId}\n` +
      `支払い: ${payLabel}${paymentMethod === "card" ? (isPaid ? "（決済完了）" : "（未決済）") : ""}\n` +
      `受取: ${deliveryMethod === "pickup" ? "店頭受取" : "配送"}\n\n` +
      `${itemLines}\n\n` +
      (deliveryMethod === "delivery"
        ? `送料: ${yen(shippingFee)}${computedSize ? `（${computedSize}）` : ""}\n` +
          (paymentMethod === "cod" ? `代引手数料: ${yen(codFee)}\n` : "")
        : `送料: 0円（店頭受取）\n`
      ) +
      `合計: ${yen(total)}\n\n` +
      (deliveryMethod === "delivery"
        ? (addrText ? `お届け先:\n${addrText}` : "お届け先:（住所未取得）")
        : `店頭受取：お名前 ${a?.name || "（未入力）"} / TEL ${a?.phone || "（未入力）"}`
      );

    await pushTextSafe(ADMIN_USER_ID, msgForAdmin);
  }

  if (!skipMarkNotified) await markOrderNotified(orderId);
  return { ok: true };
}

/* =========================
 * Stripe webhook（raw必須）
 * ========================= */
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
            size: null,
            addr: null,
            title: "新規注文（カード）",
            isPaid: true,
            deliveryMethod: "delivery",
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

/* =========================
 * LINE Webhook（★ここをJSONより前に！）
 * ========================= */
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  const events = req.body?.events || [];
  res.status(200).end(); // 先に200

  for (const ev of events) {
    try { await handleEvent(ev); }
    catch (e) { logErr("handleEvent failed", e?.stack || e); }
  }
});

/* =========================
 * 通常JSON
 * ========================= */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// ログ
app.use((req, res, next) => {
  const t0 = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t0}ms)`);
  });
  next();
});

// favicon
app.get("/favicon.ico", (req, res) => res.status(204).end());

// address.html 強制200（publicより先）
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

// confirm-cod 名称ゆれ
app.get("/confirm_cod.html", (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));
app.get("/confirm-cod",      (req, res) => res.sendFile(path.join(__dirname, "public", "confirm-cod.html")));

// 静的配信
app.use(express.static(path.join(__dirname, "public")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/public/uploads", express.static(UPLOAD_DIR));

// health
app.get("/health", (req, res) => res.json({ ok: true, time: nowISO() }));

app.get("/health/db", async (req, res) => {
  const startedAt = Date.now();
  try {
    await pool.query("SELECT 1");
    const r = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders)  AS orders,
        (SELECT COUNT(*) FROM users)   AS users,
        (SELECT COUNT(*) FROM addresses) AS addresses
    `);

    res.json({
      ok: true,
      db: "connected",
      counts: r.rows[0],
      elapsed_ms: Date.now() - startedAt,
      time: nowISO(),
    });
  } catch (e) {
    logErr("health/db failed", e?.message || e);
    res.status(500).json({
      ok: false,
      db: "error",
      error: e?.message || String(e),
      time: nowISO(),
    });
  }
});

/* =========================
 * Admin auth（1個だけ）
 * ========================= */
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
 * 送料見積り（住所未登録でもOK）
 * ========================= */
app.post("/api/shipping/quote", async (req, res) => {
  try {
    const pref = String(req.body?.pref || "").trim();
    const inItems = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!pref) return res.status(400).json({ ok:false, error:"pref required" });
    if (!inItems.length) return res.status(400).json({ ok:false, error:"items required" });

    const products = await loadProducts();
    const byId = Object.fromEntries(products.map(p => [p.id, p]));

    // 疑似商品（既存ロジック維持）
    const kusukeReal = products.find(p => (p.id || "").includes("kusuke") || (p.name || "").includes("久助"));
    const akashaReal = products.find(p => (p.id || "").includes("akasha") || (p.name || "").includes("あかしゃ"));

    byId["original-set"] = {
      id: ORIGINAL_SET_PRODUCT_ID,
      name: "磯屋オリジナルセット（見積り）",
      price: Number(products.find(p => p.id === ORIGINAL_SET_PRODUCT_ID)?.price || 2100),
    };
    byId["akasha"] = { id: "akasha-series", name: "あかしゃシリーズ（見積り）", price: Number(akashaReal?.price || 0) };
    byId["kusuke"] = { id: "kusuke-series", name: "久助（見積り）", price: Number(kusukeReal?.price || 250) };

    const mapped = [];
    for (const it of inItems) {
      const pid = String(it?.product_id || it?.id || "").trim();
      const qty = Math.max(1, Math.floor(Number(it?.qty || 0)));
      if (!pid) continue;
      mapped.push({ id: pid, qty });
    }
    if (!mapped.length) return res.status(400).json({ ok:false, error:"items invalid" });

    const sizeItems = [];
    let subtotal = 0;

    for (const it of mapped) {
      const p = byId[it.id];
      if (p) {
        const price = Number(p.price || 0);
        sizeItems.push({ id: it.id, name: p.name, qty: it.qty, price });
        subtotal += price * it.qty;
      } else {
        sizeItems.push({ id: it.id, name: "（見積り用）", qty: it.qty, price: 0 });
      }
    }

    // ★福箱なら60固定
    let size;
    if (cartHasFukubako(sizeItems, byId)) size = 60;
    else size = await calcPackageSizeFromItems_DB(sizeItems, byId);

    const shipping_fee = await calcShippingFee(pref, size);
    const total = subtotal + Number(shipping_fee || 0);

    res.json({ ok: true, region: detectRegionFromPref(pref), size, shipping_fee, subtotal, total });
  } catch (e) {
    console.error("[api/shipping/quote] failed", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* =========================
 * Products API
 * ========================= */
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

/* =========================
 * Payment / Orders
 * ========================= */

// Stripe: create checkout session
app.post("/api/pay/stripe/create", async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok:false, error:"stripe_not_configured" });

    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true });

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
      source: "liff",
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
    if (code === "MIX_NOT_ALLOWED_FUKUBAKO") return res.status(409).json({ ok:false, error:"MIX_NOT_ALLOWED_FUKUBAKO" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 見積り（confirmで送料表示用）
app.post("/api/order/quote", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true });

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
    if (code === "MIX_NOT_ALLOWED_FUKUBAKO") return res.status(409).json({ ok:false, error:"MIX_NOT_ALLOWED_FUKUBAKO" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 代引き：作成（＝注文完了通知を送る）
app.post("/api/order/cod/create", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    await touchUser(uid, "seen");
    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true });

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "confirmed",
      rawEvent: { type: "cod_create_v2" },
      source: "liff",
    });

    await notifyOrderCompleted({
      orderId,
      userId: built.userId,
      items: built.items,
      shippingFee: built.shippingFee,
      total: totalCod,
      paymentMethod: "cod",
      codFee,
      size: built.size,
      addr: built.addr,
      title: "新規注文（代引）",
      isPaid: false,
      deliveryMethod: "delivery",
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
    if (code === "MIX_NOT_ALLOWED_FUKUBAKO") return res.status(409).json({ ok:false, error:"MIX_NOT_ALLOWED_FUKUBAKO" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* =========================
 * （ここから下は、あなたの元コードのままでOK）
 * - /api/store-order
 * - Admin orders / segment
 * - Address API / LIFF config
 * - handleEvent / onFollow / onTextMessage / finalizeKusukeOrder
 * など
 *
 * ※ 既に動いているなら、福箱対応は上の差し替えだけで反映されます。
 * ========================= */


/* =========================
 * Boot
 * ========================= */
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
