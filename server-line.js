/**
 * server.js — フル機能版（Stripe + ミニアプリ + 画像管理 + 住所DB + セグメント配信 + 注文DB永続化）
 *
 * ✅重要（あなたの要望）
 * - UPLOAD_DIR だけ Disk に保存（再デプロイで画像が消えない）
 *   - 画像保存先：UPLOAD_DIR=/var/data/uploads（デフォルト）
 *   - 静的配信：/public/uploads → Disk の UPLOAD_DIR を参照（重要）
 *
 * - products.json / sessions.json / logs などの DATA も Disk に保存（再デプロイでもズレない）
 *   - データ保存先：DATA_DIR=/var/data（デフォルト）
 *
 * ✅今回の修正（あなたの依頼）
 * - 久助 と あかしゃシリーズ を同じカートに入れてOK（禁止ルールを撤廃）
 * - 久助の送料サイズ判定＝あかしゃと同じ（kusuke を akasha 扱いに含める）
 * - 「久助 3」でDB住所を読んで送料計算（member_code で addresses 参照）
 *
 * ※ Stripe / LINE は最低限動く形。あなたの既存の文面やFlexは差し替え可能。
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const cors = require("cors");

const multer = require("multer");
const { Pool } = require("pg");

// ============ Env ============
const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.BASE_URL || ""; // 例: https://xxxx.onrender.com
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/var/data/uploads";

const DATABASE_URL = process.env.DATABASE_URL || "";
const PGSSL = (process.env.PGSSL || "true").toLowerCase() !== "false";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || `${BASE_URL}/public/success.html`;
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || `${BASE_URL}/public/cancel.html`;

// LINE（使う場合）
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";

// 管理者
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // 任意: /api/admin/* 用

// ============ Helpers ============
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
ensureDir(DATA_DIR);
ensureDir(UPLOAD_DIR);

function safeJsonRead(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function safeJsonWrite(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeItemId(item) {
  // items: string or {id, qty} or {product_id,...}
  if (!item) return "";
  if (typeof item === "string") return item.trim();
  if (typeof item.id === "string") return item.id.trim();
  if (typeof item.product_id === "string") return item.product_id.trim();
  return "";
}

function normalizeQty(item) {
  if (!item) return 0;
  if (typeof item === "object" && typeof item.qty === "number") return Math.max(0, Math.floor(item.qty));
  if (typeof item === "object" && typeof item.quantity === "number") return Math.max(0, Math.floor(item.quantity));
  return 1;
}

function normalizeRuleId(id) {
  return String(id || "").trim().toLowerCase();
}

function isKusuke(id) {
  // products.json の id が "kusuke-250" など想定
  const x = normalizeRuleId(id);
  return x.includes("kusuke");
}

function isOriginalSet(id) {
  const x = normalizeRuleId(id);
  // 例: "original-set-2100" / "iso-original-2100" 等
  return x.includes("original") || x.includes("set-2100") || x.includes("original-set");
}

function isAkashaSeries(id) {
  const x = normalizeRuleId(id);
  // あかしゃ系（のりあかしゃ/磯あかしゃ等）をざっくり判定
  return x.includes("akasha") || x.includes("あかしゃ");
}

/**
 * ✅今回の最重要：
 * - 久助は「あかしゃ扱い」に含める（送料サイズ判定のグルーピング）
 * - でも「久助×オリジナルセット」は同一注文NG（必要なら外せる）
 */
function validateSameOrderRules(items) {
  const ids = (items || []).map((x) => normalizeRuleId(normalizeItemId(x))).filter(Boolean);
  const hasKusuke = ids.some(isKusuke);
  const hasOriginal = ids.some(isOriginalSet);

  // ✅ 久助 × オリジナルセット は不可（ここだけ残す）
  if (hasKusuke && hasOriginal) {
    return {
      ok: false,
      code: "KUSUKE_ORIGINAL_NOT_ALLOWED",
      message: "久助とオリジナルセットは同一注文（同じ決済）では購入できません。別々にご注文ください。",
    };
  }

  // ✅ 久助 × あかしゃシリーズ はOK（= 何もしない）
  return { ok: true };
}

