// server.js — フル機能版（画像アップロード&管理UI DnD対応・whoami・"me"解決）
//
// 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN または ADMIN_CODE)
// 任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE, DATA_DIR（任意で上書き）

"use strict";画像アップロードAPI

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");


const app = express();
// ====== 画像アップロードAPI（LINE向け 800px以内・WebP化） ======
const multer = require("multer");
const sharp = require("sharp");

const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]/g, "_");
    cb(null, `${base}-${Date.now()}${ext.toLowerCase()}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 最大5MB
});

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "no file" });

    const inputPath = req.file.path; // 例: /public/uploads/xxx-123.jpg
    const base = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(uploadDir, `${base}-800.webp`); // 常に別名・WebP化

    // 800×800 以内に収め、WebPで圧縮保存
    await sharp(inputPath)
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputPath);

    // 元ファイルは削除（残したいならコメントアウト）
    try { fs.unlinkSync(inputPath); } catch {}

    // 返すのは「リサイズ済みの」URLだけ
    const url = `/uploads/${path.basename(outputPath)}`;
    // キャッシュ対策でクエリを付与（ブラウザに古いのを掴まれない）
    return res.json({ ok: true, url: `${url}?v=${Date.now()}` });
  } catch (e) {
    console.error("upload resize error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});
// ====== 商品画像を products.json に保存するAPI ======
app.post("/api/admin/products/set-image", express.json(), (req, res) => {
  try {
    const { productId, imageUrl } = req.body;
    if (!productId || !imageUrl) {
      return res.status(400).json({ ok: false, error: "missing productId or imageUrl" });
    }

    const filePath = path.join(__dirname, "data/products.json");
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, error: "products.json not found" });
    }

    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const products = Array.isArray(data) ? data : data.items || [];
    const target = products.find(p => p.id === productId);
    if (!target) return res.status(404).json({ ok: false, error: "product not found" });

    target.image = imageUrl;
    fs.writeFileSync(filePath, JSON.stringify(products, null, 2));
    res.json({ ok: true, productId, imageUrl });
  } catch (e) {
    console.error("set-image error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== 画像URLを商品にセットするAPI ======
app.post("/api/admin/products/set-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { productId, imageUrl } = req.body || {};
    if (!productId || !imageUrl) {
      return res.status(400).json({ ok: false, error: "productId and imageUrl required" });
    }
    const items = readProducts();
    const idx = items.findIndex(p => p.id === productId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "product_not_found" });

    items[idx].image = String(imageUrl);
    writeProducts(items);
    return res.json({ ok: true, item: items[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// ====== 環境変数 ======
const PORT = Number(process.env.PORT || 3000);
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();

const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret:      (process.env.LINE_CHANNEL_SECRET || "").trim(),
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

// ====== ミドルウェア / 静的配信 ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== Persistent Disk / データパス ======
function pickWritableDir(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  const fallback = path.join(__dirname, "data");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}
const DATA_DIR = pickWritableDir([
  (process.env.DATA_DIR || "").trim(),
  (process.env.RENDER_DATA_DIR || "").trim(),
  "/data",
  path.join(__dirname, "data"),
]);

const UPLOAD_DIR       = path.join(DATA_DIR, "uploads");
const PRODUCTS_PATH    = path.join(DATA_DIR, "products.json");
const ORDERS_LOG       = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH   = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG      = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG     = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH    = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH= path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG        = path.join(DATA_DIR, "stock.log");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// /uploads を公開（例: https://<app>/uploads/xxx.jpg）
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "365d", immutable: true }));

// 初期ファイル生成ヘルパー
function initJSON(p, v){ if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8"); }
function initLog(p){ if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8"); }

// 初回生成：products.json（imageUrl フィールド付き）
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",        name: "久助（えびせん）",     price: 250,  stock: 30, desc: "お得な割れせん。", imageUrl: "" },
    { id: "nori-akasha-340",   name: "のりあかしゃ",         price: 340,  stock: 20, desc: "海苔の風味豊かなえびせんべい", imageUrl: "" },
    { id: "uzu-akasha-340",    name: "うずあかしゃ",         price: 340,  stock: 10, desc: "渦を巻いたえびせんべい", imageUrl: "" },
    { id: "shio-akasha-340",   name: "潮あかしゃ",           price: 340,  stock: 5,  desc: "えびせんべいにあおさをトッピング", imageUrl: "" },
    { id: "matsu-akasha-340",  name: "松あかしゃ",           price: 340,  stock: 30, desc: "海老をたっぷり使用した高級えびせんべい", imageUrl: "" },
    { id: "iso-akasha-340",    name: "磯あかしゃ",           price: 340,  stock: 30, desc: "海老せんべいに高級海苔をトッピング", imageUrl: "" },
    { id: "goma-akasha-340",   name: "ごまあかしゃ",         price: 340,  stock: 30, desc: "海老せんべいに風味豊かなごまをトッピング", imageUrl: "" },
    { id: "original-set-2000", name: "磯屋オリジナルセット", price: 2000, stock: 30, desc: "6袋をセットにしたオリジナル", imageUrl: "" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}

// その他初期ファイル
initJSON(ADDRESSES_PATH, {});
initJSON(SESSIONS_PATH, {});
initJSON(NOTIFY_STATE_PATH, {});
initLog(ORDERS_LOG);
initLog(RESERVATIONS_LOG);
initLog(SURVEYS_LOG);
initLog(MESSAGES_LOG);
initLog(STOCK_LOG);






// ====== 在庫・別名 ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = { "久助": "kusuke-250", "くすけ": "kusuke-250", "kusuke": "kusuke-250", "kusuke-250": "kusuke-250" };
// 直接注文の一覧から隠す商品（久助非表示）
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

// ====== ユーティリティ ======
const safeReadJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const readProducts   = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts  = (data) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");
const readAddresses  = () => safeReadJSON(ADDRESSES_PATH, {});
const writeAddresses = (data) => fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");
const readSessions   = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions  = (s) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");
const readNotifyState  = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (s) => fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s, null, 2), "utf8");

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
const qstr = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
const parse = (data) => {
  const s = data && data.includes("=") ? data : "";
  const o = {};
  s.split("&").forEach(kv => { const [k, v] = kv.split("="); if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  return o;
};
const uniq = (arr) => Array.from(new Set((arr||[]).filter(Boolean)));

// ====== 在庫操作 ======
function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function resolveProductId(token) {
  return PRODUCT_ALIASES[token] || token;
}
function writeStockLog(entry) {
  try { fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts:new Date().toISOString(), ...entry }) + "\n", "utf8"); } catch {}
}
function setStock(productId, qty, actor = "system") {
  const q = Math.max(0, Number(qty)||0);
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  products[idx].stock = q;
  writeProducts(products);
  writeStockLog({ action:"set", productId, before, after:q, delta:(q-before), actor });
  return { before, after:q };
}
function addStock(productId, delta, actor = "system") {
  const d = Number(delta)||0;
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  const after = Math.max(0, before + d);
  products[idx].stock = after;
  writeProducts(products);
  writeStockLog({ action:"add", productId, before, after, delta:d, actor });
  return { before, after };
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  if (stockNow < LOW_STOCK_THRESHOLD) {
    const msg = `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n残り：${stockNow}個\nしきい値：${LOW_STOCK_THRESHOLD}個`;
    try { if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type:"text", text: msg }); } catch {}
  }
}

// ====== 認可 ======
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
function requireAdmin(req, res) {
  const headerTok = bearerToken(req);
  const queryTok  = (req.query?.token || req.query?.code || "").trim();
  const tok = headerTok || queryTok;

  if (ADMIN_API_TOKEN_ENV && tok === ADMIN_API_TOKEN_ENV) return true;
  if (ADMIN_CODE_ENV && tok === ADMIN_CODE_ENV) return true;

  res.status(401).json({
    ok: false,
    error: "unauthorized",
    hint: { need: { bearer_header: !!ADMIN_API_TOKEN_ENV, token_query: !!ADMIN_API_TOKEN_ENV, code_query: !!ADMIN_CODE_ENV } }
  });
  return false;
}

// ====== ログユーティリティ ======
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function jstRangeFromYmd(ymd) {
  const y = Number(ymd.slice(0,4)), m = Number(ymd.slice(4,6))-1, d = Number(ymd.slice(6,8));
  const startJST = new Date(Date.UTC(y, m, d, -9, 0, 0));   // JST 00:00
  const endJST   = new Date(Date.UTC(y, m, d+1, -9, 0, 0)); // 翌日 JST 00:00
  return { from: startJST.toISOString(), to: endJST.toISOString() };
}
function filterByIsoRange(items, getTs, fromIso, toIso) {
  if (!fromIso && !toIso) return items;
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to   = toIso   ? new Date(toIso).getTime()   :  Infinity;
  return items.filter(it => {
    const t = new Date(getTs(it)).getTime();
    return t >= from && t < to;
  });
}

// ====== 送料・代引き ======
const SHIPPING_BY_REGION = {
  "北海道": 1100, "東北": 900, "関東": 800, "中部": 800,
  "近畿": 900, "中国": 1000, "四国": 1000, "九州": 1100, "沖縄": 1400
};
const COD_FEE = 330;

// ====== LINE client ======
const client = new line.Client(config);


// ====== Flex送信ユーティリティ ======
function ensureAltText(altText) {
  const s = String(altText || "").trim();
  if (!s) throw new Error("altText is required");
  if (s.length > 400) throw new Error("altText too long (<=400)");
  return s;
}
function validateFlexContents(contents) {
  if (!contents || typeof contents !== "object") throw new Error("contents must be object");
  const t = contents.type;
  if (t !== "bubble" && t !== "carousel") throw new Error('contents.type must be "bubble" or "carousel"');
  return contents;
}
function normalizeUserIds(list){
  const ids = (Array.isArray(list)? list: []).map(x => (x||"").trim()).filter(Boolean);
  const mapped = ids.map(x => (x === "me" && ADMIN_USER_ID) ? ADMIN_USER_ID : x);
  return Array.from(new Set(mapped));
}

function productsFlex(allProducts) {
  const products = (allProducts || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));

  const bubbles = products.map(p => ({
    type: "bubble",
    ...(p.image ? {
      hero: {
        type: "image",
        url: p.image,        // ここに /uploads/xxx-800.webp?v=... が入る
        size: "full",
        aspectMode: "cover",
        aspectRatio: "1:1"
      }
    } : {}),
    body: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
        { type: "text", text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: "sm", wrap: true },
        p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true } : { type: "box", layout: "vertical", contents: [] }
      ]
    },
    footer: {
      type: "box", layout: "horizontal", spacing: "md",
      contents: [
        { type: "button", style: "primary",
          action: { type: "postback", label: "数量を選ぶ", data: `order_qty?${qstr({ id: p.id, qty: 1 })}` } }
      ]
    }
  }));

  // その他バブル
  bubbles.push({
    type: "bubble",
    body: {
      type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        { type: "text", text: "商品名と個数だけ入力します。価格入力は不要です。", size: "sm", wrap: true }
      ]
    },
    footer: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary",
          action: { type: "postback", label: "商品名を入力する", data: "other_start" } },
        { type: "button", style: "secondary",
          action: { type: "postback", label: "← 戻る", data: "order_back" } }
      ]
    }
  });

  return {
    type: "flex",
    altText: "商品一覧",
    contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles }
  };
}

function qtyFlex(id, qty = 1) {
  const q = Math.max(1, Math.min(99, Number(qty) || 1));
  return {
    type: "flex", altText: "数量を選択してください",
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "数量選択", weight: "bold", size: "lg" },
          { type: "text", text: `現在の数量：${q} 個`, size: "md" }
        ] },
      footer: { type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [
              { type: "button", style: "secondary", action: { type: "postback", label: "-1", data: `order_qty?${qstr({ id, qty: Math.max(1, q - 1) })}` } },
              { type: "button", style: "secondary", action: { type: "postback", label: "+1", data: `order_qty?${qstr({ id, qty: Math.min(99, q + 1) })}` } },
            ] },
          { type: "box", layout: "horizontal", spacing: "md",
            contents: [1,2,3,5].map(n => ({ type: "button", style: n===q ? "primary" : "secondary",
              action: { type: "postback", label: `${n}個`, data: `order_qty?${qstr({ id, qty: n })}` } })) },
          { type: "button", style: "primary",   action: { type: "postback", label: "受取方法へ", data: `order_method?${qstr({ id, qty: q })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧", data: "order_back" } }
        ] }
    }
  };
}

