/**
 * server-line.js — “完全・全部入り” 丸ごと版（統合・最終修正版）
 *
 * ✅ 今回の「追加修正」
 * - 「直接注文」をセッションに残さない（sess.kind="direct" が残って次の入力を拾えない不具合を解消）
 * - orders に通知系カラムを追加（notified_user_at / notified_admin_at / notified_kind）※既存DBでもALTERで追従
 * - notifyOrderCompleted / notifyCardPending で通知記録を更新（二重送信点検にも使える)
 *
 * ✅ 今回の「致命的バグ修正」
 * - /api/address/list が2回定義されていたので「1個に統一」
 * - addresses テーブルに label / is_default 列が無いのに参照していたので ALTER で追従（既存DBもOK）
 *
 * ✅ さらに今回ここも修正（実害が出る箇所）
 * - 「複数住所対応」を潰す UNIQUE INDEX addresses_user_id_uidx を作らない（1ユーザー1件縛りが復活してた）
 * - label/is_default の ALTER が重複していたので 1回に整理
 * - /api/address/set /api/liff/address で id を受け取ったら更新できるように対応（upsertAddress の能力を活かす）
 * - upsertAddress のSQLが関数外に飛び出していた「構文崩壊」を修正
 *
 * ✅ A案（今回だけギフト）最短対応（サーバ側）
 * - 注文系APIで addressId（送付先住所ID）を受け取れるようにし、送料計算/注文保存/通知の住所をその住所にする
 *
 * ✅ ログ抑制（必要ならENVでON）
 * - HTTP_LOG=1 のときだけ [REQ]/[RES] を出す（未設定なら出さない）
 *
 * ✅ liff_open_logs の ON CONFLICT エラー対策
 * - 起動ログは “履歴” なので毎回 INSERT（ON CONFLICT 不要・ユニーク制約不要）
 *
 * ✅ 今回の変更（あなたの依頼）
 * - 旧Stripeルートを完全削除：
 *   - /api/stripe/config
 *   - /api/stripe/create-payment-intent
 *   - /api/order/stripe/complete
 *   ※ Stripeは Payment Element（PaymentIntent）系の /api/pay/stripe/intent に統一
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

// ✅ 友だち追加/ブロックの管理者通知 ON/OFF
const FRIEND_NOTIFY = String(env.FRIEND_NOTIFY || "1").trim() === "1";

const COD_FEE = Number(env.COD_FEE || 330);

const KEYWORD_DIRECT = env.KEYWORD_DIRECT || "直接注文";
const KEYWORD_KUSUKE = env.KEYWORD_KUSUKE || "久助";

const ORIGINAL_SET_PRODUCT_ID = (env.ORIGINAL_SET_PRODUCT_ID || "original-set-2000").trim();
const FUKUBAKO_PRODUCT_ID     = (env.FUKUBAKO_PRODUCT_ID || "fukubako-2026").trim();

/** ✅ 福箱テスト許可（この userId は何度でも買える。過去購入NGだけスキップ）
 * ENV: FUKUBAKO_TEST_ALLOW_USER_IDS=Uxxxx,Uyyyy
 */
