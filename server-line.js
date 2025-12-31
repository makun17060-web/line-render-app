/**
 * server-line.js — フル機能版（Disk products.json + 住所DB + セグメント + 注文DB + 送料計算統一）
 *
 * ✅ 今回の改善点
 * - 久助も「商品」として自由に価格変更できる（250固定を廃止）
 * - 久助の送料は「アカシャシリーズと同じ」扱い（混載も同梱扱い）
 *
 * ✅ 重要仕様（維持）
 * - 起動キーワードは「直接注文」と「久助」だけ（それ以外は無反応）
 * - ただしセッション中の入力は受け付ける（例：個数入力など）
 *
 * ✅ Disk
 * - products.json: PRODUCTS_FILE=/var/data/products.json（Render Disk推奨）
 * - uploads: UPLOAD_DIR=/var/data/uploads（Render Disk推奨）
 *
 * ✅ 必須環境変数
 * - LINE_CHANNEL_ACCESS_TOKEN
 * - LINE_CHANNEL_SECRET
 * - DATABASE_URL（Postgres）
 *
 * ✅ 任意
 * - ADMIN_USER_ID（管理者LINE userId）
 * - BASE_URL（例 https://xxxx.onrender.com）
 * - PRODUCTS_FILE（既定 /var/data/products.json）
 * - UPLOAD_DIR（既定 /var/data/uploads）
 * - ADMIN_API_KEY（管理API保護用）
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Pool } = require("pg");
const line = require("@line/bot-sdk");

// ============ Env ============
const PORT = process.env.PORT || 10000;
const BASE_URL = process.env.BASE_URL || ""; // 例: https://xxxx.onrender.com

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

const PRODUCTS_FILE = process.env.PRODUCTS_FILE || "/var/data/products.json";
const UPLOAD_DIR = process.env.UPLOAD_DIR || "/var/data/uploads";

// LINE config
if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!LINE_CHANNEL_SECRET) throw new Error("LINE_CHANNEL_SECRET is required");

const lineConfig = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);

// ============ App ============
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// 静的（public）
app.use("/public", express.static(path.join(__dirname, "public")));

// Disk uploads を静的配信
ensureDirSync(UPLOAD_DIR);
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ============ DB ============
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

// ============ Multer (Upload) ============
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      cb(null, `${Date.now()}_${crypto.randomBytes(3).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ============ In-memory session ============
/**
 * 最小セッション（注文途中のみ）
 * sessions[userId] = { mode, data, updatedAt }
 */
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000; // 20分

function setSession(userId, mode, data = {}) {
  sessions.set(userId, { mode, data, updatedAt: Date.now() });
}
function getSession(userId) {
  const s = sessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}
function clearSession(userId) {
  sessions.delete(userId);
}