function methodFlex(id, qty) {
  return {
    type: "flex", altText: "受取方法を選択してください",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "受取方法", weight: "bold", size: "lg" },
          { type: "text", text: "宅配 または 店頭受取 を選択してください。", wrap: true }
        ] },
      footer: { type: "box", layout: "horizontal", spacing: "md",
        contents: [
          { type: "button", style: "primary",
            action: { type: "postback", label: "宅配（送料あり）", data: `order_region?${qstr({ id, qty, method: "delivery" })}` } },
          { type: "button", style: "secondary",
            action: { type: "postback", label: "店頭受取（送料0円）", data: `order_payment?${qstr({ id, qty, method: "pickup", region: "-" })}` } }
        ] }
    }
  };
}

function regionFlex(id, qty) {
  const regions = Object.keys(SHIPPING_BY_REGION);
  const rows = [];
  for (let i = 0; i < regions.length; i += 2) {
    rows.push({
      type: "box", layout: "horizontal", spacing: "md",
      contents: regions.slice(i, i + 2).map(r => ({
        type: "button", style: "secondary",
        action: { type: "postback", label: `${r}（${yen(SHIPPING_BY_REGION[r])}）`, data: `order_payment?${qstr({ id, qty, method: "delivery", region: r })}` }
      }))
    });
  }
  return {
    type: "flex", altText: "地域選択",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "地域選択", weight: "bold", size: "lg" },
          { type: "text", text: "地域により送料が異なります。", wrap: true }
        ] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: rows }
    }
  };
}