const FUKUBAKO_TEST_ALLOW_USER_IDS = (env.FUKUBAKO_TEST_ALLOW_USER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// ✅ 定期案内用（postbackボタンを送るか）
const ENABLE_REORDER_BUTTONS = String(env.ENABLE_REORDER_BUTTONS || "1").trim() === "1";
// ✅ 定期案内のデフォルト文言（管理API送信時）
const REORDER_MESSAGE_TEMPLATE = String(env.REORDER_MESSAGE_TEMPLATE || "").trim(); // 任意

// ✅ HTTPログのON/OFF（未設定ならOFF）
const HTTP_LOG = String(env.HTTP_LOG || "0").trim() === "1";

function isFukubakoTestAllowedUser(userId) {
  const uid = String(userId || "").trim();
  if (!uid) return false;
  if (FUKUBAKO_TEST_ALLOW_USER_IDS.includes(uid)) return true;
  if (ADMIN_USER_ID && uid === String(ADMIN_USER_ID).trim()) return true;
  return false;
}

if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const BASE_URL  = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
const LIFF_BASE = (LIFF_BASE_URL || BASE_URL || "").replace(/\/$/, "");

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

const FALLBACK_SIZE_RULES = [
  { shipping_group: "akasha6", qty_min: 1,  qty_max: 4,    size: "60"  },
  { shipping_group: "akasha6", qty_min: 5,  qty_max: 8,    size: "80"  },
  { shipping_group: "akasha6", qty_min: 9,  qty_max: 13,   size: "100" },
  { shipping_group: "akasha6", qty_min: 14, qty_max: 18,   size: "120" },
  { shipping_group: "akasha6", qty_min: 19, qty_max: 9999, size: "140" },

  { shipping_group: "original_set", qty_min: 1, qty_max: 1,    size: "80"  },
  { shipping_group: "original_set", qty_min: 2, qty_max: 2,    size: "100" },
  { shipping_group: "original_set", qty_min: 3, qty_max: 4,    size: "120" },
  { shipping_group: "original_set", qty_min: 5, qty_max: 6,    size: "140" },
  { shipping_group: "original_set", qty_min: 7, qty_max: 9999, size: "160" },

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

function mustInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
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
      price: 250, // ←管理単価（あなたのメモ通り）
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
    },
    {
      id: FUKUBAKO_PRODUCT_ID,
      name: "福箱（数量限定）",
      price: 0,
      stock: 0,
      volume: "箱",
      desc: "キャンペーン商品（価格・在庫は管理画面で更新）。",
      image: ""
    },
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
 * DB (Postgres)
 * ========================= */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") || DATABASE_URL.includes("127.0.0.1")
    ? false
    : { rejectUnauthorized: false },
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
 * 福箱：一人一個 & 混載不可（サーバ強制）
 * ========================= */
function findFukubakoLine(items) {
  const fid = String(FUKUBAKO_PRODUCT_ID || "").trim();
  if (!fid) return null;
  return (items || []).find(x => String(x?.id || "").trim() === fid) || null;
}

async function hasEverOrderedFukubako(userId) {
  const fid = String(FUKUBAKO_PRODUCT_ID || "").trim();
  if (!fid) return false;

  const r = await pool.query(
    `
    SELECT 1
    FROM orders
    WHERE user_id = $1
      AND COALESCE(status,'') <> 'canceled'
      AND items @> $2::jsonb
    LIMIT 1
    `,
    [String(userId), JSON.stringify([{ id: fid }])]
  );
  return r.rowCount > 0;
}

async function enforceFukubakoRulesOrThrow({ userId, items }) {
  const fid = String(FUKUBAKO_PRODUCT_ID || "").trim();
  if (!fid) return;

  const fk = findFukubakoLine(items);
  if (!fk) return;

  const nonFuku = (items || []).filter(x => String(x?.id || "").trim() !== fid);
  if (nonFuku.length > 0) {
    const err = new Error("FUKUBAKO_MIX_NOT_ALLOWED");
    err.code = "FUKUBAKO_MIX_NOT_ALLOWED";
    throw err;
  }

  if (Number(fk.qty || 0) !== 1) {
    const err = new Error("FUKUBAKO_QTY_MUST_BE_ONE");
    err.code = "FUKUBAKO_QTY_MUST_BE_ONE";
    throw err;
  }

  if (!isFukubakoTestAllowedUser(userId)) {
    const already = await hasEverOrderedFukubako(userId);
    if (already) {
      const err = new Error("FUKUBAKO_ALREADY_ORDERED");
      err.code = "FUKUBAKO_ALREADY_ORDERED";
      throw err;
    }
  }
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      label TEXT,
      is_default BOOLEAN NOT NULL DEFAULT false
    );
  `);

  // 既存DB追従
  try { await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS label TEXT;`); } catch {}
  try { await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;`); } catch {}
  try { await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address_key TEXT;`); } catch {}
  try { await pool.query(`ALTER TABLE addresses ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();`); } catch {}

  // ✅ 1ユーザー1件縛りを復活させない
  try { await pool.query(`DROP INDEX IF EXISTS addresses_user_id_uidx;`); } catch {}

  // 古い制約/インデックス掃除
  try { await pool.query(`ALTER TABLE addresses DROP CONSTRAINT IF EXISTS ux_addresses_user_label;`); } catch {}
  try { await pool.query(`DROP INDEX IF EXISTS ux_addresses_user_label;`); } catch {}
  try { await pool.query(`DROP INDEX IF EXISTS addresses_user_label_uidx;`); } catch {}

  try { await pool.query(`ALTER TABLE addresses DROP CONSTRAINT IF EXISTS ux_addresses_address_key;`); } catch {}
  try { await pool.query(`DROP INDEX IF EXISTS ux_addresses_address_key;`); } catch {}
  try { await pool.query(`DROP INDEX IF EXISTS addresses_address_key_uidx;`); } catch {}

  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);`); } catch {}

  // member_code はユニーク（NULLは許容）
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS addresses_member_code_uidx
      ON addresses(member_code)
      WHERE member_code IS NOT NULL
    `);
  } catch {}

  // デフォルトはユーザーごとに1つ
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS addresses_default_uidx
      ON addresses(user_id)
      WHERE is_default = true
    `);
  } catch {}

  // user_id + address_key はユニーク（同一住所増殖を止める）
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS addresses_user_address_key_uidx
      ON addresses(user_id, address_key)
      WHERE address_key IS NOT NULL
    `);
  } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      source TEXT,
      member_code TEXT,
      phone TEXT,
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

  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS member_code TEXT;`); } catch {}
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS phone TEXT;`); } catch {}

  // 通知系
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;`); } catch {}
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_user_at TIMESTAMPTZ;`); } catch {}
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_admin_at TIMESTAMPTZ;`); } catch {}
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS notified_kind TEXT;`); } catch {}
// 発送・追跡系（スキャン運用に必須）
try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_no TEXT;`); } catch {}
try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;`); } catch {}
try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_notified_at TIMESTAMPTZ;`); } catch {}
// 🔥 ここに追加（インデックス）
try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_tracking_no ON orders(tracking_no);`); } catch {}
  // Payment Element（PaymentIntent）用
  try { await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_intent_id TEXT;`); } catch {}
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_payment_intent_id ON orders(payment_intent_id);`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS follow_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      followed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      raw_event JSONB
    );
  `);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_follow_events_user ON follow_events(user_id, followed_at DESC);`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      last_seen_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);

  const alterCols = [
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_chat_at TIMESTAMPTZ`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_source TEXT`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_liff_open_at TIMESTAMPTZ`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS has_ordered BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS last_order_at TIMESTAMPTZ`,
    `ALTER TABLE segment_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
  ];
  for (const q of alterCols) {
    try { await pool.query(q); } catch {}
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_segments (
      segment_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      candidate_since TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ,
      last_order_at TIMESTAMPTZ,
      has_ordered BOOLEAN NOT NULL DEFAULT false,
      last_source TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(segment_key, user_id)
    );
  `);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_segments_seg ON user_segments(segment_key, updated_at DESC);`); } catch {}

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

  // ✅ LIFF起動ログ：履歴なので毎回INSERT（ユニーク不要）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liff_open_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      source TEXT
    );
  `);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_user ON liff_open_logs(user_id, opened_at DESC);`); } catch {}

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reorder_reminders (
      user_id text PRIMARY KEY,
      cycle_days integer NOT NULL CHECK (cycle_days IN (30,45,60)),
      next_remind_at timestamptz NOT NULL,
      last_order_id integer,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_sent_at timestamptz
    );
  `);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_reorder_reminders_due ON reorder_reminders(active, next_remind_at);`); } catch {}

  // seed: shipping_yamato_taxed
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

  // seed: shipping_size_rules
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
async function touchUser(userId, kind, displayName = null, source = null) {
  const uid = String(userId || "").trim();
  if (!uid) return;

  const k = String(kind || "seen");

  // users 表（表示名など）※必要なら
  try {
    if (displayName) {
      await pool.query(
        `
        INSERT INTO users (user_id, display_name, created_at, updated_at, last_seen_at, last_liff_at)
        VALUES ($1, $2, now(), now(),
          CASE WHEN $3='seen' THEN now() ELSE NULL END,
          CASE WHEN $3='liff' THEN now() ELSE NULL END
        )
        ON CONFLICT (user_id) DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, users.display_name),
          last_seen_at = COALESCE(EXCLUDED.last_seen_at, users.last_seen_at),
          last_liff_at = COALESCE(EXCLUDED.last_liff_at, users.last_liff_at),
          updated_at = now()
        `,
        [uid, String(displayName), k]
      );
    }
  } catch {}

  // ✅ segment_users（新スキーマ）: user_id 主キーでUPSERT
  await pool.query(
    `
    INSERT INTO segment_users (
      user_id,
      first_seen,
      last_seen_at,
      last_liff_at,
      last_seen,
      last_chat_at,
      last_source,
      last_liff_open_at,
      updated_at
    )
    VALUES (
      $1,
      now(),
      CASE WHEN $2='seen' THEN now() ELSE NULL END,
      CASE WHEN $2='liff' THEN now() ELSE NULL END,
      CASE WHEN $2='seen' THEN now() ELSE NULL END,
      CASE WHEN $2='chat' THEN now() ELSE NULL END,
      $3,
      CASE WHEN $2='liff' THEN now() ELSE NULL END,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at      = COALESCE(EXCLUDED.last_seen_at, segment_users.last_seen_at),
      last_liff_at      = COALESCE(EXCLUDED.last_liff_at, segment_users.last_liff_at),
      last_seen         = COALESCE(EXCLUDED.last_seen, segment_users.last_seen),
      last_chat_at      = COALESCE(EXCLUDED.last_chat_at, segment_users.last_chat_at),
      last_source       = COALESCE(EXCLUDED.last_source, segment_users.last_source),
      last_liff_open_at = COALESCE(EXCLUDED.last_liff_open_at, segment_users.last_liff_open_at),
      updated_at        = now()
    `,
    [uid, k, source ? String(source) : null]
  );
}

async function upsertUserSegment(segmentKey, userId, patch = {}) {
  const seg = String(segmentKey || "").trim();
  const uid = String(userId || "").trim();
  if (!seg || !uid) return;

  const {
    last_seen_at = null,
    last_liff_at = null,
    last_order_at = null,
    has_ordered = null,
    last_source = null,
  } = patch;

  await pool.query(
    `
    INSERT INTO user_segments (
      segment_key, user_id, candidate_since, last_seen_at, last_liff_at, last_order_at, has_ordered, last_source, updated_at
    )
    VALUES (
      $1, $2, now(),
      $3, $4, $5,
      COALESCE($6, false),
      $7,
      now()
    )
    ON CONFLICT (segment_key, user_id) DO UPDATE SET
      last_seen_at = COALESCE(EXCLUDED.last_seen_at, user_segments.last_seen_at),
      last_liff_at = COALESCE(EXCLUDED.last_liff_at, user_segments.last_liff_at),
      last_order_at = COALESCE(EXCLUDED.last_order_at, user_segments.last_order_at),
      has_ordered = CASE WHEN $6 IS NULL THEN user_segments.has_ordered ELSE $6 END,
      last_source = COALESCE(EXCLUDED.last_source, user_segments.last_source),
      updated_at = now()
    `,
    [seg, uid, last_seen_at, last_liff_at, last_order_at, has_ordered, last_source]
  );
}

async function logLiffOpen(userId, source = null) {
  // ✅ 履歴ログなので毎回 INSERT（ON CONFLICT 不要）
  const uid = String(userId || "").trim();
  if (!uid) return;
  try {
    await pool.query(
      `INSERT INTO liff_open_logs (user_id, source) VALUES ($1, $2)`,
      [uid, source ? String(source) : null]
    );
  } catch (e) {
    logErr("logLiffOpen failed", uid, source, e?.message || e);
  }
}

async function markUserOrdered(userId, orderId = null) {
  const uid = String(userId || "").trim();
  if (!uid) return;

  try {
    await pool.query(
      `
      UPDATE segment_users
      SET has_ordered=true,
          last_order_at=now(),
          updated_at=now()
      WHERE user_id=$1
      `,
      [uid]
    );
  } catch {}

  try {
    await upsertUserSegment("prospect_regular", uid, {
      last_order_at: new Date(),
      has_ordered: true,
      last_source: "order",
    });
  } catch {}

  if (orderId != null) {
    try {
      await pool.query(
        `UPDATE reorder_reminders SET last_order_id=$2, updated_at=now() WHERE user_id=$1`,
        [uid, Number(orderId)]
      );
    } catch {}
  }
}

async function getAddressByUserId(userId) {
  const r = await pool.query(
    `
    SELECT id, label, is_default, member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
    FROM addresses
    WHERE user_id=$1
    ORDER BY is_default DESC, updated_at DESC, id DESC
    LIMIT 1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function getAddressByIdForUser(userId, addressId) {
  const uid = String(userId || "").trim();
  const id = Number(addressId);
  if (!uid || !Number.isInteger(id) || id <= 0) return null;

  const r = await pool.query(
    `
    SELECT id, label, is_default, member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
    FROM addresses
    WHERE user_id=$1 AND id=$2
    LIMIT 1
    `,
    [uid, id]
  );
  return r.rows[0] || null;
}

async function listAddressesByUserId(userId) {
  const r = await pool.query(
    `
    SELECT
      id,
      COALESCE(label,'')         AS label,
      COALESCE(name,'')          AS name,
      COALESCE(phone,'')         AS phone,
      COALESCE(postal,'')        AS postal,
      COALESCE(prefecture,'')    AS prefecture,
      COALESCE(city,'')          AS city,
      COALESCE(address1,'')      AS address1,
      COALESCE(address2,'')      AS address2,
      COALESCE(is_default,false) AS is_default,
      COALESCE(member_code,'')   AS member_code,
      COALESCE(address_key,'')   AS address_key,
      updated_at
    FROM addresses
    WHERE user_id=$1
    ORDER BY is_default DESC, updated_at DESC, id DESC
    `,
    [userId]
  );
  return r.rows || [];
}

async function issueUniqueMemberCode() {
  for (let i = 0; i < 80; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const r = await pool.query(`SELECT 1 FROM addresses WHERE member_code=$1`, [code]);
    if (r.rowCount === 0) return code;
  }
  return String(Math.floor(10000 + Math.random() * 90000));
}

function normalizeZip(z) {
  return String(z || "").replace(/[^\d]/g, "").trim();
}
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function makeAddressKey(a) {
  const postal = normalizeZip(a?.postal);
  const pref = norm(a?.prefecture);
  const city = norm(a?.city);
  const addr1 = norm(a?.address1);
  const addr2 = norm(a?.address2);

  const s = [postal, pref, city, addr1, addr2].join("|");
  const base = s.replace(/\|+/g, "|").replace(/^\||\|$/g, "").trim();

  if (!postal || !pref || !city || !addr1) {
    throw Object.assign(new Error("ADDRESS_KEY_BUILD_FAILED"), {
      code: "ADDRESS_KEY_BUILD_FAILED",
      got: { postal, pref, city, addr1 }
    });
  }

  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 20);
}