// ============ Product / Data files ============
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const LOGS_FILE = path.join(DATA_DIR, "logs.json");

// ============ DB ============
let pool = null;
function getPool() {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: PGSSL ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

async function ensureDb() {
  const p = getPool();
  if (!p) return;

  // addresses（あなたの実テーブルに合わせる：member_code / postal / pref / city / address1 / address2）
  await p.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      member_code TEXT UNIQUE,
      name TEXT,
      phone TEXT,
      postal TEXT,
      pref TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // orders（最低限）
  await p.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      member_code TEXT,
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // shipping_yamato_chubu_taxed（地域×サイズの送料）
  await p.query(`
    CREATE TABLE IF NOT EXISTS shipping_yamato_chubu_taxed (
      id SERIAL PRIMARY KEY,
      region_key TEXT,
      size TEXT,
      fee INTEGER,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(region_key, size)
    );
  `);

  // segment_users（最小）
  await p.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      last_liff_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // message_events（最小）
  await p.query(`
    CREATE TABLE IF NOT EXISTS message_events (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

// user touch
async function touchUser(userId, type = "seen") {
  const p = getPool();
  if (!p || !userId) return;

  if (type === "liff") {
    await p.query(
      `
      INSERT INTO segment_users (user_id, last_liff_at, last_seen_at, updated_at)
      VALUES ($1, NOW(), NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        last_liff_at = NOW(),
        last_seen_at = NOW(),
        updated_at = NOW()
    `,
      [userId]
    );
    return;
  }

  await p.query(
    `
    INSERT INTO segment_users (user_id, last_seen_at, updated_at)
    VALUES ($1, NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at = NOW(),
      updated_at = NOW()
  `,
    [userId]
  );
}

// ============ Shipping rules ============
/**
 * サイズ判定（例）
 * - オリジナルセット：1=80 / 2=100 / 3-4=120 / 5-6=140 / 7-8=160
 * - あかしゃ系（＋久助）：まとめて 60/80/100 などお好みで（ここはあなたの実運用に合わせて調整）
 *
 * 重要：久助は akasha 扱いに含めている（= isAkashaBucket）
 */
function decideSize(items) {
  const lines = (items || []).map((it) => ({
    id: normalizeRuleId(normalizeItemId(it)),
    qty: normalizeQty(it),
  }));

  const totalQty = lines.reduce((s, x) => s + (x.qty || 0), 0);

  const originalQty = lines
    .filter((x) => isOriginalSet(x.id))
    .reduce((s, x) => s + (x.qty || 0), 0);

  // akashaBucket: あかしゃ系列 + 久助
  const akashaQty = lines
    .filter((x) => isAkashaSeries(x.id) || isKusuke(x.id))
    .reduce((s, x) => s + (x.qty || 0), 0);

  // まずオリジナルセットが入ってるなら、原則オリジナル基準（混在はあなたのルール次第）
  if (originalQty > 0) {
    if (originalQty === 1) return "80";
    if (originalQty === 2) return "100";
    if (originalQty >= 3 && originalQty <= 4) return "120";
    if (originalQty >= 5 && originalQty <= 6) return "140";
    return "160";
  }

  // あかしゃ+久助 のみ（または中心）
  if (akashaQty > 0 && akashaQty === totalQty) {
    // 例：1-2=60 / 3-4=80 / 5-8=100 / 9+=120
    if (akashaQty <= 2) return "60";
    if (akashaQty <= 4) return "80";
    if (akashaQty <= 8) return "100";
    return "120";
  }

  // その他混在（最低限の安全側）
  // 例：総数でざっくり（運用に合わせて調整可）
  if (totalQty <= 2) return "60";
  if (totalQty <= 4) return "80";
  if (totalQty <= 8) return "100";
  return "120";
}

// 都道府県 → 地域キー（例）
function regionKeyFromPref(pref) {
  const p = String(pref || "").trim();
  if (!p) return "unknown";

  if (p.includes("北海道")) return "hokkaido";
  if (["青森", "岩手", "宮城", "秋田", "山形", "福島"].some((x) => p.includes(x))) return "tohoku";
  if (["茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川", "山梨"].some((x) => p.includes(x))) return "kanto";
  if (["新潟", "富山", "石川", "福井", "長野"].some((x) => p.includes(x))) return "shinetsu_hokuriku";
  if (["岐阜", "静岡", "愛知", "三重"].some((x) => p.includes(x))) return "chubu";
  if (["滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山"].some((x) => p.includes(x))) return "kinki";
  if (["鳥取", "島根", "岡山", "広島", "山口"].some((x) => p.includes(x))) return "chugoku";
  if (["徳島", "香川", "愛媛", "高知"].some((x) => p.includes(x))) return "shikoku";
  if (["福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島"].some((x) => p.includes(x))) return "kyushu";
  if (p.includes("沖縄")) return "okinawa";

  return "unknown";
}

async function getShippingFee(regionKey, size) {
  const p = getPool();
  if (!p) return null;

  const r = await p.query(
    `SELECT fee FROM shipping_yamato_chubu_taxed WHERE region_key=$1 AND size=$2 LIMIT 1`,
    [regionKey, String(size)]
  );
  if (r.rows?.length) return Number(r.rows[0].fee);

  // fallback: unknown のとき等
  const r2 = await p.query(
    `SELECT fee FROM shipping_yamato_chubu_taxed WHERE region_key='unknown' AND size=$1 LIMIT 1`,
    [String(size)]
  );
  if (r2.rows?.length) return Number(r2.rows[0].fee);

  return null;
}

// ============ Stripe ============
let stripe = null;
function getStripe() {
  if (!STRIPE_SECRET_KEY) return null;
  if (!stripe) stripe = require("stripe")(STRIPE_SECRET_KEY);
  return stripe;
}

// ============ Express ============
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(morgan("combined"));

// 静的：/public はプロジェクト内
app.use("/public", express.static(path.join(__dirname, "public")));

// 静的：/public/uploads は Disk の UPLOAD_DIR
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ============ Multer（Disk保存） ============
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = crypto.randomBytes(8).toString("hex");
    cb(null, `${Date.now()}_${base}${ext || ".bin"}`);
  },
});
const upload = multer({ storage });

// ============ Admin auth ============
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // 未設定なら素通し（あなたの運用に合わせて）
  const t = req.headers["x-admin-token"] || req.query.admin_token || "";
  if (String(t) !== String(ADMIN_TOKEN)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

// ============ Products API ============
app.get("/api/products", (req, res) => {
  const products = safeJsonRead(PRODUCTS_FILE, []);
  res.json({ ok: true, products });
});

// 例：管理画面から更新
app.post("/api/admin/products/update", requireAdmin, (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : null;
  if (!products) return res.status(400).json({ ok: false, error: "products array required" });

  safeJsonWrite(PRODUCTS_FILE, products);
  res.json({ ok: true });
});

// 画像アップロード（管理）
app.post("/api/admin/upload", requireAdmin, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "file required" });
  const urlPath = `/public/uploads/${req.file.filename}`;
  res.json({
    ok: true,
    filename: req.file.filename,
    url: BASE_URL ? `${BASE_URL}${urlPath}` : urlPath,
    path: urlPath,
  });
});

// ============ Shipping API ============
/**
 * body:
 * {
 *   items: [{id, qty}],
 *   pref?: "愛知県",
 *   member_code?: "1234"
 * }
 */
app.post("/api/shipping", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const rule = validateSameOrderRules(items);
    if (!rule.ok) return res.status(400).json({ ok: false, ...rule });

    let pref = String(req.body?.pref || "").trim();
    const memberCode = String(req.body?.member_code || "").trim();

    // member_code が来てて pref が空なら DB から引く
    if (!pref && memberCode && getPool()) {
      const p = getPool();
      const r = await p.query(`SELECT pref FROM addresses WHERE member_code=$1 LIMIT 1`, [memberCode]);
      if (r.rows?.length) pref = String(r.rows[0].pref || "").trim();
    }

    const regionKey = regionKeyFromPref(pref);
    const size = decideSize(items);
    const fee = await getShippingFee(regionKey, size);

    if (fee == null) {
      return res.status(200).json({
        ok: true,
        region_key: regionKey,
        size,
        shipping_fee: null,
        note: "送料テーブルに該当がありません（shipping_yamato_chubu_taxed を確認）",
      });
    }

    return res.json({
      ok: true,
      region_key: regionKey,
      size,
      shipping_fee: fee,
      pref,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "shipping_failed" });
  }
});

// ============ Stripe checkout ============
/**
 * body:
 * {
 *   user_id?: "...",
 *   member_code?: "1234",
 *   items: [{id, qty}],
 *   customer: { name, pref, address, zip, phone },
 *   shipping: { pref } // または member_code
 * }
 */
app.post("/api/pay-stripe", async (req, res) => {
  try {
    const st = getStripe();
    if (!st) return res.status(400).json({ ok: false, error: "STRIPE_SECRET_KEY not set" });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const rule = validateSameOrderRules(items);
    if (!rule.ok) return res.status(400).json({ ok: false, ...rule });

    const products = safeJsonRead(PRODUCTS_FILE, []);
    const map = new Map(products.map((p) => [String(p.id), p]));

    // 送料計算
    let pref = String(req.body?.shipping?.pref || req.body?.customer?.pref || "").trim();
    const memberCode = String(req.body?.member_code || "").trim();
    if (!pref && memberCode && getPool()) {
      const p = getPool();
      const r = await p.query(`SELECT pref FROM addresses WHERE member_code=$1 LIMIT 1`, [memberCode]);
      if (r.rows?.length) pref = String(r.rows[0].pref || "").trim();
    }
    const regionKey = regionKeyFromPref(pref);
    const size = decideSize(items);
    const shippingFee = await getShippingFee(regionKey, size);
    if (shippingFee == null) {
      return res.status(400).json({ ok: false, error: "shipping_fee_not_found", region_key: regionKey, size });
    }

    // line items
    const lineItems = [];
    let subtotal = 0;

    for (const it of items) {
      const id = normalizeItemId(it);
      const qty = normalizeQty(it);
      const p = map.get(id);
      if (!p) return res.status(400).json({ ok: false, error: `unknown_product:${id}` });

      const price = Number(p.price || 0);
      subtotal += price * qty;

      lineItems.push({
        quantity: qty,
        price_data: {
          currency: "jpy",
          unit_amount: price,
          product_data: {
            name: p.name || id,
            description: p.desc || "",
            images: p.image ? [p.image] : undefined,
          },
        },
      });
    }

    // 送料を 1行として追加
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: "jpy",
        unit_amount: Number(shippingFee),
        product_data: { name: `送料（ヤマト）${size} / ${regionKey}` },
      },
    });

    const session = await st.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata: {
        user_id: String(req.body?.user_id || ""),
        member_code: memberCode,
        region_key: regionKey,
        size: String(size),
        shipping_fee: String(shippingFee),
      },
    });

    // orders 保存（DBあれば）
    try {
      const p = getPool();
      if (p) {
        const customer = req.body?.customer || {};
        const name = String(customer?.name || "");
        const zip = String(customer?.zip || "");
        const address = String(customer?.address || "");
        const payment_method = "stripe";
        const total = subtotal + Number(shippingFee);

        await p.query(
          `
          INSERT INTO orders (user_id, member_code, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
          [
            String(req.body?.user_id || ""),
            memberCode,
            "liff",
            JSON.stringify(items),
            total,
            Number(shippingFee),
            payment_method,
            "created",
            name,
            zip,
            pref,
            address,
            JSON.stringify({ stripe_session_id: session.id }),
          ]
        );
      }
    } catch (e) {
      console.error("orders insert failed:", e?.message || e);
    }

    res.json({ ok: true, url: session.url, id: session.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "stripe_failed" });
  }
});