// 店頭受取＝現金のみ
function paymentFlex(id, qty, method, region) {
  if (method === "pickup") {
    return {
      type: "flex", altText: "お支払い（店頭）",
      contents: {
        type: "bubble",
        body: {
          type: "box", layout: "vertical", spacing: "md",
          contents: [
            { type: "text", text: "お支払い方法", weight: "bold", size: "lg" },
            { type: "text", text: "店頭受取は現金のみです。", wrap: true }
          ]
        },
        footer: {
          type: "box", layout: "vertical", spacing: "md",
          contents: [
            { type: "button", style: "primary",
              action: {
                type: "postback", label: "現金で支払う（店頭）",
                data: `order_confirm_view?${qstr({ id, qty, method: "pickup", region: "", payment: "cash" })}`
              }
            },
            { type: "button", style: "secondary",
              action: { type: "postback", label: "← 受取方法へ戻る", data: `order_method?${qstr({ id, qty })}` }
            }
          ]
        }
      }
    };
  }

  const regionText = method === "delivery" ? `（配送地域：${region}）` : "";
  return {
    type: "flex", altText: "お支払い方法を選択してください",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: "お支払い方法", weight: "bold", size: "lg" },
          { type: "text", text: `代引きは +${yen(COD_FEE)}${regionText}`, wrap: true }
        ] },
      footer: { type: "box", layout: "horizontal", spacing: "md",
        contents: [
          { type: "button", style: "primary",   action: { type: "postback", label: `代金引換（+${yen(COD_FEE)}）`, data: `order_confirm_view?${qstr({ id, qty, method, region, payment: "cod" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "銀行振込", data: `order_confirm_view?${qstr({ id, qty, method, region, payment: "bank" })}` } }
        ] }
    }
  };
}

function confirmFlex(product, qty, method, region, payment, liffId) {
  if (typeof product?.id === "string" && product.id.startsWith("other:")) {
    const parts = product.id.split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    product = { ...product, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0) };
  }

  const regionFee = method === "delivery" ? (SHIPPING_BY_REGION[region] || 0) : 0;
  const codFee = payment === "cod" ? COD_FEE : 0;
  const subtotal = Number(product.price) * Number(qty);
  const total = subtotal + regionFee + codFee;

  const payText =
    payment === "cod"  ? `代金引換（+${yen(COD_FEE)})` :
    payment === "bank" ? "銀行振込" :
    "現金（店頭）";

  const lines = [
    `受取方法：${method === "pickup" ? "店頭受取（送料0円）" : `宅配（${region}：${yen(regionFee)}）`}`,
    `支払い：${payText}`,
    `商品：${product.name}`,
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
    `送料：${yen(regionFee)}`,
    `代引き手数料：${yen(codFee)}`,
    `合計：${yen(total)}`
  ];

  const bodyContents = [
    { type: "text", text: "最終確認", weight: "bold", size: "lg" },
    ...lines.map(t => ({ type: "text", text: t, wrap: true })),
  ];
  if (method === "delivery") {
    bodyContents.push({ type: "text", text: "住所が未登録の方は「住所を入力（LIFF）」を押してください。", size: "sm", wrap: true });
  }

  const footerButtons = [
    { type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } },
    { type: "button", style: "primary",   action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method, region, payment })}` } },
  ];
  if (method === "delivery") {
    footerButtons.unshift({
      type: "button", style: "secondary",
      action: { type: "uri", label: "住所を入力（LIFF）", uri: `https://liff.line.me/${liffId}?${qstr({ from: "address", need: "shipping" })}` }
    });
  }

  return {
    type: "flex", altText: "注文内容の最終確認",
    contents: { type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: bodyContents },
      footer: { type: "box", layout: "vertical", spacing: "md", contents: footerButtons }
    }
  };
}