// ============ Utilities ============
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
async function readJsonSafe(filePath, fallback) {
  try {
    const txt = await fsp.readFile(filePath, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}
async function writeJsonAtomic(filePath, obj) {
  ensureDirSync(path.dirname(filePath));
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await fsp.rename(tmp, filePath);
}

// ============ Products (Disk single source of truth) ============
async function loadProducts() {
  // products.json が無い場合の初期値（最低限）
  const fallback = [
    {
      id: "kusuke-250", // IDは互換のため残す（中身のpriceは自由）
      name: "久助（われせん）",
      price: 340,
      stock: 30,
      volume: "100g",
      desc: "お得な割れせん。",
      image: "",
    },
  ];
  const arr = await readJsonSafe(PRODUCTS_FILE, fallback);
  return Array.isArray(arr) ? arr : fallback;
}

async function saveProducts(products) {
  await writeJsonAtomic(PRODUCTS_FILE, products);
}

async function getProductById(id) {
  const products = await loadProducts();
  return products.find((p) => String(p.id) === String(id)) || null;
}

function normalizeProductPatch(patch) {
  const out = {};
  if (patch.id != null) out.id = String(patch.id).trim();
  if (patch.name != null) out.name = String(patch.name);
  if (patch.price != null) out.price = Number(patch.price);
  if (patch.stock != null) out.stock = Number(patch.stock);
  if (patch.volume != null) out.volume = String(patch.volume);
  if (patch.desc != null) out.desc = String(patch.desc);
  if (patch.image != null) out.image = String(patch.image);
  return out;
}

// ============ DB schema ============
async function ensureDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS line_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      user_id TEXT PRIMARY KEY,
      member_code TEXT,
      name TEXT,
      phone TEXT,
      postal TEXT,
      prefecture TEXT,
      city TEXT,
      address1 TEXT,
      address2 TEXT,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
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
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      last_seen_at TIMESTAMP,
      last_liff_at TIMESTAMP,
      last_chat_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS liff_logs (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      event TEXT,
      meta JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS segment_blast (
      segment_key TEXT,
      user_id TEXT,
      created_at TIMESTAMP DEFAULT now(),
      PRIMARY KEY(segment_key, user_id)
    );
  `);
}

async function touchUser(userId, kind) {
  if (!pool || !userId) return;
  await pool.query(
    `
    INSERT INTO segment_users (user_id, last_seen_at, last_liff_at, last_chat_at, updated_at)
    VALUES ($1,
      CASE WHEN $2='seen' THEN now() ELSE NULL END,
      CASE WHEN $2='liff' THEN now() ELSE NULL END,
      CASE WHEN $2='chat' THEN now() ELSE NULL END,
      now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen_at = COALESCE(EXCLUDED.last_seen_at, segment_users.last_seen_at),
      last_liff_at = COALESCE(EXCLUDED.last_liff_at, segment_users.last_liff_at),
      last_chat_at = COALESCE(EXCLUDED.last_chat_at, segment_users.last_chat_at),
      updated_at = now()
  `,
    [userId, kind]
  );
}

async function upsertLineProfile(userId) {
  if (!pool || !userId) return;
  try {
    const prof = await client.getProfile(userId);
    await pool.query(
      `
      INSERT INTO line_users (user_id, display_name, picture_url, status_message, created_at, updated_at)
      VALUES ($1,$2,$3,$4, now(), now())
      ON CONFLICT (user_id) DO UPDATE SET
        display_name=$2, picture_url=$3, status_message=$4, updated_at=now()
    `,
      [userId, prof.displayName || "", prof.pictureUrl || "", prof.statusMessage || ""]
    );
  } catch {
    // ignore
  }
}

async function dbGetAddressByUserId(userId) {
  if (!pool) return null;
  const r = await pool.query(`SELECT * FROM addresses WHERE user_id=$1`, [userId]);
  return r.rows[0] || null;
}

// ============ Shipping (unified) ============
/**
 * あなたの梱包ルール（例）
 * - オリジナルセット: 1個80 / 2個100 / 3-4個120 / 5-6個140
 * - あかしゃ(=アカシャ6系 + 久助も同扱い): 合計個数でサイズ（例）
 *
 * ※料金テーブルは DB/固定表どちらでもOK。
 * 今回は「サイズ判定」を統一するのが主目的。
 */

// 例：アカシャ系の個数→サイズ
function sizeFromAkasha6Qty(qty) {
  // 必要に応じて調整してOK
  if (qty <= 2) return 60;
  if (qty <= 4) return 80;
  if (qty <= 6) return 100;
  if (qty <= 8) return 120;
  return 140;
}

function sizeFromOriginalSetQty(qty) {
  if (qty <= 1) return 80;
  if (qty <= 2) return 100;
  if (qty <= 4) return 120;
  return 140; // 5-6
}

function sizeFromTotalQty(qty) {
  if (qty <= 2) return 60;
  if (qty <= 4) return 80;
  if (qty <= 6) return 100;
  if (qty <= 8) return 120;
  return 140;
}

function isOriginalSet(item) {
  const id = String(item?.id || "");
  return id === "original-set-2000";
}

/**
 * ★ここが今回の要点
 * - 「久助」をあかしゃ扱いに含める（送料サイズ判定が同じ）
 */
function isAkasha6(item) {
  const id = String(item?.id || "");
  const name = String(item?.name || "");

  // ★久助もあかしゃ扱い
  if (id === "kusuke-250" || /久助/.test(name)) return true;

  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}

// 例：都道府県→送料（超簡易。あなたのDB関数版があるなら差し替え推奨）
function prefToRegion(pref) {
  const p = String(pref || "");
  if (/北海道/.test(p)) return "hokkaido";
  if (/(青森|岩手|宮城|秋田|山形|福島)/.test(p)) return "tohoku";
  if (/(東京|神奈川|千葉|埼玉|茨城|栃木|群馬|山梨)/.test(p)) return "kanto";
  if (/(新潟|長野)/.test(p)) return "shinetsu";
  if (/(富山|石川|福井)/.test(p)) return "hokuriku";
  if (/(岐阜|静岡|愛知|三重)/.test(p)) return "chubu";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山)/.test(p)) return "kinki";
  if (/(鳥取|島根|岡山|広島|山口)/.test(p)) return "chugoku";
  if (/(徳島|香川|愛媛|高知)/.test(p)) return "shikoku";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島)/.test(p)) return "kyushu";
  if (/沖縄/.test(p)) return "okinawa";
  return "unknown";
}

// 例：サイズ×地域→送料（必要ならあなたの正確表に置換）
function shippingFeeByRegionAndSize(region, size) {
  // ざっくり例（適宜あなたの表に差し替え）
  const base = {
    hokkaido: 1200,
    tohoku: 950,
    kanto: 850,
    shinetsu: 850,
    hokuriku: 800,
    chubu: 800,
    kinki: 850,
    chugoku: 900,
    shikoku: 950,
    kyushu: 1050,
    okinawa: 1400,
    unknown: 999,
  }[region] ?? 999;

  const up = size <= 60 ? 0 : size <= 80 ? 120 : size <= 100 ? 240 : size <= 120 ? 420 : 620;
  return Math.round(base + up);
}

function calcShippingUnified(items, prefecture) {
  const safeItems = Array.isArray(items) ? items : [];
  const totalQty = safeItems.reduce((a, it) => a + Number(it.qty || 0), 0);

  const akashaQty = safeItems
    .filter((it) => isAkasha6(it))
    .reduce((a, it) => a + Number(it.qty || 0), 0);

  const originalQty = safeItems
    .filter((it) => isOriginalSet(it))
    .reduce((a, it) => a + Number(it.qty || 0), 0);

  // 優先順：オリジナルセットがあればオリジナルサイズ、次にアカシャ系（久助含む）、最後は合計
  let size = 60;
  if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else if (akashaQty > 0) size = sizeFromAkasha6Qty(akashaQty);
  else size = sizeFromTotalQty(totalQty);

  const region = prefToRegion(prefecture);
  const fee = shippingFeeByRegionAndSize(region, size);

  return { size, region, fee };
}

// ============ Flex builders ============
function productFlex(products) {
  const bubbles = products.map((p) => {
    const imgUrl = p.image ? `${BASE_URL}/public/uploads/${p.image}` : `${BASE_URL}/public/noimage.png`;
    return {
      type: "bubble",
      hero: {
        type: "image",
        url: imgUrl,
        size: "full",
        aspectMode: "cover",
        aspectRatio: "20:13",
      },
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name || "", weight: "bold", wrap: true, size: "md" },
          { type: "text", text: `価格：${Number(p.price || 0)}円`, size: "sm", color: "#555555" },
          p.volume ? { type: "text", text: `内容量：${p.volume}`, size: "sm", color: "#555555" } : null,
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true, color: "#666666" } : null,
          { type: "text", text: `在庫：${Number(p.stock || 0)}`, size: "sm", color: "#555555" },
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "message", label: "この商品を注文", text: `注文 ${p.id}` },
          },
        ],
      },
    };
  });

  return {
    type: "flex",
    altText: "商品一覧",
    contents: { type: "carousel", contents: bubbles.slice(0, 10) },
  };
}

function confirmFlex(product, qty, addressObj) {
  // addressObj: {name, phone, postal, prefecture, city, address1, address2}
  const price = Number(product.price || 0);
  const subtotal = price * qty;

  const pref = addressObj?.prefecture || "";
  const items = [{ id: product.id, name: product.name, qty, price }];

  let shipping = null;
  if (pref) {
    const r = calcShippingUnified(items, pref);
    shipping = r;
  }

  const total = subtotal + (shipping?.fee || 0);

  const addrText = addressObj
    ? `〒${addressObj.postal || ""}\n${addressObj.prefecture || ""}${addressObj.city || ""}${addressObj.address1 || ""}\n${addressObj.address2 || ""}`
    : "（住所未登録）";

  return {
    type: "flex",
    altText: "注文内容の確認",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          { type: "text", text: "ご注文内容の確認", weight: "bold", size: "lg" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              { type: "text", text: product.name, weight: "bold", wrap: true },
              product.volume ? { type: "text", text: `内容量：${product.volume}`, size: "sm", color: "#555555" } : null,
              { type: "text", text: `単価：${price}円`, size: "sm", color: "#555555" },
              { type: "text", text: `数量：${qty}`, size: "sm", color: "#555555" },
              { type: "text", text: `小計：${subtotal}円`, size: "sm", color: "#555555" },
            ].filter(Boolean),
          },
          { type: "separator" },
          {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            contents: [
              { type: "text", text: "お届け先", weight: "bold" },
              { type: "text", text: addrText, size: "sm", wrap: true, color: "#555555" },
            ],
          },
          shipping
            ? {
                type: "box",
                layout: "vertical",
                spacing: "xs",
                contents: [
                  { type: "text", text: `送料：${shipping.fee}円`, size: "sm", color: "#111111" },
                  { type: "text", text: `梱包サイズ：${shipping.size}`, size: "xs", color: "#666666" },
                ],
              }
            : { type: "text", text: "送料：住所未登録のため計算できません", size: "sm", color: "#b91c1c", wrap: true },
          { type: "separator" },
          { type: "text", text: `合計：${total}円`, weight: "bold", size: "lg" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: { type: "message", label: "注文確定", text: `確定 ${product.id} ${qty}` },
          },
          {
            type: "button",
            style: "secondary",
            action: { type: "message", label: "キャンセル", text: "キャンセル" },
          },
        ],
      },
    },
  };
}

// ============ API ============
app.get("/", (req, res) => res.status(200).send("OK"));

/** products取得（Diskが正） */
app.get("/api/products", async (req, res) => {
  try {
    const products = await loadProducts();
    res.json({ ok: true, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** 送料計算（統一ルール） */
app.post("/api/shipping", async (req, res) => {
  try {
    const { items, prefecture } = req.body || {};
    const r = calcShippingUnified(items, prefecture);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** LIFFログなど（必要ならフロントから叩く） */
app.post("/api/liff/log", async (req, res) => {
  try {
    const { userId, event, meta } = req.body || {};
    if (userId) await touchUser(userId, "liff");
    if (pool && userId && event) {
      await pool.query(`INSERT INTO liff_logs (user_id, event, meta) VALUES ($1,$2,$3)`, [
        userId,
        String(event),
        meta || {},
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============ Admin API (optional protect) ============
function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return next(); // 未設定なら無保護（必要なら必ず設定して）
  const key = req.headers["x-api-key"] || req.query.api_key || "";
  if (String(key) !== String(ADMIN_API_KEY)) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
}

/** 商品更新（久助含む価格変更OK） */
app.post("/api/admin/products/update", requireAdmin, async (req, res) => {
  try {
    const patch = normalizeProductPatch(req.body || {});
    if (!patch.id) return res.status(400).json({ ok: false, error: "id is required" });

    const products = await loadProducts();
    const idx = products.findIndex((p) => String(p.id) === String(patch.id));

    if (idx >= 0) {
      products[idx] = { ...products[idx], ...patch };
    } else {
      products.push({
        id: patch.id,
        name: patch.name || patch.id,
        price: Number.isFinite(patch.price) ? patch.price : 0,
        stock: Number.isFinite(patch.stock) ? patch.stock : 0,
        volume: patch.volume || "",
        desc: patch.desc || "",
        image: patch.image || "",
      });
    }

    await saveProducts(products);
    res.json({ ok: true, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** 画像アップロード */
app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    const fn = req.file?.filename || "";
    res.json({ ok: true, filename: fn, url: `${BASE_URL}/public/uploads/${fn}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ============ LINE Webhook ============
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
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

async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";
  if (userId) {
    try {
      await touchUser(userId, "seen");
      await upsertLineProfile(userId);
    } catch {}
  }

  if (ev.type !== "message" || ev.message.type !== "text") return;

  const textRaw = ev.message.text || "";
  const text = String(textRaw).trim();

  // セッションがあるなら優先
  const sess = userId ? getSession(userId) : null;

  // ===== キャンセル =====
  if (/^キャンセル$/.test(text)) {
    if (userId) clearSession(userId);
    return client.replyMessage(ev.replyToken, { type: "text", text: "キャンセルしました。" });
  }

  // ===== 起動キーワード（セッション無しの時だけ厳格に）=====
  const isBoot = text === "直接注文" || text === "久助";
  if (!sess && !isBoot && !/^注文\s+/.test(text) && !/^確定\s+/.test(text) && !/^久助\s*\d{1,2}$/.test(text)) {
    // それ以外は無反応（要望通り）
    return;
  }

  // ===== 直接注文：商品一覧を返す =====
  if (text === "直接注文") {
    await touchUser(userId, "chat");
    const products = await loadProducts();
    // 一覧を返す（Flex）
    return client.replyMessage(ev.replyToken, [
      { type: "text", text: "商品一覧です。『この商品を注文』を押してください。" },
      productFlex(products),
    ]);
  }

  // ===== 久助：案内 =====
  if (text === "久助") {
    await touchUser(userId, "chat");
    // セッションに「久助の数量待ち」
    setSession(userId, "kusuke_qty", {});
    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: "久助の個数を送ってください。\n例）久助 3",
    });
  }

  // ===== 「久助 3」形式（セッション無しでも許可）=====
  const mK = /^久助\s*(\d{1,2})$/.exec(text.replace(/[　]+/g, " "));
  if (mK) {
    await touchUser(userId, "chat");
    const qty = Number(mK[1]);
    if (qty < 1 || qty > 99) {
      return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 で入力してください。" });
    }

    const product = await getProductById("kusuke-250");
    if (!product) {
      return client.replyMessage(ev.replyToken, { type: "text", text: "久助の商品データが見つかりません。" });
    }

    const stock = Number(product.stock || 0);
    if (stock < qty) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `在庫が不足です（在庫 ${stock}）。個数を減らして再送してください。`,
      });
    }

    // ★住所をDBから取得して送料計算できるようにする（今回の重要修正）
    let address = null;
    if (pool && userId) {
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

    // セッションに「確定待ち」
    setSession(userId, "confirm", { productId: product.id, qty });

    return client.replyMessage(ev.replyToken, [
      { type: "text", text: "久助の注文内容です。" },
      confirmFlex(product, qty, address),
    ]);
  }

  // ===== 「注文 productId」ボタン =====
  const mOrder = /^注文\s+(.+)$/.exec(text);
  if (mOrder) {
    await touchUser(userId, "chat");
    const pid = String(mOrder[1]).trim();
    const product = await getProductById(pid);
    if (!product) {
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
    }
    setSession(userId, "qty", { productId: pid });
    return client.replyMessage(ev.replyToken, { type: "text", text: "数量を送ってください（例：3）" });
  }

  // ===== 数量入力（セッション qty）=====
  if (sess?.mode === "qty") {
    await touchUser(userId, "chat");
    const qty = Number(text);
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) {
      return client.replyMessage(ev.replyToken, { type: "text", text: "数量は 1〜99 の数字で送ってください。" });
    }
    const product = await getProductById(sess.data.productId);
    if (!product) {
      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
    }

    const stock = Number(product.stock || 0);
    if (stock < qty) {
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `在庫が不足です（在庫 ${stock}）。数量を減らして送ってください。`,
      });
    }

    let address = null;
    if (pool && userId) {
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

    setSession(userId, "confirm", { productId: product.id, qty });
    return client.replyMessage(ev.replyToken, [
      { type: "text", text: "注文内容です。" },
      confirmFlex(product, qty, address),
    ]);
  }

  // ===== 確定（確定 productId qty）=====
  const mFix = /^確定\s+(\S+)\s+(\d{1,2})$/.exec(text);
  if (mFix) {
    await touchUser(userId, "chat");
    const pid = String(mFix[1]);
    const qty = Number(mFix[2]);

    const product = await getProductById(pid);
    if (!product) {
      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
    }

    // 住所取得
    let addressRow = null;
    if (pool && userId) addressRow = await dbGetAddressByUserId(userId);

    if (!addressRow) {
      // 住所登録導線はあなたのLIFFに合わせて変更してOK
      clearSession(userId);
      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: "住所が未登録のため確定できません。\n先に住所登録（LIFF）をお願いします。",
      });
    }

    const addressObj = {
      name: addressRow.name || "",
      phone: addressRow.phone || "",
      postal: addressRow.postal || "",
      prefecture: addressRow.prefecture || "",
      city: addressRow.city || "",
      address1: addressRow.address1 || "",
      address2: addressRow.address2 || "",
    };

    // 送料計算（久助はあかしゃ扱いで統一済み）
    const items = [{ id: product.id, name: product.name, qty, price: Number(product.price || 0) }];
    const ship = calcShippingUnified(items, addressObj.prefecture);
    const subtotal = Number(product.price || 0) * qty;
    const total = subtotal + ship.fee;

    // 在庫減算（Disk products.json）
    const products = await loadProducts();
    const idx = products.findIndex((p) => String(p.id) === String(product.id));
    if (idx >= 0) {
      const stock = Number(products[idx].stock || 0);
      if (stock < qty) {
        clearSession(userId);
        return client.replyMessage(ev.replyToken, { type: "text", text: `在庫が不足です（在庫 ${stock}）。` });
      }
      products[idx].stock = stock - qty;
      await saveProducts(products);
    }

    // 注文保存（DB）
    if (pool) {
      await pool.query(
        `
        INSERT INTO orders (user_id, source, items, total, shipping_fee, payment_method, status, name, zip, pref, address, raw_event)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
        [
          userId,
          "line",
          items,
          total,
          ship.fee,
          "cod",
          "new",
          addressObj.name,
          addressObj.postal,
          addressObj.prefecture,
          `${addressObj.city}${addressObj.address1}${addressObj.address2 ? " " + addressObj.address2 : ""}`,
          ev,
        ]
      );
    }

    clearSession(userId);

    // 管理者通知（任意）
    if (ADMIN_USER_ID) {
      try {
        await client.pushMessage(ADMIN_USER_ID, {
          type: "text",
          text: `【新規注文】\n${product.name} x${qty}\n小計:${subtotal}円\n送料:${ship.fee}円(サイズ${ship.size})\n合計:${total}円\n\n${addressObj.name}\n〒${addressObj.postal}\n${addressObj.prefecture}${addressObj.city}${addressObj.address1}\n${addressObj.address2 || ""}`,
        });
      } catch {}
    }

    return client.replyMessage(ev.replyToken, {
      type: "text",
      text: `ご注文を受け付けました。\n\n${product.name} x${qty}\n小計：${subtotal}円\n送料：${ship.fee}円（サイズ${ship.size}）\n合計：${total}円\n\n発送準備ができ次第ご連絡します。`,
    });
  }

  // ここまで来たら、セッション中の想定外入力
  if (sess) {
    return client.replyMessage(ev.replyToken, { type: "text", text: "入力が確認できませんでした。もう一度お願いします。（キャンセルも可）" });
  }
}

// ============ Start ============
(async () => {
  try {
    await ensureDb();
    // products.json が無いなら初期生成（上書きはしない）
    if (!fs.existsSync(PRODUCTS_FILE)) {
      const initial = await loadProducts();
      await saveProducts(initial);
    }
  } catch (e) {
    console.error("init error:", e);
  }

  app.listen(PORT, () => console.log(`server listening on ${PORT}`));
})();