// ============ LIFF open log (任意) ============
app.post("/api/liff/open", async (req, res) => {
  try {
    const userId = String(req.body?.user_id || "").trim();
    if (userId) await touchUser(userId, "liff");
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// ============ LINE Webhook（使うなら） ============
async function lineReply(replyToken, messages) {
  if (!LINE_CHANNEL_ACCESS_TOKEN) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

async function handleLineEvent(ev) {
  const userId = ev?.source?.userId || "";
  const text = (ev?.message?.text || "").trim();

  // ログ
  try {
    const p = getPool();
    if (p && userId && text) {
      await p.query(`INSERT INTO message_events (user_id, text) VALUES ($1,$2)`, [userId, text]);
    }
  } catch {}

  if (userId) {
    try {
      await touchUser(userId, "seen");
    } catch {}
  }

  // 起動キーワード制限（あなたの運用）
  // 「直接注文」と「久助」だけ反応。かつ、セッション中は別処理…などはあなたの既存実装に合わせて拡張可。
  const lower = text.toLowerCase();

  // ✅「久助 3」：member_code=3 で住所→送料計算（簡易）
  // ※ member_code が4桁ならそのまま入力してOKにしたい場合はここを拡張
  if (lower.startsWith("久助")) {
    const m = text.replace(/^久助\s*/i, "").trim();
    const memberCode = m ? m : ""; // 例: "3" や "0123" など
    if (!memberCode) {
      await lineReply(ev.replyToken, [{ type: "text", text: "例：久助 1234 のように会員コードを送ってください。" }]);
      return;
    }

    // DBから住所取得して送料
    let pref = "";
    if (getPool()) {
      const p = getPool();
      const r = await p.query(`SELECT pref, city, address1, address2, postal, name FROM addresses WHERE member_code=$1 LIMIT 1`, [
        memberCode,
      ]);
      if (r.rows?.length) {
        pref = String(r.rows[0].pref || "");
        const size = decideSize([{ id: "kusuke-250", qty: 1 }]); // 久助=akasha扱いのサイズ判定
        const regionKey = regionKeyFromPref(pref);
        const fee = await getShippingFee(regionKey, size);

        const addr = `${r.rows[0].pref || ""}${r.rows[0].city || ""}${r.rows[0].address1 || ""}${r.rows[0].address2 || ""}`;
        const msg =
          fee == null
            ? `住所：${addr}\nサイズ：${size}\n送料：未設定（DBの shipping_yamato_chubu_taxed を確認）`
            : `住所：${addr}\nサイズ：${size}\n送料：${fee}円`;

        await lineReply(ev.replyToken, [{ type: "text", text: msg }]);
        return;
      }
    }

    await lineReply(ev.replyToken, [{ type: "text", text: "会員コードの住所が見つかりませんでした。" }]);
    return;
  }

  if (text === "直接注文") {
    const url = BASE_URL ? `${BASE_URL}/public/products.html` : "/public/products.html";
    await lineReply(ev.replyToken, [{ type: "text", text: `こちらから注文できます：\n${url}` }]);
    return;
  }

  // その他は無反応
}

app.post("/webhook", async (req, res) => {
  // ※本番は line.middleware(config) を入れるのが正しい（あなたの既存版に合わせて差し替えOK）
  try {
    const events = req.body?.events || [];
    await Promise.all(events.map(handleLineEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook Error:", err?.stack || err);
    res.status(500).end();
  }
});

// ============ Health ============
app.get("/healthz", (_req, res) => res.json({ ok: true, time: nowIso() }));

// ============ Boot ============
(async () => {
  try {
    await ensureDb();
  } catch (e) {
    console.error("ensureDb failed:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`server listening on :${PORT}`);
    console.log(`DATA_DIR=${DATA_DIR}`);
    console.log(`UPLOAD_DIR=${UPLOAD_DIR}`);
  });
})();