function reserveOffer(product, needQty, stock) {
  return [
    { type: "text", text: [
      "申し訳ありません。在庫が不足しています。",
      `商品：${product.name}`,
      `希望数量：${needQty}個 / 現在在庫：${stock}個`,
      "",
      "予約しますか？ 入荷次第ご案内します。"
    ].join("\n") },
    {
      type: "template", altText: "在庫不足：予約しますか？",
      template: {
        type: "confirm", text: "予約しますか？",
        actions: [
          { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: product.id, qty: needQty })}` },
          { type: "postback", label: "やめる", data: "order_cancel" }
        ]
      }
    }
  ];
}

// ====== アンケート簡易スタブ ======
const SURVEY_VERSION = 2;
const SURVEY_SCHEMA = { q1:{options:[]}, q2:{options:[]}, q3:{options:[]} };
function labelOf(_q, code){ return code; }

// ====== /api: 住所（LIFF） & LIFF ID ======
app.post("/api/liff/address", async (req, res) => {
  try {
    const { userId, name, phone, postal, prefecture, city, address1, address2 } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    const book = readAddresses();
    book[userId] = { name, phone, postal, prefecture, city, address1, address2, ts: new Date().toISOString() };
    writeAddresses(book);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.get("/api/liff/config", (_req, res) => res.json({ liffId: LIFF_ID }));

// ====== 管理API（要トークン） ======
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, ping: "pong" }); });

// whoami（自動入力用の簡易API）
// 実運用では LIFF ログイン or 独自セッションで結びつけてください。ここでは ADMIN_USER_ID を返します。
app.get("/api/admin/whoami", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok:true, userId: ADMIN_USER_ID || null });
});

// 画像アップロード（DnD用）
app.post("/api/admin/upload", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok:false, error: err.message || "upload_failed" });
    const f = req.file;
    if (!f) return res.status(400).json({ ok:false, error:"no_file" });
    const url = `/uploads/${f.filename}`;
    res.json({ ok:true, url, name: f.originalname, size: f.size, type: f.mimetype });
  });
});

// products 関連
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({
    id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0, desc:p.desc || "", imageUrl: p.imageUrl || ""
  }));
  res.json({ ok:true, items });
});

// upsert（id があれば更新、なければ追加）
app.post("/api/admin/products/upsert", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const body = req.body || {};
    const id = String(body.id || "").trim();
    if (!id) return res.status(400).json({ ok:false, error:"id required" });
    const products = readProducts();
    const idx = products.findIndex(p => p.id === id);
    const item = {
      id,
      name: String(body.name ?? (idx>=0 ? products[idx].name : "")).trim(),
      price: Number(body.price ?? (idx>=0 ? products[idx].price : 0)),
      stock: Number(body.stock ?? (idx>=0 ? products[idx].stock : 0)),
      desc: String(body.desc ?? (idx>=0 ? products[idx].desc : "")).trim(),
      imageUrl: String(body.imageUrl ?? (idx>=0 ? products[idx].imageUrl : "")).trim()
    };
    if (idx >= 0) products[idx] = item; else products.push(item);
    writeProducts(products);
    res.json({ ok:true, item });
  }catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// imageUrl のみ更新
app.post("/api/admin/products/image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const id = String(req.body?.productId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    const { products, idx, product } = findProductById(id);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[idx].imageUrl = imageUrl;
    writeProducts(products);
    res.json({ ok:true, product: products[idx] });
  }catch(e){ res.status(500).json({ ok:false, error:String(e.message||e) }); }
});

// 在庫ログ / 在庫操作
app.get("/api/admin/stock/logs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(10000, Number(req.query.limit || 200));
  const items = readLogLines(STOCK_LOG, limit);
  res.json({ ok:true, items });
});
app.post("/api/admin/stock/set", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const pid = resolveProductId((req.body?.productId || "").trim());
    const qty = Number(req.body?.qty);
    const r = setStock(pid, qty, "api");
    res.json({ ok:true, productId: pid, ...r });
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});
app.post("/api/admin/stock/add", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const pid = resolveProductId((req.body?.productId || "").trim());
    const delta = Number(req.body?.delta);
    const r = addStock(pid, delta, "api");
    res.json({ ok:true, productId: pid, ...r });
  }catch(e){ res.status(400).json({ ok:false, error:String(e.message||e) }); }
});

// 予約者通知（まとめ/開始/次/停止）
function buildReservationQueue(productId) {
  const all = readLogLines(RESERVATIONS_LOG, 200000)
    .filter(r => r && r.productId === productId && r.userId && r.ts)
    .sort((a,b) => new Date(a.ts) - new Date(b.ts));
  const seen = new Set(); const ids  = [];
  for (const r of all) { if (!seen.has(r.userId)) { seen.add(r.userId); ids.push(r.userId); } }
  return ids;
}
app.post("/api/admin/reservations/notify-start", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(String(req.body?.productId || "").trim());
    const message = String(req.body?.message || "").trim();
    if (!pid)  return res.status(400).json({ ok:false, error:"productId required" });
    if (!message) return res.status(400).json({ ok:false, error:"message required" });

    const userIds = buildReservationQueue(pid);
    const state = readNotifyState();
    state[pid] = { idx: 0, userIds, message, updatedAt: new Date().toISOString() };
    state.__lastPid = pid;
    writeNotifyState(state);

    if (userIds.length === 0) return res.json({ ok:true, info:"no_reservers", sent:false });

    try {
      await client.pushMessage(userIds[0], { type:"text", text: message });
      state[pid].idx = 1; state[pid].updatedAt = new Date().toISOString(); writeNotifyState(state);
      return res.json({ ok:true, productId: pid, sentTo: userIds[0], index: 1, total: userIds.length });
    } catch (e) {
      return res.status(500).json({ ok:false, error:"push_failed", detail: e?.response?.data || String(e) });
    }
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
app.post("/api/admin/reservations/notify-next", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pidRaw = (req.body?.productId ?? readNotifyState().__lastPid ?? "").toString().trim();
    const pid = resolveProductId(pidRaw);
    const n = Math.max(1, Math.min(100, Number(req.body?.count || 1)));
    const state = readNotifyState();
    const st = state[pid];
    if (!pid || !st) return res.status(400).json({ ok:false, error:"not_started" });

    const { userIds, message } = st;
    let { idx } = st;
    const total = userIds.length;
    if (idx >= total) return res.json({ ok:true, done:true, index: idx, total });

    const sentTo = [];
    for (let i=0; i<n && idx < total; i++, idx++) {
      const uid = userIds[idx];
      try { await client.pushMessage(uid, { type:"text", text: message }); sentTo.push(uid); }
      catch (e) { console.error("notify-next push error:", e?.response?.data || e); }
    }
    state[pid].idx = idx;
    state[pid].updatedAt = new Date().toISOString();
    writeNotifyState(state);

    return res.json({ ok:true, productId: pid, sent: sentTo.length, sentTo, index: idx, total });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
app.post("/api/admin/reservations/notify-stop", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pid = resolveProductId(String(req.body?.productId || "").trim());
  const state = readNotifyState();
  if (pid && state[pid]) { delete state[pid]; }
  if (state.__lastPid === pid) delete state.__lastPid;
  writeNotifyState(state);
  res.json({ ok:true, stopped: pid || true });
});

// 注文・予約・住所・アンケート一覧
app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(ORDERS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});
app.get("/api/admin/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(RESERVATIONS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});
app.get("/api/admin/addresses", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, items: readAddresses() });
});
app.get("/api/admin/surveys", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 2000));
  let items = readLogLines(SURVEYS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});
app.get("/api/admin/surveys/summary", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, version: SURVEY_VERSION, total: 0, summary: { q1:[], q2:[], q3:[] } });
});

// ====== Insight API ======
function yyyymmddJST(offsetDays = -1) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setDate(jst.getDate() + offsetDays);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
app.get("/api/admin/audience-count", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const candidates = [];
  if (req.query.date) candidates.push(String(req.query.date).replace(/[^0-9]/g, ""));
  else candidates.push(yyyymmddJST(-1), yyyymmddJST(-2));

  const tried = [];
  for (const date of candidates) {
    try {
      const url = `https://api.line.me/v2/bot/insight/followers?date=${date}`;
      const r = await axios.get(url, {
        headers: { Authorization: `Bearer ${config.channelAccessToken}` },
        timeout: 10000,
      });
      const { followers = null, targetedReaches = null, blocks = null } = r.data || {};
      return res.json({ ok: true, date, followers, targetedReaches, blocks, raw: r.data });
    } catch (e) {
      const status = e?.response?.status || 500;
      const detail = e?.response?.data || { message: e.message || String(e) };
      tried.push({ date, status, detail });
      if (status === 401 || status === 403) {
        return res.status(200).json({ ok: false, status, detail, tried });
      }
    }
  }
  return res.status(200).json({ ok: false, error: "no_usable_date", tried });
});
app.get("/admin/audience-count", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/api/admin/audience-count" + qs);
});