async function upsertAddress(userId, addr) {
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const addressId = addr?.id ? Number(addr.id) : null;

  // ✅ 必須（ここで止める：空保存＝増殖の原因）
  const name = String(addr?.name || "").trim();
  const phone = String(addr?.phone || "").trim();
  const postal = String(addr?.postal || "").trim();
  const prefecture = String(addr?.prefecture || "").trim();
  const city = String(addr?.city || "").trim();
  const address1 = String(addr?.address1 || "").trim();
  const address2 = String(addr?.address2 || "").trim();

  if (!name || !phone || !postal || !prefecture || !city || !address1) {
    const e = new Error("ADDRESS_REQUIRED_FIELDS_MISSING");
    e.code = "ADDRESS_REQUIRED_FIELDS_MISSING";
    e.got = { name, phone, postal, prefecture, city, address1 };
    throw e;
  }

  const label = String(addr?.label || "住所").trim();
  const isDefault = !!addr?.is_default;

  const memberCodeIn = String(addr?.member_code || "").trim() || null;

  // ✅ クライアントの address_key は捨てる（サーバで再計算）
  const addressKey = makeAddressKey({ postal, prefecture, city, address1, address2 });

  // is_default の切替
  if (isDefault) {
    await pool.query(`UPDATE addresses SET is_default=false WHERE user_id=$1`, [uid]);
  }

  if (addressId) {
    const r = await pool.query(
      `
      UPDATE addresses
      SET
        label=$3,
        is_default=$4,
        member_code = COALESCE($5, addresses.member_code),
        name=$6, phone=$7, postal=$8, prefecture=$9, city=$10, address1=$11, address2=$12,
        address_key = COALESCE($13, addresses.address_key),
        updated_at=now()
      WHERE user_id=$1 AND id=$2
      RETURNING id, label, is_default, member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
      `,
      [
        uid, addressId,
        label, isDefault,
        memberCodeIn,
        String(addr?.name || ""),
        String(addr?.phone || ""),
        String(addr?.postal || ""),
        String(addr?.prefecture || ""),
        String(addr?.city || ""),
        String(addr?.address1 || ""),
        String(addr?.address2 || ""),
        addressKey
      ]
    );
    if (r.rowCount === 0) throw new Error("address not found");
    return r.rows[0];
  }

  let memberCode = memberCodeIn;
  if (!memberCode) memberCode = await issueUniqueMemberCode();

  const r = await pool.query(
    `
    INSERT INTO addresses
      (user_id, label, is_default, member_code, name, phone, postal, prefecture, city, address1, address2, address_key)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (user_id, address_key)
    WHERE address_key IS NOT NULL
    DO UPDATE SET
      label       = EXCLUDED.label,
      is_default  = EXCLUDED.is_default,
      member_code = COALESCE(addresses.member_code, EXCLUDED.member_code),
      name        = EXCLUDED.name,
      phone       = EXCLUDED.phone,
      postal      = EXCLUDED.postal,
      prefecture  = EXCLUDED.prefecture,
      city        = EXCLUDED.city,
      address1    = EXCLUDED.address1,
      address2    = EXCLUDED.address2,
      updated_at  = now()
    RETURNING id, label, is_default, member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at, address_key, created_at
    `,
    [
      uid, label,
      isDefault,
      memberCode,
      String(addr?.name || ""),
      String(addr?.phone || ""),
      String(addr?.postal || ""),
      String(addr?.prefecture || ""),
      String(addr?.city || ""),
      String(addr?.address1 || ""),
      String(addr?.address2 || ""),
      addressKey
    ]
  );
  return r.rows[0];
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

  let addr = null;
  if (requireAddress) {
    if (opts.addressId) {
      addr = await getAddressByIdForUser(userId, opts.addressId);
      if (!addr) {
        const err = new Error("address not found");
        err.code = "NO_ADDRESS";
        err.detail = "addressId invalid";
        throw err;
      }
    } else {
      addr = await getAddressByUserId(userId);
      if (!addr) {
        const err = new Error("address not found");
        err.code = "NO_ADDRESS";
        throw err;
      }
    }
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

  let size = null;
  let shippingFee = 0;

  if (requireAddress) {
    size = await calcPackageSizeFromItems_DB(items, productsById);
    shippingFee = await calcShippingFee(addr.prefecture, size);
  }

  await enforceFukubakoRulesOrThrow({ userId, items });

  return { userId, addr, items, subtotal, shippingFee, size, productsById };
}

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
  phoneOverride = "",
  memberCodeOverride = "",
  addrOverride = null,
}) {
  const baseAddr = addrOverride || (await getAddressByUserId(userId).catch(()=>null));

  const fullAddr =
    addressOverride ||
    (baseAddr ? `${baseAddr.prefecture || ""}${baseAddr.city || ""}${baseAddr.address1 || ""} ${baseAddr.address2 || ""}`.trim() : "");

  const name = (nameOverride || baseAddr?.name || "").trim();
  const zip  = (zipOverride  || baseAddr?.postal || "").trim();
  const pref = (prefOverride || baseAddr?.prefecture || "").trim();
  const phone = (phoneOverride || baseAddr?.phone || "").trim();
  const memberCode = (memberCodeOverride || baseAddr?.member_code || "").trim();

  const r = await pool.query(
    `
    INSERT INTO orders (user_id, source, member_code, phone, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    RETURNING id
    `,
    [
      userId,
      source,
      memberCode || null,
      phone || null,
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

/* =========================
 * 通知（統一）
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
async function replyTextSafe(replyToken, text) {
  if (!replyToken) return;
  try {
    await lineClient.replyMessage(replyToken, { type: "text", text: String(text || "") });
  } catch (e) {
    logErr("replyTextSafe failed", e?.message || e);
  }
}

async function getOrderRow(orderId) {
  const r = await pool.query(
    `SELECT id, user_id, items, total, shipping_fee, payment_method, status, notified_at, notified_user_at, notified_admin_at, notified_kind, created_at
     FROM orders WHERE id=$1`,
    [orderId]
  );
  return r.rows[0] || null;
}
async function markOrderNotified(orderId, patch = {}) {
  try {
    const kind = patch.kind ? String(patch.kind) : null;

    const userAtExpr  = patch.userNotified  ? "now()" : "notified_user_at";
    const adminAtExpr = patch.adminNotified ? "now()" : "notified_admin_at";

    await pool.query(
      `
      UPDATE orders
      SET
        notified_at = COALESCE(notified_at, now()),
        notified_user_at = COALESCE(notified_user_at, ${userAtExpr}),
        notified_admin_at = COALESCE(notified_admin_at, ${adminAtExpr}),
        notified_kind = COALESCE($2, notified_kind)
      WHERE id=$1
      `,
      [orderId, kind]
    );
  } catch (e) {
    logErr("markOrderNotified failed", orderId, e?.message || e);
  }
}

function buildReorderButtonsMessage(orderId) {
  return {
    type: "template",
    altText: "次回のご案内設定（30/45/60日）",
    template: {
      type: "buttons",
      title: "次回のご案内",
      text: "次回のご案内を受け取る間隔を選んでください。",
      actions: [
        { type: "postback", label: "30日", data: `reorder:sub:30:${orderId}` },
        { type: "postback", label: "45日", data: `reorder:sub:45:${orderId}` },
        { type: "postback", label: "60日", data: `reorder:sub:60:${orderId}` },
        { type: "postback", label: "案内しない", data: `reorder:unsub::${orderId}` },
      ]
    }
  };
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

  // ✅ completed 二重送信防止（pending は止めない）
  if (!skipMarkNotified && row?.notified_kind === "completed") {
    logInfo("notify skipped (already completed):", orderId);
    return { ok: true, skipped: true };
  }

  const a = addr || (await getAddressByUserId(userId).catch(()=>null));
  const addrText = joinAddrText(a);

  let computedSize = size;
  if (!computedSize && deliveryMethod === "delivery") {
    try {
      const products = await loadProducts();
      const productsById = Object.fromEntries(products.map(p => [p.id, p]));
      computedSize = await calcPackageSizeFromItems_DB(items || [], productsById);
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
    (
      deliveryMethod === "delivery"
        ? (addrText ? `【お届け先】\n${addrText}\n\n` : "")
        : `【店頭受取】\nお名前：${a?.name || "（未入力）"}\n${a?.phone ? `TEL：${a.phone}\n` : ""}\n`
    ) +
    `このあと担当よりご連絡する場合があります。`;

  await pushTextSafe(userId, msgForUser);

  if (ENABLE_REORDER_BUTTONS) {
    try {
      await lineClient.pushMessage(userId, buildReorderButtonsMessage(orderId));
    } catch (e) {
      logErr("push reorder buttons failed", e?.message || e);
    }
  }

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

  if (!skipMarkNotified) {
    await markOrderNotified(orderId, { kind: "completed", userNotified: true, adminNotified: !!ADMIN_USER_ID });
  }

  return { ok: true };
}

async function notifyCardPending({ orderId, userId, items, shippingFee, total, size }) {
  const itemLines = buildItemLines(items || []);
  const msgForUser =
    `決済手続きの途中です（まだ確定していません）\n\n` +
    `【注文ID】${orderId}\n` +
    `【お支払い】クレジット（決済待ち）\n\n` +
    `【ご注文内容】\n${itemLines}\n\n` +
    `【送料】${yen(shippingFee)}${size ? `（${size}）` : ""}\n` +
    `【合計（予定）】${yen(total)}\n\n` +
    `このあとクレジット決済が完了すると、\n` +
    `「注文確定」のメッセージをお送りします。\n\n` +
    `※この時点では請求は発生していません。\n` +
    `※決済を完了しなかった場合、この注文は自動的に無効になります。`;

  await pushTextSafe(userId, msgForUser);

  if (ADMIN_USER_ID) {
    const msgForAdmin =
      `【注文 仮受付（カード/未決済）】\n` +
      `注文ID: ${orderId}\n` +
      `userId: ${userId}\n\n` +
      `${itemLines}\n\n` +
      `送料: ${yen(shippingFee)}${size ? `（${size}）` : ""}\n` +
      `合計（予定）: ${yen(total)}\n\n` +
      `※決済完了時に確定通知が飛びます。`;

    await pushTextSafe(ADMIN_USER_ID, msgForAdmin);
  }

  await markOrderNotified(orderId, { kind: "card_pending", userNotified: true, adminNotified: !!ADMIN_USER_ID });
}

/* =========================
 * Friend notify（follow/unfollow）
 * ========================= */
async function notifyAdminFriendAdded({ userId, displayName, day }) {
  if (!FRIEND_NOTIFY) return;
  if (!ADMIN_USER_ID) return;

  let todayCounts = null;
  try {
    const r = await pool.query(
      `SELECT added_count, blocked_count FROM friend_logs WHERE day=$1`,
      [day]
    );
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
  if (!FRIEND_NOTIFY) return;
  if (!ADMIN_USER_ID) return;

  let todayCounts = null;
  try {
    const r = await pool.query(
      `SELECT added_count, blocked_count FROM friend_logs WHERE day=$1`,
      [day]
    );
    if (r.rowCount > 0) todayCounts = r.rows[0];
  } catch {}

  const name = displayName ? `「${displayName}」` : "（表示名不明）";
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

    // ============================
    // ✅ Payment Element（PaymentIntent）確定：ここが本命
    // ============================
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object;

      const piId = pi?.id || "";
      const orderId = pi?.metadata?.orderId || null;
      const userIdFromMeta = pi?.metadata?.userId || "";

      // 1) metadata.orderId がある場合
      if (orderId) {
        await pool.query(`UPDATE orders SET status='paid' WHERE id=$1`, [orderId]);
        await markUserOrdered(userIdFromMeta || "", Number(orderId)).catch(()=>{});

        const row = await getOrderRow(orderId);
        if (row) {
          const items = Array.isArray(row.items) ? row.items : (row.items || []);
          await notifyOrderCompleted({
            orderId: row.id,
            userId: row.user_id || userIdFromMeta || "",
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
      } else if (piId) {
        // 2) 念のため：metadataが無い場合は orders.payment_intent_id で引く
        const r = await pool.query(
          `SELECT id FROM orders WHERE payment_intent_id=$1 ORDER BY created_at DESC LIMIT 1`,
          [piId]
        );
        const foundOrderId = r.rows?.[0]?.id;

        if (foundOrderId) {
          await pool.query(`UPDATE orders SET status='paid' WHERE id=$1`, [foundOrderId]);

          const row = await getOrderRow(foundOrderId);
          if (row) {
            await markUserOrdered(row.user_id || "", Number(foundOrderId)).catch(()=>{});
            const items = Array.isArray(row.items) ? row.items : (row.items || []);
            await notifyOrderCompleted({
              orderId: row.id,
              userId: row.user_id || "",
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
        } else {
          logErr("payment_intent.succeeded but order not found", piId);
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
  res.status(200).end();

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

app.use((req, res, next) => {
  if (!HTTP_LOG) return next();
  const t0 = Date.now();
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now()-t0}ms)`);
  });
  next();
});

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
// ===== Stripe config（Payment Element用：公開鍵を返すだけ）=====
app.get("/api/stripe/config", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || "",
    // 使ってなければ空でOK
    appBaseUrl: process.env.APP_BASE_URL || ""
  });
});

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
 * Admin auth
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
 * Admin：スキャン → shipped確定 → 即通知（A案）
 * POST /api/admin/ship/scan-and-notify
 * body: { tracking_no }
 * header: X-Admin-Token: <ADMIN_TOKEN>
 * ========================= */
app.post("/api/admin/ship/scan-and-notify", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const trackingNoRaw = String(req.body?.tracking_no || "").trim();
    const tracking_no = trackingNoRaw.replace(/\s+/g, "").replace(/\D/g, ""); // 数字だけに寄せる
    if (!tracking_no) {
      return res.status(400).json({ ok:false, error:"tracking_no_required" });
    }
    if (!/^\d{8,16}$/.test(tracking_no)) {
      return res.status(400).json({ ok:false, error:"tracking_no_invalid", tracking_no });
    }

    await client.query("BEGIN");

    // 追跡番号で注文をロックして取得（同時二重送信防止）
    const r = await client.query(
      `
      SELECT id, user_id, status, tracking_no, shipped_at, shipped_notified_at
      FROM orders
      WHERE tracking_no = $1
      FOR UPDATE
      `,
      [tracking_no]
    );

    if (r.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok:false, error:"order_not_found", tracking_no });
    }
    if (r.rowCount > 1) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok:false,
        error:"tracking_no_duplicated",
        tracking_no,
        ids: r.rows.map(x => x.id),
      });
    }

    const row = r.rows[0];

    // すでに通知済みなら送らない（冪等）
    if (row.shipped_notified_at) {
      await client.query("COMMIT");
      return res.json({
        ok:true,
        already_notified:true,
        orderId: row.id,
        userId: row.user_id,
        shipped_notified_at: row.shipped_notified_at,
      });
    }

    // shipped確定（通知前に確定させる：現場の真実を優先）
    await client.query(
      `
      UPDATE orders
      SET status='shipped',
          shipped_at = COALESCE(shipped_at, now())
      WHERE id=$1
      `,
      [row.id]
    );

    // 通知文（必要なら文言はここで調整）
    const trackingLink = `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number=${encodeURIComponent(tracking_no)}`;
    const msg =
      "【発送のお知らせ】\n" +
      "手造りえびせんべい 磯屋です。\n\n" +
      "ご注文の商品を発送しました。\n\n" +
      "▼伝票番号\n" + tracking_no + "\n" +
      "追跡：" + trackingLink + "\n\n" +
      "到着まで今しばらくお待ちください。";

    // LINE Push
    await lineClient.pushMessage(String(row.user_id), { type: "text", text: msg });

    // 通知済み確定（二重送信防止の本丸）
    await client.query(
      `
      UPDATE orders
      SET shipped_notified_at = now(),
          notified_kind = 'shipping_notice',
          notified_user_at = COALESCE(notified_user_at, now())
      WHERE id=$1
      `,
      [row.id]
    );

    await client.query("COMMIT");
    return res.json({ ok:true, already_notified:false, orderId: row.id, userId: row.user_id, tracking_no });

  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[scan-and-notify] failed", e?.stack || e);
    return res.status(500).json({ ok:false, error:"server_error" });
  } finally {
    client.release();
  }
});
/* =========================
 * Admin：orders
 * ========================= */
const REGION_LABEL = {
  hokkaido: "北海道",
  tohoku:   "東北",
  kanto:    "関東",
  shinetsu: "信越",
  chubu:    "中部",
  hokuriku: "北陸",
  kinki:    "関西",
  chugoku:  "中国",
  shikoku:  "四国",
  kyushu:   "九州",
  okinawa:  "沖縄",
};
function regionToLabel(key) { return REGION_LABEL[key] || key || ""; }

app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const date = String(req.query.date || "").trim(); // YYYYMMDD
  try {
    let sql = `
      SELECT
  id, user_id, items, total, shipping_fee, payment_method, status,
  name, zip, pref, address, created_at,
  tracking_no,
  shipped_notified_at,
  notified_kind,
  notified_user_at
FROM orders

      ORDER BY created_at DESC
      LIMIT 500
    `;
    let params = [];

  if (date && /^\d{8}$/.test(date)) {
  sql = `
    SELECT
      id, user_id, items, total, shipping_fee, payment_method, status,
      name, zip, pref, address, created_at,
      tracking_no,
      shipped_notified_at,
      notified_kind,
      notified_user_at
    FROM orders
    WHERE to_char((created_at AT TIME ZONE 'Asia/Tokyo'), 'YYYYMMDD') = $1
    ORDER BY created_at DESC
    LIMIT 500
  `;
  params = [date];
}

    const r = await pool.query(sql, params);

    const items = (r.rows || []).map((row) => {
      const itemsArr = Array.isArray(row.items) ? row.items : (() => {
        try { return JSON.parse(row.items); } catch { return []; }
      })();

      const addrObj = {
        name: row.name || "",
        postal: row.zip || "",
        prefecture: row.pref || "",
        city: "",
        address1: row.address || "",
        address2: "",
        phone: "",
      };

      const pref = addrObj.prefecture || row.pref || "";
      const regionKey = detectRegionFromPref(pref);

      const codFee = (row.payment_method === "cod") ? Number(COD_FEE || 330) : 0;
      const subtotal = (Number(row.total || 0) - Number(row.shipping_fee || 0) - Number(codFee || 0));

      return {
        ts: row.created_at,
        orderNumber: row.id,
        userId: row.user_id,
        lineUserId: row.user_id,
        name: row.name || "",
        addr_name: row.name || "",
        items: itemsArr,
        subtotal,
        shipping: Number(row.shipping_fee || 0),
        codFee,
        tracking_no: row.tracking_no || "",
shipped_notified_at: row.shipped_notified_at || null,
notified_kind: row.notified_kind || "",
notified_user_at: row.notified_user_at || null,

        finalTotal: Number(row.total || 0),
        payment: row.payment_method || "",
        method: (row.status === "pickup" ? "pickup" : "delivery"),
        region: regionToLabel(regionKey),
        address: addrObj,
      };
    });

    res.json({ items });
  } catch (e) {
    console.error("[api/admin/orders] failed", e?.stack || e);
    res.status(500).send("failed");
  }
});
// ================================
// B2 CSV download (serve prebuilt file)
// GET /admin/b2.csv?token=...
// ================================
const B2_EXPORT_FILE = (env.B2_EXPORT_FILE || "/var/data/b2.csv").trim();
const B2_CSV_TOKEN = (env.B2_CSV_TOKEN || "").trim();

function requireB2CsvToken(req, res, next) {
  // 1) B2_CSV_TOKEN が設定されていればそれを使う
  // 2) 未設定なら ADMIN_TOKEN（ADMIN_API_TOKEN / ADMIN_CODE）で代用
  const expect = B2_CSV_TOKEN || ADMIN_TOKEN;
  if (!expect) return res.status(403).send("token not set");

  const token = String(req.query.token || req.headers["x-admin-token"] || "").trim();
  if (token !== expect) return res.status(401).send("unauthorized");
  next();
}

app.get("/admin/b2.csv", requireB2CsvToken, async (req, res) => {
  try {
    const { spawnSync } = require("child_process");

const result = spawnSync(
  process.execPath,
  ["scripts/export_b2_isoya_csv.js"],
  {
    env: { ...process.env },
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024
  }
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(result.stderr || "CSV生成失敗");
}

const csv = result.stdout;

res.setHeader("Content-Type", "text/csv; charset=utf-8");
res.setHeader("Content-Disposition", 'attachment; filename="b2.csv"');
res.setHeader("Cache-Control", "no-store");

return res.send(csv);

  } catch (e) {
    logErr("GET /admin/b2.csv failed", e?.message || e);
    return res.status(500).send("server_error");
  }
});

// 発送通知（管理画面→ユーザーへPush）
// - orderId を必須にしてDBに通知済みを保存（PC変えても二重送信しない）
// - すでに通知済みなら送らずに {already:true} を返す（冪等）
app.post("/api/admin/orders/notify-shipped", requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { orderId, userId, message } = req.body || {};
    const oid = Number(orderId);

    if (!oid || !userId || !message) {
      return res.status(400).json({ ok:false, error:"bad_request", need:["orderId","userId","message"] });
    }

    await client.query("begin");

    const r = await client.query(
      `
      SELECT id, user_id, tracking_no, shipped_notified_at
      FROM orders
      WHERE id = $1
      FOR UPDATE
      `,
      [oid]
    );

    if (r.rowCount === 0) {
      await client.query("rollback");
      return res.status(404).json({ ok:false, error:"order_not_found" });
    }

    const row = r.rows[0];

    if (String(row.user_id) !== String(userId)) {
      await client.query("rollback");
      return res.status(400).json({ ok:false, error:"user_mismatch" });
    }

    if (row.shipped_notified_at) {
      await client.query("commit");
      return res.json({ ok:true, already:true });
    }

    await lineClient.pushMessage(String(userId), { type: "text", text: String(message) });

    await client.query(
      `
      UPDATE orders
      SET shipped_notified_at = now(),
          notified_kind = 'shipping_notice',
          notified_user_at = now()
      WHERE id = $1
      `,
      [oid]
    );

    await client.query("commit");
    return res.json({ ok:true, updated:true });

  } catch (e) {
    try { await client.query("rollback"); } catch {}
    console.error("[api/admin/orders/notify-shipped] failed", e?.stack || e);
    return res.status(500).json({ ok:false, error:"failed" });
  } finally {
    client.release();
  }
});

/* =========================
 * Admin：常連候補（prospect_regular）
 * ========================= */
app.get("/api/admin/segments/prospect_regular", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 200)));
    const onlyNoOrder = String(req.query.onlyNoOrder || "0") === "1";

    const r = await pool.query(
      `
      SELECT
        user_id,
        candidate_since,
        last_liff_at,
        last_seen_at,
        last_order_at,
        has_ordered,
        last_source,
        updated_at
      FROM user_segments
      WHERE segment_key='prospect_regular'
        ${onlyNoOrder ? "AND has_ordered=false" : ""}
      ORDER BY updated_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({ ok: true, total: r.rowCount, items: r.rows });
  } catch (e) {
    logErr("[api/admin/segments/prospect_regular] failed", e?.message || e);
    res.status(500).json({ ok:false, error:"failed" });
  }
});

/* =========================
 * Admin：LIFF起動集計（簡易）
 * ========================= */
app.get("/api/admin/liff/opens", requireAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 500)));

    const r = await pool.query(
      `
      SELECT
        lol.user_id,
        COUNT(*)::int AS open_count,
        MAX(lol.opened_at) AS last_opened_at
      FROM liff_open_logs lol
      WHERE lol.opened_at >= now() - ($1::text || ' days')::interval
      GROUP BY lol.user_id
      ORDER BY last_opened_at DESC
      LIMIT $2
      `,
      [String(days), limit]
    );

    res.json({ ok: true, days, total: r.rowCount, items: r.rows });
  } catch (e) {
    logErr("[api/admin/liff/opens] failed", e?.message || e);
    res.status(500).json({ ok:false, error:"failed" });
  }
});

/* =========================
 * Admin：定期案内 期限到来分送信
 * ========================= */
function buildReorderText(cycleDays) {
  if (REORDER_MESSAGE_TEMPLATE) {
    return REORDER_MESSAGE_TEMPLATE.replace(/\{cycle_days\}/g, String(cycleDays));
  }
  const orderUrl =
    (LIFF_ID_ORDER ? `https://liff.line.me/${LIFF_ID_ORDER}` :
     (LIFF_BASE ? `${LIFF_BASE}/products.html` : "（注文URL未設定）"));

  return (
    `いつもありがとうございます。\n` +
    `前回のご注文からそろそろ ${cycleDays}日 ほど経ちました。\n\n` +
    `よろしければ、ミニアプリからご注文いただけます。\n` +
    `${orderUrl}\n\n` +
    `※ご案内が不要な場合は「次回のご案内」ボタンから解除できます。`
  );
}

app.post("/api/admin/reorder/send-due", requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.body?.limit || 200)));

    const r = await pool.query(
      `
      SELECT user_id, cycle_days
      FROM reorder_reminders
      WHERE active=true
        AND next_remind_at <= now()
      ORDER BY next_remind_at ASC
      LIMIT $1
      `,
      [limit]
    );

    let sent = 0;
    for (const row of (r.rows || [])) {
      const uid = row.user_id;
      const days = Number(row.cycle_days);

      const text = buildReorderText(days);
      try {
        await lineClient.pushMessage(uid, { type:"text", text });
        sent++;

        await pool.query(
          `
          UPDATE reorder_reminders
          SET last_sent_at=now(),
              next_remind_at = now() + (cycle_days::text || ' days')::interval,
              updated_at=now()
          WHERE user_id=$1
          `,
          [uid]
        );
      } catch (e) {
        logErr("reorder push failed", uid, e?.message || e);
      }
    }

    res.json({ ok: true, due: r.rowCount, sent });
  } catch (e) {
    logErr("[api/admin/reorder/send-due] failed", e?.message || e);
    res.status(500).json({ ok:false, error:"failed" });
  }
});

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

    const size = await calcPackageSizeFromItems_DB(sizeItems, byId);
    const shipping_fee = await calcShippingFee(pref, size);

    const total = subtotal + Number(shipping_fee || 0);
    res.json({ ok: true, region: detectRegionFromPref(pref), size, shipping_fee, subtotal, total });
  } catch (e) {
    console.error("[api/shipping/quote] failed", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* =========================
 * LIFF config（order / address / add）
 * ========================= */
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim().toLowerCase();

  const orderId = (LIFF_ID_ORDER || LIFF_ID_DEFAULT || "").trim();
  const addressId = (LIFF_ID_ADDRESS || LIFF_ID_ADD || LIFF_ID_DEFAULT || "").trim();
  const addId = (LIFF_ID_ADD || LIFF_ID_ADDRESS || LIFF_ID_DEFAULT || "").trim();
  const codId = (LIFF_ID_COD || addressId || "").trim();

  let liffId = "";
  if (kind === "add") liffId = addId;
  else if (kind === "address" || kind === "register" || kind === "addr") liffId = addressId;
  else if (kind === "cod") liffId = codId;
  else liffId = orderId;

  if (!liffId) return res.status(400).json({ ok:false, error:"LIFF_ID_NOT_SET", kind });
  return res.json({ ok:true, liffId });
});
function pickNameFromAny(obj){
  const cands = [
    obj?.name,
    obj?.full_name, obj?.fullName,
    obj?.recipient_name, obj?.recipientName,
    obj?.customer_name, obj?.customerName,
  ];
  const s = cands.find(v => typeof v === "string" && v.trim());
  return (s || "").trim();
}
function normStr(v){ return (typeof v === "string" ? v : (v==null ? "" : String(v))).trim(); }