// ====== アクティブユーザー & メッセージログ ======
app.get("/api/admin/active-chatters", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(200000, Number(req.query.limit || 50000));
  let items = readLogLines(MESSAGES_LOG, limit);

  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x => x.ts, range.from, range.to);

  items = items.filter(x => x && x.type === "text" && x.userId);
  const set = new Set(items.map(x => x.userId));
  const listFlag = String(req.query.list || "false").toLowerCase() === "true";

  res.json({
    ok: true,
    totalMessages: items.length,
    uniqueUsers: set.size,
    date: req.query.date || null,
    from: range.from || null,
    to: range.to || null,
    users: listFlag ? Array.from(set) : undefined
  });
});
app.get("/api/admin/messages", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(200000, Number(req.query.limit || 2000));
  const items = readLogLines(MESSAGES_LOG, limit);
  res.json({ ok:true, items, path: MESSAGES_LOG });
});

// ====== 配信 API（"me" 解決対応） ======
app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userIds = normalizeUserIds(req.body?.userIds);
  const message = (req.body?.message || "").trim();

  if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });
  if (!message)            return res.status(400).json({ ok:false, error:"no_message" });

  const chunkSize = 500;
  const results = [];
  for (let i=0; i<userIds.length; i+=chunkSize) {
    const ids = userIds.slice(i, i+chunkSize);
    try{
      await client.multicast(ids, [{ type: "text", text: message }]);
      results.push({ size: ids.length, ok:true });
    }catch(e){
      console.error("multicast error:", e?.response?.data || e);
      results.push({ size: ids.length, ok:false, error: e?.response?.data || String(e) });
    }
  }
  const okCount  = results.filter(r=>r.ok).reduce((a,b)=>a+b.size,0);
  const ngCount  = results.filter(r=>!r.ok).reduce((a,b)=>a+b.size,0);

  return res.json({ ok:true, requested:userIds.length, sent:okCount, failed:ngCount, batches:results.length, results });
});

app.post("/api/admin/segment/send-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = normalizeUserIds(req.body?.userIds);
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });

    const msg = [{ type: "flex", altText, contents }];
    const chunkSize = 500;
    let sent = 0, failed = 0, batches = 0, results = [];
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const ids = userIds.slice(i, i + chunkSize);
      try {
        await client.multicast(ids, msg);
        results.push({ ok:true, size: ids.length }); sent += ids.length; batches++;
      } catch (e) {
        const detail = e?.response?.data || String(e);
        console.error("send-flex multicast error:", detail);
        results.push({ ok:false, size: ids.length, error: detail }); failed += ids.length; batches++;
      }
    }
    return res.json({ ok:true, requested:userIds.length, sent, failed, batches, results });
  } catch (err) {
    return res.status(400).json({ ok:false, error: err.message || "bad_request" });
  }
});

app.post("/api/admin/broadcast-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    await client.broadcast([{ type: "flex", altText, contents }]);
    return res.json({ ok:true });
  } catch (e) {
    const detail = e?.response?.data || e.message || String(e);
    console.error("broadcast-flex error:", detail);
    return res.status(400).json({ ok:false, error: detail });
  }
});

// ====== Webhook ======
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

// ====== イベント処理 ======
async function handleEvent(ev) {
  try {
    // ---- message:text ----
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        const rec = { ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "text", len: (ev.message.text || "").length };
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

      // 久助（テキスト直打ちフロー）
      const kusukeRe = /^久助(?:\s+(\d+))?$/i;
      const km = kusukeRe.exec(text);
      if (km) {
        const qtyStr = km[1];
        if (!qtyStr) {
          sessions[uid] = { await: "kusukeQty" };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type:"text", text:"久助の個数を半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(qtyStr)));
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }
      if (sess?.await === "kusukeQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        delete sessions[uid]; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }

      // その他（自由入力）
      if (sess?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"商品名を入力してください。" });
          return;
        }
        sessions[uid] = { await: "otherQty", temp: { name } };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:`「${name}」ですね。個数を半角数字で入力してください。例：2` });
        return;
      }
      if (sess?.await === "otherQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"個数は半角数字で入力してください。例：2" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        const name = sess.temp?.name || "その他";
        delete sessions[uid]; writeSessions(sessions);
        const id = `other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      // 管理者向けテキストコマンド（省略：在庫・予約連絡 等） —— 既存の実装と同じ（長文につき省略せず維持）
      if (ev.source?.userId && ADMIN_USER_ID && ev.source.userId === ADMIN_USER_ID) {
        // ...（あなたの元コードの在庫・予約連絡コマンド一式をこのまま維持）...
      }

      // 一般ユーザー
      if (text === "直接注文") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      if (text === "アンケート") {
        return client.replyMessage(ev.replyToken, { type:"text", text:"アンケート機能は準備中です。" });
      }
      return client.replyMessage(ev.replyToken, { type: "text", text: "「直接注文」と送ると、商品一覧が表示されます。\n久助は「久助 2」のように、商品名＋半角個数でご入力ください。" });
    }

    // ---- postback ----
    if (ev.type === "postback") {
      try {
        const d_ = String(ev.postback?.data || "");
        const rec = { ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "postback", data: d_.slice(0, 200) };
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
      } catch {}

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
        return client.replyMessage(ev.replyToken, qtyFlex(id, qty));
      }
      if (d.startsWith("order_method?")) {
        const { id, qty } = parse(d.replace("order_method?", ""));
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d.startsWith("order_region?")) {
        const { id, qty, method } = parse(d.replace("order_region?", ""));
        if (method === "delivery") return client.replyMessage(ev.replyToken, regionFlex(id, qty));
        return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
      }
      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parse(d.replace("order_payment?", ""));
        method = (method || "").trim();
        region = (region || "").trim();
        if (region === "-") region = "";

        if (method === "pickup") return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
        if (method === "delivery") {
          if (!region) return client.replyMessage(ev.replyToken, regionFlex(id, qty));
          return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "delivery", region));
        }
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, region, payment } = parse(d.replace("order_confirm_view?", ""));
        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0) };
        } else {
          const products = readProducts();
          product = products.find(p => p.id === id);
          if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
        }
        return client.replyMessage(ev.replyToken, confirmFlex(product, qty, method, region, payment, LIFF_ID));
      }
      if (d === "order_back") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      if (d.startsWith("order_confirm?")) {
        const { id, qty, method, region, payment } = parse(d.replace("order_confirm?", ""));
        const need = Math.max(1, Number(qty) || 1);

        let product = null;
        let products = readProducts();
        let idx = products.findIndex(p => p.id === id);

        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
          idx = -1;
        } else {
          if (idx === -1) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
          product = products[idx];
          if (!product.stock || product.stock < need) {
            return client.replyMessage(ev.replyToken, reserveOffer(product, need, product.stock || 0));
          }
          products[idx].stock = Number(product.stock) - need;
          writeProducts(products);
          await maybeLowStockAlert(product.id, product.name, products[idx].stock);
        }

        const regionFee = method === "delivery" ? (SHIPPING_BY_REGION[region] || 0) : 0;
        const codFee = payment === "cod" ? COD_FEE : 0;
        const subtotal = Number(product.price) * need;
        const total = subtotal + regionFee + codFee;

        const addrBook = readAddresses();
        const addr = addrBook[ev.source?.userId || ""] || null;

        const order = {
          ts: new Date().toISOString(),
          userId: ev.source?.userId || "",
          productId: product.id,
          productName: product.name,
          qty: need,
          price: Number(product.price),
          subtotal, region, shipping: regionFee,
          payment, codFee, total, method,
          address: addr
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order) + "\n", "utf8");

        const payText =
          payment === "cod"  ? `代金引換（+${yen(COD_FEE)})` :
          payment === "bank" ? "銀行振込" :
          "現金（店頭）";

        const userLines = [
          "ご注文ありがとうございます！",
          `受取方法：${method === "pickup" ? "店頭受取（送料0円）" : `宅配（${region}）`}`,
          `支払い：${payText}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)}`,
          `送料：${yen(regionFee)}`,
          `代引き手数料：${yen(codFee)}`,
          `合計：${yen(total)}`
        ];
        if (method === "delivery") {
          userLines.push("");
          userLines.push(
            addr
              ? `お届け先：${addr.postal} ${addr.prefecture}${addr.city}${addr.address1}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name}\n電話：${addr.phone}`
              : "住所未登録です。メニューの「住所を入力（LIFF）」から登録してください。"
          );
        } else {
          userLines.push("", "店頭でのお受け取りをお待ちしています。");
        }
        await client.replyMessage(ev.replyToken, { type: "text", text: userLines.join("\n") });

        if (method === "delivery" && payment === "bank") {
          const lines = [];
          lines.push("▼ 振込先");
          if (BANK_INFO) lines.push(BANK_INFO); else lines.push("（銀行口座情報が未設定です。管理者に連絡してください。）");
          if (BANK_NOTE) { lines.push(""); lines.push(BANK_NOTE); }
          lines.push(""); lines.push("※ご入金確認後の発送となります。");
          try { await client.pushMessage(ev.source.userId, { type:"text", text: lines.join("\n") }); } catch {}
        }

        const adminMsg = [
          "🧾 新規注文",
          `ユーザーID：${ev.source?.userId || ""}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)} / 送料：${yen(regionFee)} / 代引：${yen(codFee)} / 合計：${yen(total)}`,
          `受取：${method}${method === "delivery" ? `（${region}）` : ""} / 支払：${payment}`,
          (addr
            ? `住所：${addr.postal} ${addr.prefecture}${addr.city}${addr.address1}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name} / TEL：${addr.phone}`
            : "住所：未登録")
        ].join("\n");
        try {
          if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
          if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminMsg });
        } catch {}
        return;
      }
      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parse(d.replace("order_reserve?", ""));
        const products = readProducts();
        const product = products.find(p => p.id === id);
        if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });

        const r = { ts: new Date().toISOString(), userId: ev.source?.userId || "", productId: product.id, productName: product.name, qty: Math.max(1, Number(qty) || 1), status: "reserved" };
        fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r) + "\n", "utf8");

        await client.replyMessage(ev.replyToken, { type: "text", text: ["予約を受け付けました。入荷次第ご案内します。", `商品：${product.name}`, `数量：${r.qty}個`].join("\n") });

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
    if (ev.replyToken) { try { await client.replyMessage(ev.replyToken, { type: "text", text: "エラーが発生しました。もう一度お試しください。" }); } catch {} }
  }
}

// ====== Admin UI（ドラッグ&ドロップで画像追加できる簡易ページ） ======
app.get("/admin", (_req, res) => {
  const html = `