/* =========================
 * Address API
 * ========================= */
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

app.get("/api/address/list", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    const rows = await listAddressesByUserId(userId);
    res.json({ ok: true, addresses: rows });
  } catch (e) {
    console.error("address/list error", e);
    res.status(500).json({ ok: false, error: "db error" });
  }
});

app.post("/api/address/set", async (req, res) => {
  try {
    const b = req.body || {};
    const userId = normStr(b.userId || b.uid || req.query.userId);
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });

    // ✅ ネスト形式 { userId, address:{...} } も、フラット形式も両対応
    const a = (b.address && typeof b.address === "object") ? b.address : b;

    const payload = {
      id: a.id,
      member_code: a.member_code,
      name: pickNameFromAny(a),
      phone: normStr(a.phone),
      postal: normStr(a.postal || a.zip),
      prefecture: normStr(a.prefecture || a.pref),
      city: normStr(a.city),
      address1: normStr(a.address1 || a.address),
      address2: normStr(a.address2),
      address_key: a.address_key,
      label: a.label,
      is_default: !!a.is_default,
    };

    // ✅ 必須チェック（空保存を100%止める）
    if (!payload.name || !payload.phone || !payload.postal || !payload.prefecture || !payload.city || !payload.address1) {
      return res.status(400).json({
        ok:false,
        error:"required: name/phone/postal/prefecture/city/address1",
        got: payload
      });
    }

    // ✅ クライアントの address_key は信用しない（明示的に捨てる）
    payload.address_key = null;

    const saved = await upsertAddress(userId, payload);
    res.json({ ok:true, address:saved });
  } catch (e) {
    logErr("POST /api/address/set", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

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
      id: address.id,
      member_code: address.member_code,
      name: pickNameFromAny(address),
      phone: address.phone,
      postal: address.postal,
      prefecture: address.prefecture,
      city: address.city,
      address1: address.address1,
      address2: address.address2,
      address_key: address.address_key,
      label: address.label,
      is_default: address.is_default,
    });

    res.json({ ok:true, memberCode: saved?.member_code, address: saved });
  } catch (e) {
    logErr("POST /api/liff/address", e?.stack || e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

/* =========================
 * LIFF 起動ログ + 常連候補
 * ========================= */
async function onLiffOpened(userId, source = "liff") {
  await touchUser(userId, "liff", null, source);
  await logLiffOpen(userId, source);
  await upsertUserSegment("prospect_regular", userId, {
    last_liff_at: new Date(),
    last_source: source,
  });
}

app.post("/api/liff/opened", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await onLiffOpened(userId, "liff_opened");
    res.json({ ok: true });
  } catch (e) {
    logErr("POST /api/liff/opened", e?.stack || e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// === DEBUG: ping endpoint (no userId) ===
app.get("/api/ping", (req, res) => {
  try{ console.log("[ping]", new Date().toISOString(), req.query); }catch(e){}
  res.json({ok:true});
});
app.post("/api/liff/open", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });
    await onLiffOpened(userId, "liff_open");
    res.json({ ok:true });
  } catch (e) {
    logErr("POST /api/liff/open", e?.stack || e);
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
 * Admin products/images
 * ========================= */
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

/* =========================
 * Payment / Orders
 * ========================= */
function respondFukubakoErrors(res, code) {
  if (code === "FUKUBAKO_MIX_NOT_ALLOWED") return res.status(409).json({ ok:false, error:"FUKUBAKO_MIX_NOT_ALLOWED" });
  if (code === "FUKUBAKO_QTY_MUST_BE_ONE") return res.status(409).json({ ok:false, error:"FUKUBAKO_QTY_MUST_BE_ONE" });
  if (code === "FUKUBAKO_ALREADY_ORDERED") return res.status(409).json({ ok:false, error:"FUKUBAKO_ALREADY_ORDERED" });
  return null;
}

app.post("/api/store-order", async (req, res) => {
  try {
    const b = req.body || {};

    const uid = String(b.uid || b.userId || "").trim();
    if (!uid) return res.status(400).json({ ok:false, error:"uid required" });

    const itemsRaw = (b.checkout && Array.isArray(b.checkout.items)) ? b.checkout.items :
                     (Array.isArray(b.items) ? b.items : null);
    if (!itemsRaw) return res.status(400).json({ ok:false, error:"items required" });

    const paymentRaw = String(b.paymentMethod || b.payment_method || "").trim().toLowerCase();
    const pickupFlag = !!b.pickup;

    const paymentMethod =
      (paymentRaw === "cash" || paymentRaw === "pickup" || paymentRaw === "pickup_cash") ? "pickup_cash" :
      (paymentRaw === "card") ? "card" :
      (paymentRaw === "cod") ? "cod" :
      (pickupFlag ? "pickup_cash" : "cod");

    const deliveryRaw = String(b.deliveryMethod || b.delivery_method || "").trim().toLowerCase();
    const deliveryMethod =
      (deliveryRaw === "pickup" || paymentMethod === "pickup_cash" || pickupFlag) ? "pickup" : "delivery";

    const pickup = b.pickup && typeof b.pickup === "object" ? b.pickup : (b.pickup ? {} : (b.pickupInfo || {}));
    const customerName = String(b.name || pickup?.name || "").trim();
    const customerPhone = String(pickup?.phone || b.phone || "").trim();

    const addressId = mustInt(b.addressId || b.address_id || (b.ship && (b.ship.addressId || b.ship.address_id)));

    await touchUser(uid, "seen", null, "store_order");

    const built = await buildOrderFromCheckout(
      uid,
      { items: itemsRaw },
      { requireAddress: (deliveryMethod !== "pickup"), addressId: (deliveryMethod !== "pickup" ? addressId : null) }
    );

    const codFee = (paymentMethod === "cod") ? Number(COD_FEE || 330) : 0;
    const shippingFee = (deliveryMethod === "pickup") ? 0 : Number(built.shippingFee || 0);
    const size = (deliveryMethod === "pickup") ? null : built.size;

    const total = Number(built.subtotal || 0) + shippingFee + codFee;

    const nameOverride = (deliveryMethod === "pickup" ? customerName : "");
    const phoneOverride = (deliveryMethod === "pickup" ? customerPhone : "");

    const rawEvent = {
      type: "store_order",
      source: String(b.source || "liff"),
      paymentMethod,
      deliveryMethod,
      addressId: addressId || null,
      line_display_name: String(b.line_display_name || ""),
      pickup: (deliveryMethod === "pickup")
        ? { name: customerName, phone: customerPhone, shopName: String(pickup?.shopName || "磯屋"), shopNote: String(pickup?.shopNote || "") }
        : null,
    };

    const status =
      (deliveryMethod === "pickup") ? "pickup" :
      (paymentMethod === "cod") ? "confirmed" :
      "new";

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total,
      shippingFee,
      paymentMethod,
      status,
      rawEvent,
      source: (deliveryMethod === "pickup") ? "store_liff" : "liff",
      nameOverride,
      phoneOverride,
      addrOverride: (deliveryMethod === "pickup") ? null : built.addr,
    });

    await markUserOrdered(built.userId, Number(orderId)).catch(()=>{});

    if (paymentMethod === "pickup_cash") {
      const pseudoAddr = {
        name: customerName || built.addr?.name || "",
        phone: customerPhone || built.addr?.phone || "",
        postal: "",
        prefecture: "",
        city: "",
        address1: "",
        address2: "",
      };
      await notifyOrderCompleted({
        orderId,
        userId: built.userId,
        items: built.items,
        shippingFee: 0,
        total,
        paymentMethod: "pickup_cash",
        codFee: 0,
        size: null,
        addr: pseudoAddr,
        title: "新規注文（店頭受取/現金）",
        isPaid: false,
        deliveryMethod: "pickup",
        pickupInfo: { shopName: String(pickup?.shopName || "磯屋"), shopNote: String(pickup?.shopNote || "") },
      });
    } else if (paymentMethod === "cod") {
      await notifyOrderCompleted({
        orderId,
        userId: built.userId,
        items: built.items,
        shippingFee,
        total,
        paymentMethod: "cod",
        codFee,
        size,
        addr: built.addr,
        title: "新規注文（代引）",
        isPaid: false,
        deliveryMethod,
      });
    }

    res.json({
      ok: true,
      orderId,
      paymentMethod,
      deliveryMethod,
      subtotal: built.subtotal,
      shippingFee,
      codFee,
      total,
      size,
      addressId: addressId || null,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/store-order", code, e?.stack || e);

    const handled = respondFukubakoErrors(res, code);
    if (handled) return;

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ================================
// Stripe: PaymentIntent (Payment Element用)
// POST /api/pay/stripe/intent
// body: { uid, checkout: { items:[{id, qty}, ...] }, addressId? }
// return: { ok, orderId, clientSecret, amount }
// ================================
app.post("/api/pay/stripe/intent", async (req, res) => {
  try {
    if (!stripe) return res.status(400).json({ ok:false, error:"stripe_not_configured" });

    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;
    const addressId = mustInt(req.body?.addressId || req.body?.address_id || (checkout && (checkout.addressId || checkout.address_id)));

    if (!uid) return res.status(400).json({ ok:false, error:"uid missing" });
    if (!checkout || !Array.isArray(checkout.items) || checkout.items.length === 0) {
      return res.status(400).json({ ok:false, error:"items missing" });
    }

    // 価格・送料はサーバで確定（改ざん防止）
    await touchUser(uid, "seen", null, "stripe_intent");

    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true, addressId });

    const amountYen = Math.round(Number(built.subtotal || 0) + Number(built.shippingFee || 0));
    if (!Number.isFinite(amountYen) || amountYen <= 0) {
      return res.status(400).json({ ok:false, error:"amount invalid" });
    }

    // 先に orders を作る（未決済）
    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: amountYen,
      shippingFee: built.shippingFee,
      paymentMethod: "card",
      status: "new",
      rawEvent: { type: "payment_intent_create", addressId: addressId || null },
      source: "liff",
      addrOverride: built.addr,
    });

    // PaymentIntent 作成（metadata に orderId を持たせる）
    const pi = await stripe.paymentIntents.create({
      amount: amountYen,           // JPYは円単位
      currency: "jpy",
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: String(orderId),
        userId: built.userId,
      },
    });

    // orders に payment_intent_id を保存（webhookで確実に紐付け）
    try {
      await pool.query(
        `UPDATE orders SET payment_intent_id=$2 WHERE id=$1`,
        [orderId, pi.id]
      );
    } catch (e) {
      logErr("update orders.payment_intent_id failed", orderId, pi?.id, e?.message || e);
    }

    // 仮受付通知（任意）
    await notifyCardPending({
      orderId,
      userId: built.userId,
      items: built.items,
      shippingFee: built.shippingFee,
      total: amountYen,
      size: built.size,
    }).catch(()=>{});

    return res.json({
      ok: true,
      orderId,
      clientSecret: pi.client_secret,
      amount: amountYen,
      shippingFee: built.shippingFee,
      size: built.size,
      addressId: addressId || null,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/pay/stripe/intent", code, e?.stack || e);

    const handled = respondFukubakoErrors(res, code);
    if (handled) return;

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    return res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.post("/api/order/quote", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    const addressId = mustInt(req.body?.addressId || req.body?.address_id || (checkout && (checkout.addressId || checkout.address_id)));

    await touchUser(uid, "seen", null, "quote");
    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true, addressId });

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    res.json({
      ok: true,
      subtotal: built.subtotal,
      shippingFee: built.shippingFee,
      codFee,
      totalCod,
      size: built.size,
      addressId: addressId || null,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/order/quote", code, e?.stack || e);

    const handled = respondFukubakoErrors(res, code);
    if (handled) return;

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.post("/api/order/cod/create", async (req, res) => {
  try {
    const uid = String(req.body?.uid || "").trim();
    const checkout = req.body?.checkout || null;

    const addressId = mustInt(req.body?.addressId || req.body?.address_id || (checkout && (checkout.addressId || checkout.address_id)));

    await touchUser(uid, "seen", null, "cod_create");
    const built = await buildOrderFromCheckout(uid, checkout, { requireAddress: true, addressId });

    const codFee = Number(COD_FEE || 330);
    const totalCod = built.subtotal + built.shippingFee + codFee;

    const orderId = await insertOrderToDb({
      userId: built.userId,
      items: built.items,
      total: totalCod,
      shippingFee: built.shippingFee,
      paymentMethod: "cod",
      status: "confirmed",
      rawEvent: { type: "cod_create_v2", addressId: addressId || null },
      source: "liff",
      addrOverride: built.addr,
    });

    await markUserOrdered(built.userId, Number(orderId)).catch(()=>{});

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
      addressId: addressId || null,
      message: `代引き注文を受け付けました（注文ID: ${orderId}）`,
    });
  } catch (e) {
    const code = e?.code || "";
    logErr("POST /api/order/cod/create", code, e?.stack || e);

    const handled = respondFukubakoErrors(res, code);
    if (handled) return;

    if (code === "NO_ADDRESS") return res.status(409).json({ ok:false, error:"NO_ADDRESS" });
    if (code === "OUT_OF_STOCK") return res.status(409).json({ ok:false, error:"OUT_OF_STOCK", productId: e.productId });
    if (code === "EMPTY_ITEMS") return res.status(400).json({ ok:false, error:"EMPTY_ITEMS" });

    res.status(500).json({ ok:false, error:"server_error" });
  }
});

app.get("/api/order/status", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();
    if (!orderId) return res.status(400).json({ ok:false, error:"orderId required" });

    const r = await pool.query(
      `SELECT id, status, payment_method, total, shipping_fee, created_at, notified_at, notified_user_at, notified_admin_at, notified_kind
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

/* =========================
 * Reorder reminder APIs
 * ========================= */
app.post("/api/reorder/subscribe", async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.body?.uid || "").trim();
    const days = Number(req.body?.days);

    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!Number.isFinite(days) || ![30,45,60].includes(days)) {
      return res.status(400).json({ error: "days must be 30 or 45 or 60" });
    }

    const intervalStr = `${days} days`;

    await pool.query(
      `
      INSERT INTO reorder_reminders
        (user_id, cycle_days, next_remind_at, active, updated_at)
      VALUES
        ($1, $2, now() + $3::interval, true, now())
      ON CONFLICT (user_id)
      DO UPDATE SET
        cycle_days     = EXCLUDED.cycle_days,
        next_remind_at = EXCLUDED.next_remind_at,
        active         = true,
        updated_at     = now()
      `,
      [userId, days, intervalStr]
    );

    res.json({ status: "subscribed", days });
  } catch (e) {
    logErr("reorder subscribe failed", e?.message || e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/reorder/unsubscribe", async (req, res) => {
  try {
    const userId = String(req.body?.userId || req.body?.user_id || "").trim();
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });

    await pool.query(
      `UPDATE reorder_reminders SET active=false, updated_at=now() WHERE user_id=$1`,
      [userId]
    );
    res.json({ ok: true });
  } catch (e) {
    logErr("[reorder/unsubscribe] failed", e?.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

/* =========================
 * LINE Event handlers
 * ========================= */
async function handleEvent(ev) {
  const type = ev.type;
  const userId = ev?.source?.userId || "";

  if (userId) {
    try { await touchUser(userId, "seen", null, "line"); } catch {}
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

  try {
    await pool.query(
      `
      INSERT INTO follow_events (user_id, followed_at, raw_event)
      VALUES ($1, now(), $2)
      ON CONFLICT DO NOTHING
      `,
      [userId, ev ? JSON.stringify(ev) : null]
    );
  } catch (e) {
    logErr("insert follow_events failed", e?.message || e);
  }

  let displayName = null;
  try {
    const prof = await lineClient.getProfile(userId);
    displayName = prof?.displayName || null;
  } catch {}
  try { await touchUser(userId, "seen", displayName, "follow"); } catch {}

  try { await notifyAdminFriendAdded({ userId, displayName, day }); } catch {}

  await lineClient.pushMessage(userId, {
    type: "text",
    text: (
      "友だち追加ありがとうございます！\n\n" +
      "このLINEからご注文いただけます。\n\n" +
      "下のメニューをタップしてご利用ください。"
    )
  });

  return;
}

async function onUnfollow(ev) {
  const userId = ev?.source?.userId || "";
  if (!userId) return;

  const day = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

  try {
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
  } catch {}

  let displayName = null;
  try {
    const r = await pool.query(`SELECT display_name FROM users WHERE user_id=$1`, [userId]);
    displayName = r.rows?.[0]?.display_name || null;
  } catch {}

  try { await notifyAdminFriendBlocked({ userId, displayName, day }); } catch {}
}

/* =========================
 * Postback handlers（reorder）
 * ========================= */
async function onPostback(ev) {
  const userId = ev?.source?.userId || "";
  const replyToken = ev?.replyToken || "";
  const data = String(ev?.postback?.data || "").trim();
  if (!userId || !data) return;

  // reorder:sub:30:orderId
  // reorder:unsub::orderId
  if (data.startsWith("reorder:")) {
    const parts = data.split(":");
    const action = parts[1] || "";
    const daysStr = parts[2] || "";
    const orderIdStr = parts[3] || "";

    if (action === "sub") {
      const days = Number(daysStr);
      if (![30,45,60].includes(days)) {
        await replyTextSafe(replyToken, "設定に失敗しました（30/45/60日のみ対応）");
        return;
      }
      const intervalStr = `${days} days`;
      try {
        await pool.query(
          `
          INSERT INTO reorder_reminders (user_id, cycle_days, next_remind_at, active, updated_at)
          VALUES ($1, $2, now() + $3::interval, true, now())
          ON CONFLICT (user_id)
          DO UPDATE SET
            cycle_days = EXCLUDED.cycle_days,
            next_remind_at = EXCLUDED.next_remind_at,
            active = true,
            updated_at = now()
          `,
          [userId, days, intervalStr]
        );
        await replyTextSafe(replyToken, `次回のご案内を「${days}日ごと」で設定しました。`);
      } catch (e) {
        logErr("reorder postback subscribe failed", e?.message || e);
        await replyTextSafe(replyToken, "設定に失敗しました（サーバ側）");
      }
      return;
    }

    if (action === "unsub") {
      try {
        await pool.query(`UPDATE reorder_reminders SET active=false, updated_at=now() WHERE user_id=$1`, [userId]);
        await replyTextSafe(replyToken, "次回のご案内を停止しました。");
      } catch (e) {
        logErr("reorder postback unsubscribe failed", e?.message || e);
        await replyTextSafe(replyToken, "停止に失敗しました（サーバ側）");
      }
      return;
    }

    // それ以外は無視
    return;
  }
}

/* =========================
 * Text message（キーワード / 直接注文 / 住所誘導）
 * ========================= */
function buildOrderEntryUrl() {
  if (LIFF_ID_ORDER) return `https://liff.line.me/${LIFF_ID_ORDER}`;
  if (LIFF_BASE) return `${LIFF_BASE}/products.html`;
  return "";
}
function buildAddressEntryUrl() {
  const id = (LIFF_ID_ADDRESS || LIFF_ID_ADD || LIFF_ID_DEFAULT || "").trim();
  if (id) return `https://liff.line.me/${id}`;
  if (LIFF_BASE) return `${LIFF_BASE}/address.html`;
  return "";
}

function parseDirectOrderText(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  const m = t.match(/^(.+?)[\s　x×\*:-]+(\d{1,4})$/i);
  if (!m) return null;

  const key = m[1].trim();
  const qty = Math.max(1, Math.floor(Number(m[2] || 0)));
  if (!qty) return null;

  return { key, qty };
}

function findProductByKey(products, key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return null;

  let p = products.find(x => String(x.id || "").toLowerCase() === k);
  if (p) return p;

  p = products.find(x => String(x.id || "").toLowerCase().includes(k));
  if (p) return p;

  p = products.find(x => String(x.name || "").toLowerCase().includes(k));
  if (p) return p;

  if (k.includes("久助") || k.includes("kusuke")) {
    p = products.find(x => String(x.id || "").toLowerCase().includes("kusuke") || String(x.name || "").includes("久助"));
    if (p) return p;
  }
  if (k.includes("あかしゃ") || k.includes("akasha")) {
    p = products.find(x => String(x.id || "").toLowerCase().includes("akasha") || String(x.name || "").includes("あかしゃ"));
    if (p) return p;
  }

  return null;
}

async function onTextMessage(ev) {
  const userId = ev?.source?.userId || "";
  const replyToken = ev?.replyToken || "";
  const text = String(ev?.message?.text || "").trim();

  if (!userId || !text) return;

  // キャンセル
  if (text === "キャンセル" || text.toLowerCase() === "cancel") {
    clearSession(userId);
    await replyTextSafe(replyToken, "キャンセルしました。");
    return;
  }

  // 住所誘導
  if (text.includes("住所") || text.toLowerCase().includes("address")) {
    const url = buildAddressEntryUrl();
    await replyTextSafe(
      replyToken,
      url
        ? `住所登録はこちらです。\n${url}\n\n（複数住所の追加・編集もできます）`
        : "住所登録URLが未設定です（LIFF_ID_ADDRESS / LIFF_ID_ADD を設定してください）"
    );
    return;
  }

  // 直接注文の開始
  if (text === KEYWORD_DIRECT) {
    setSession(userId, { kind: "direct", step: "await_line" });
    await replyTextSafe(
      replyToken,
      `直接注文ですね。\n\n例）\n・久助 2\n・のりあかしゃ×3\n\nこの形式で送ってください。\n（やめる時は「キャンセル」）`
    );
    return;
  }

  // セッション処理（direct）
  const sess = getSession(userId);
  if (sess?.kind === "direct" && sess?.step === "await_line") {
    // ✅ ここで必ず direct セッションを消す（成功/失敗どちらでも残さない）
    clearSession(userId);

    try {
      const products = await loadProducts();
      const parsed = parseDirectOrderText(text);
      if (!parsed) {
        await replyTextSafe(
          replyToken,
          "書き方が分かりませんでした。\n例：\n・久助 2\n・のりあかしゃ×3\n\nもう一度「直接注文」と送ってください。"
        );
        return;
      }

      const p = findProductByKey(products, parsed.key);
      if (!p) {
        await replyTextSafe(
          replyToken,
          `商品が見つかりませんでした：「${parsed.key}」\n\nもう一度「直接注文」と送ってください。`
        );
        return;
      }

      // 住所が無いなら住所登録へ誘導
      const addr = await getAddressByUserId(userId);
      if (!addr) {
        const aurl = buildAddressEntryUrl();
        await replyTextSafe(
          replyToken,
          aurl
            ? `先に住所登録が必要です。\nこちらから登録してください：\n${aurl}\n\n登録後にもう一度「直接注文」と送ってください。`
            : "先に住所登録が必要です（住所LIFF未設定）。"
        );
        return;
      }

      // ✅ ここで「代引注文」を作って通知まで出す
      const checkout = { items: [{ id: p.id, qty: parsed.qty }] };
      const built = await buildOrderFromCheckout(userId, checkout, { requireAddress: true });

      const codFee = Number(COD_FEE || 330);
      const totalCod = built.subtotal + built.shippingFee + codFee;

      const orderId = await insertOrderToDb({
        userId: built.userId,
        items: built.items,
        total: totalCod,
        shippingFee: built.shippingFee,
        paymentMethod: "cod",
        status: "confirmed",
        rawEvent: { type: "direct_text_order" },
        source: "line_text",
        addrOverride: built.addr,
      });

      await markUserOrdered(built.userId, Number(orderId)).catch(()=>{});

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
        title: "新規注文（直接注文/代引）",
        isPaid: false,
        deliveryMethod: "delivery",
      });

      await replyTextSafe(replyToken, `直接注文を受け付けました！\n注文ID: ${orderId}\n（このまま発送準備に入れます）`);
      return;

    } catch (e) {
      const code = e?.code || "";
      logErr("direct order failed", code, e?.message || e);

      if (code === "OUT_OF_STOCK") {
        await replyTextSafe(replyToken, `在庫不足のため受付できませんでした。\n商品: ${e.productId || ""}\n\nもう一度「直接注文」と送ってください。`);
        return;
      }
      if (code === "FUKUBAKO_MIX_NOT_ALLOWED" || code === "FUKUBAKO_QTY_MUST_BE_ONE" || code === "FUKUBAKO_ALREADY_ORDERED") {
        await replyTextSafe(replyToken, `受付できませんでした（福箱の条件）。\n\nもう一度「直接注文」と送ってください。`);
        return;
      }
      await replyTextSafe(replyToken, "受付できませんでした。\nもう一度「直接注文」と送ってください。");
      return;
    }
  }

  // ちょいヘルプ：久助だけ送られた場合
  if (text === KEYWORD_KUSUKE) {
    const url = buildOrderEntryUrl();
    await replyTextSafe(replyToken, url ? `久助のご注文はこちらからどうぞ：\n${url}` : "注文URLが未設定です。");
    return;
  }

  // デフォ：注文URL案内（うるさくしない）
  return;
}

/* =========================
 * 起動（修正版：listen を先に）
 * ========================= */
async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(UPLOAD_DIR);

  // ✅ 先にサーバを起動（/health が即返せる）
  const port = Number(env.PORT || 10000);
  app.listen(port, () => {
    logInfo(`server-line.js listening on :${port}`);
  });

  // ✅ DB準備は後ろ（重くても起動は成立）
  await ensureDb();
  await loadSessions();

  logInfo("boot completed");
}

main().catch((e) => {
  logErr("boot failed", e?.stack || e);
  process.exit(1);
});