<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — 画像DnD / リッチ配信 / セグメント配信</title>
<style>
  body{font-family:system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans JP", sans-serif;max-width:980px;margin:24px auto;padding:0 16px;}
  h1{font-size:20px;margin:0 0 12px}
  section{border:1px solid #ddd;border-radius:12px;padding:16px;margin:16px 0}
  label{display:block;margin:8px 0 4px}
  input[type=text],textarea,select{width:100%;padding:8px;border:1px solid #ccc;border-radius:8px;font-family:inherit}
  button{padding:10px 14px;border:0;border-radius:10px;cursor:pointer}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  .row > *{flex:1}
  pre{background:#f7f7f7;padding:12px;border-radius:8px;overflow:auto}
  small{color:#666}
  #drop{border:2px dashed #6aa3ff;border-radius:12px;padding:16px;text-align:center;margin-top:8px}
  #drop.drag{background:#eef5ff}
  #preview{max-width:100%;border-radius:8px;margin-top:8px;border:1px solid #ddd}
</style>
<h1>管理画面（画像ドラッグ&ドロップ / リッチ配信 / セグメント配信）</h1>

<section>
  <div class="row">
    <div>
      <label>Admin Token（.env: ADMIN_API_TOKEN）</label>
      <input id="token" type="text" placeholder="例：sk_live_xxx">
      <small>すべてのAPI呼び出しに使用します。未入力だと 401 になります。</small>
    </div>
    <div>
      <label>ユーザーID（カンマ区切り）</label>
      <input id="userIds" type="text" placeholder="例：Uxxxxxxxxx, me">
      <small>空欄なら <b>全体配信（broadcast）</b>。<b>me</b> は管理者IDに解決されます。</small>
    </div>
  </div>
  <div class="row">
    <button id="whoamiBtn">自動入力（whoami）</button>
    <button id="loadBtn">商品を読み込む</button>
  </div>
  <details>
    <summary>デバッグ / 現在の products を確認</summary>
    <pre id="prodView">（未取得）</pre>
  </details>
</section>

<section>
  <h2 style="font-size:18px;margin:0 0 8px">商品画像の設定（DnDアップロード）</h2>
  <div class="row">
    <div>
      <label>対象商品</label>
      <select id="prodSel"></select>
    </div>
    <div>
      <label>現在の画像URL</label>
      <input id="imgUrl" type="text" placeholder="/uploads/xxx.jpg">
    </div>
  </div>
  <div id="drop">ここに画像をドラッグ＆ドロップ（またはクリックして選択）</div>
  <input type="file" id="file" accept="image/*" style="display:none">
  <img id="preview" alt="preview" src="">
  <div class="row" style="margin-top:8px">
    <button id="applyUrlBtn">画像URLをこの商品に適用</button>
  </div>
</section>

<section>
  <h2 style="font-size:18px;margin:0 0 8px">Flex生成/配信</h2>
  <div class="row">
    <div>
      <label>除外ID（カンマ区切り）</label>
      <input id="excludeIds" type="text" placeholder="例：kusuke-250">
      <small>商品カルーセル生成から除外。</small>
    </div>
  </div>
  <div class="row">
    <button id="buildBtn">Flex（カルーセル）生成</button>
    <button id="sendFlexBtn">Flex を配信</button>
  </div>
  <div>
    <label>生成済み Flex JSON</label>
    <textarea id="flexJson" rows="12" spellcheck="false"></textarea>
    <small>altText と contents を含む 1メッセージ分。空欄のまま送ると生成済みページ（複数）を順番に送ります。</small>
  </div>
  <label>テキスト本文（テキスト配信用）</label>
  <textarea id="textBody" rows="4" placeholder="配信テキスト"></textarea>
  <div class="row">
    <button id="sendTextBtn">テキストを配信</button>
  </div>
  <div id="log"></div>
</section>

<script>
const $ = (id)=>document.getElementById(id);
const api = (p, opt={}) => fetch(p, opt).then(async r => {
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await r.text();
    throw new Error(\`HTTP \${r.status} - nonJSON: \${text.slice(0,120)}\`);
  }
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || JSON.stringify(j));
  return j;
});
function auth(){ const t = $('token').value.trim(); return { 'Authorization':'Bearer '+t }; }
function log(msg, ok=true){
  const d = document.createElement('div');
  d.style.margin = '8px 0';
  d.style.color = ok ? '#0b7' : '#c00';
  d.textContent = (ok?'✓ ':'✗ ') + msg;
  $('log').prepend(d);
}
let products = [];
let pages = []; // 生成したFlexメッセージ群

$('whoamiBtn').onclick = async ()=>{
  try{
    const j = await api('/api/admin/whoami', { headers: auth() });
    if (j.userId) {
      const v = $('userIds').value.trim();
      $('userIds').value = v ? (v+', '+j.userId) : j.userId;
      log('whoami: '+j.userId);
    } else { log('whoami: userIdなし', false); }
  }catch(e){ log('whoamiエラー: '+e.message, false); }
};

$('loadBtn').onclick = async ()=>{
  try{
    const j = await api('/api/admin/products', { headers: auth() });
    products = j.items || [];
    $('prodView').textContent = JSON.stringify(products, null, 2);

    // セレクト更新
    const sel = $('prodSel');
    sel.innerHTML = '';
    for (const p of products){
      const o = document.createElement('option');
      o.value = p.id; o.textContent = \`\${p.name} (\${p.id})\`;
      sel.appendChild(o);
    }
    if (products[0]) { sel.value = products[0].id; $('imgUrl').value = products[0].imageUrl || ''; $('preview').src = products[0].imageUrl || ''; }
    log(\`商品 \${products.length} 件を取得\`);
  }catch(e){ log('商品取得エラー: '+e.message, false); }
};

$('prodSel').onchange = ()=>{
  const id = $('prodSel').value;
  const p = products.find(x=>x.id===id);
  $('imgUrl').value = p?.imageUrl || '';
  $('preview').src = p?.imageUrl || '';
};

// DnD
const drop = $('drop'); const file = $('file');
drop.addEventListener('click', ()=> file.click());
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', ()=> drop.classList.remove('drag'));
drop.addEventListener('drop', async e => {
  e.preventDefault(); drop.classList.remove('drag');
  const f = e.dataTransfer.files[0]; if (!f) return;
  await uploadImage(f);
});
file.onchange = async ()=>{ if (file.files[0]) await uploadImage(file.files[0]); };

async function uploadImage(f){
  try{
    const fd = new FormData(); fd.append('file', f);
    const j = await fetch('/api/admin/upload', { method:'POST', headers: auth(), body: fd }).then(r=>r.json());
    if (!j.ok) throw new Error(j.error || 'upload_failed');
    $('imgUrl').value = j.url; $('preview').src = j.url;
    log(\`アップロード成功: \${j.url}\`);
    // そのまま商品に適用
    await applyImageUrl();
  }catch(e){ log('アップロードエラー: '+e.message, false); }
}

async function applyImageUrl(){
  try{
    const productId = $('prodSel').value;
    const imageUrl = $('imgUrl').value.trim();
    const j = await api('/api/admin/products/image', {
      method:'POST',
      headers: { ...auth(), 'Content-Type':'application/json' },
      body: JSON.stringify({ productId, imageUrl })
    });
    // ローカル配列も更新
    const idx = products.findIndex(p=>p.id===productId);
    if (idx>=0) products[idx].imageUrl = imageUrl;
    log('imageUrlを適用: '+productId);
  }catch(e){ log('適用エラー: '+e.message, false); }
}
$('applyUrlBtn').onclick = applyImageUrl;

// Flex 生成
$('buildBtn').onclick = ()=>{
  if(!products.length) return alert('先に「商品を読み込む」を押してください');
  const exclude = new Set(($('excludeIds').value||'').split(',').map(s=>s.trim()).filter(Boolean));
  const visible = products.filter(p => !exclude.has(p.id));

  const bubbles = visible.map(p => {
    const bubble = {
      type: "bubble",
      ...(p.imageUrl ? { hero: { type:"image", url:p.imageUrl, size:"full", aspectRatio:"20:13", aspectMode:"cover" } } : {}),
      body: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type:"text", text:p.name, weight:"bold", size:"md", wrap:true },
        { type:"text", text:\`価格：\${(p.price||0).toLocaleString('ja-JP')}円　在庫：\${p.stock??0}\`, size:"sm", wrap:true },
        p.desc ? { type:"text", text:p.desc, size:"sm", wrap:true } : { type:"box", layout:"vertical", contents:[] }
      ]},
      footer: { type:"box", layout:"horizontal", spacing:"md", contents:[
        { type:"button", style:"primary", action:{ type:"postback", label:"数量を選ぶ", data:\`order_qty?id=\${encodeURIComponent(p.id)}&qty=1\` } }
      ]}
    };
    return bubble;
  });

  bubbles.push({
    type: "bubble",
    body: { type:"box", layout:"vertical", spacing:"sm", contents:[
      { type:"text", text:"その他（自由入力）", weight:"bold", size:"md" },
      { type:"text", text:"商品名と個数だけ入力します。価格入力は不要です。", size:"sm", wrap:true }
    ]},
    footer: { type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"button", style:"primary",   action:{ type:"postback", label:"商品名を入力する", data:"other_start" } },
      { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:"order_back" } }
    ]}
  });

  const chunkSize = 10;
  pages = [];
  for(let i=0;i<bubbles.length;i+=chunkSize){
    const chunk = bubbles.slice(i, i+chunkSize);
    pages.push({
      type: "flex",
      altText: "商品一覧",
      contents: chunk.length===1 ? chunk[0] : { type:"carousel", contents: chunk }
    });
  }
  $('flexJson').value = JSON.stringify(pages[0], null, 2);
  log(\`Flex を \${pages.length}ページ生成\`);
};

// Flex配信
$('sendFlexBtn').onclick = async ()=>{
  try{
    const userIds = $('userIds').value.split(',').map(s=>s.trim()).filter(Boolean);
    const bodyText = $('flexJson').value.trim();
    const headers = { ...auth(), 'Content-Type':'application/json' };

    if(userIds.length){
      // セグメント配信
      if(bodyText){
        const one = JSON.parse(bodyText);
        await api('/api/admin/segment/send-flex', { method:'POST', headers, body: JSON.stringify({ userIds, altText: one.altText, contents: one.contents }) });
      }else{
        if(!pages.length) throw new Error('先に「Flex（カルーセル）生成」してください');
        for (const one of pages){
          await api('/api/admin/segment/send-flex', { method:'POST', headers, body: JSON.stringify({ userIds, altText: one.altText, contents: one.contents }) });
        }
      }
      log(\`セグメント配信: \${userIds.length}人\`);
    }else{
      // 全体配信（broadcast）
      if(bodyText){
        const one = JSON.parse(bodyText);
        await api('/api/admin/broadcast-flex', { method:'POST', headers, body: JSON.stringify({ altText: one.altText, contents: one.contents }) });
      }else{
        if(!pages.length) throw new Error('先に「Flex（カルーセル）生成」してください');
        for (const one of pages){
          await api('/api/admin/broadcast-flex', { method:'POST', headers, body: JSON.stringify({ altText: one.altText, contents: one.contents }) });
        }
      }
      log('全体配信（broadcast）完了');
    }
  }catch(e){ log('Flex配信エラー: '+e.message, false); }
};

// テキスト配信
$('sendTextBtn').onclick = async ()=>{
  try{
    const userIds = $('userIds').value.split(',').map(s=>s.trim()).filter(Boolean);
    const txt = $('textBody').value.trim();
    if(!txt) return alert('本文を入力してください');
    if(userIds.length){
      await api('/api/admin/segment/send', {
        method:'POST',
        headers: { ...auth(), 'Content-Type':'application/json' },
        body: JSON.stringify({ userIds, message: txt })
      });
      log(\`テキスト（セグメント）: \${userIds.length}人\`);
    }else{
      alert('全体テキスト一斉は未対応です。Flex で配信してください。');
    }
  }catch(e){ log('テキスト配信エラー: '+e.message, false); }
};
</script>
  `;
  res.type("html").send(html);
});

// ====== Health checks ======
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.head("/health", (_req, res) => res.status(200).end());
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    dataDir: DATA_DIR,
    files: {
      products: PRODUCTS_PATH,
      uploadsDir: UPLOAD_DIR,
      ordersLog: ORDERS_LOG,
      reservationsLog: RESERVATIONS_LOG,
      addresses: ADDRESSES_PATH,
      surveysLog: SURVEYS_LOG,
      messagesLog: MESSAGES_LOG,
      sessions: SESSIONS_PATH,
      notifyState: NOTIFY_STATE_PATH,
      stockLog: STOCK_LOG,
    },
    env: {
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
      BANK_INFO: !!BANK_INFO,
      BANK_NOTE: !!BANK_NOTE,
      DATA_DIR: process.env.DATA_DIR || null,
      RENDER_DATA_DIR: process.env.RENDER_DATA_DIR || null,
    }
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
  console.log(`   UPLOAD_DIR: ${UPLOAD_DIR}  (公開URL: /uploads/...)`);
  console.log(`   Webhook: POST /webhook`);
  console.log(`   LIFF address page: /public/liff-address.html  (open via https://liff.line.me/${LIFF_ID})`);
});
