// server.js — 画像アップロード対応・Flex画像表示・配信/ログ・予約/在庫の基本機能つき
// 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN または ADMIN_CODE)
// 任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE, DATA_DIR, RENDER_DATA_DIR
// package.json には multer "^1.4.5-lts.1" を入れてください。

"use strict";

require("dotenv").config();

const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const multer = require("multer");

const app = express();

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
      fse.mkdirpSync(dir);
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  const fallback = path.join(__dirname, "data");
  fse.mkdirpSync(fallback);
  return fallback;
}
const DATA_DIR = pickWritableDir([
  (process.env.DATA_DIR || "").trim(),
  (process.env.RENDER_DATA_DIR || "").trim(),
  "/data",
  path.join(__dirname, "data"),
]);

const UPLOAD_DIR        = path.join(DATA_DIR, "uploads");   fse.mkdirpSync(UPLOAD_DIR);
const PRODUCTS_PATH     = path.join(DATA_DIR, "products.json");
const ORDERS_LOG        = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG  = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH    = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG       = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG      = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH     = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG         = path.join(DATA_DIR, "stock.log");

// アップロードした画像を外部公開
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "365d" }));

// ====== 初期ファイル ======
function initJSON(p, v){ if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8"); }
function initLog(p){ if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8"); }

if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",        name: "久助（えびせん）",     price: 250,  stock: 30, desc: "お得な割れせん。", imageUrl: "" },
    { id: "nori-akasha-340",   name: "のりあかしゃ",         price: 340,  stock: 20, desc: "海苔の風味豊かなえびせんべい", imageUrl: "" },
    { id: "uzu-akasha-340",    name: "うずあかしゃ",         price: 340,  stock: 10, desc: "渦を巻いたえびせんべい", imageUrl: "" },
    { id: "shio-akasha-340",   name: "潮あかしゃ",           price: 340,  stock: 5,  desc: "あおさトッピング", imageUrl: "" },
    { id: "matsu-akasha-340",  name: "松あかしゃ",           price: 340,  stock: 30, desc: "海老たっぷりの高級えびせん", imageUrl: "" },
    { id: "iso-akasha-340",    name: "磯あかしゃ",           price: 340,  stock: 30, desc: "海苔トッピング", imageUrl: "" },
    { id: "goma-akasha-340",   name: "ごまあかしゃ",         price: 340,  stock: 30, desc: "香ばしいごま", imageUrl: "" },
    { id: "original-set-2000", name: "磯屋オリジナルセット", price: 2000, stock: 30, desc: "6袋セット", imageUrl: "" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}
initJSON(ADDRESSES_PATH, {});
initJSON(SESSIONS_PATH, {});
initJSON(NOTIFY_STATE_PATH, {});
initLog(ORDERS_LOG);
initLog(RESERVATIONS_LOG);
initLog(SURVEYS_LOG);
initLog(MESSAGES_LOG);
initLog(STOCK_LOG);

// ====== 在庫/別名 ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = { "久助":"kusuke-250", "くすけ":"kusuke-250", "kusuke":"kusuke-250", "kusuke-250":"kusuke-250" };
// 直接注文から久助を除外する場合はここに
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

// ====== Util ======
const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
const safeReadJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const readProducts   = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts  = (data) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");
const readAddresses  = () => safeReadJSON(ADDRESSES_PATH, {});
const writeAddresses = (data) => fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");
const readSessions   = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions  = (s) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");
const readNotifyState  = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (s) => fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s, null, 2), "utf8");
const uniq = (arr) => Array.from(new Set((arr||[]).filter(Boolean)));

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
  if (ADMIN_CODE_ENV      && tok === ADMIN_CODE_ENV)      return true;

  res.status(401).json({
    ok: false,
    error: "unauthorized",
    hint: {
      need: { bearer_header: !!ADMIN_API_TOKEN_ENV, token_query: !!ADMIN_API_TOKEN_ENV, code_query: !!ADMIN_CODE_ENV },
      got:  { header: headerTok ? "present" : "missing", query: queryTok ? "present" : "missing" }
    }
  });
  return false;
}
const requireAdminMW = (req, res, next) => { if (requireAdmin(req, res)) next(); };

function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function qstr(obj){ return Object.entries(obj).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"); }
function parseQS(data){
  const s = data && data.includes("=") ? data : "";
  const o = {};
  s.split("&").forEach(kv => { const [k, v] = kv.split("="); if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  return o;
}
function resolveProductId(token){ return PRODUCT_ALIASES[token] || token; }
function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function setStock(productId, qty, actor = "system") {
  const q = Math.max(0, Number(qty)||0);
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  products[idx].stock = q;
  writeProducts(products);
  fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts:new Date().toISOString(), action:"set", productId, before, after:q, delta:(q-before), actor })+"\n","utf8");
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
  fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts:new Date().toISOString(), action:"add", productId, before, after, delta:d, actor })+"\n","utf8");
  return { before, after };
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  if (stockNow < LOW_STOCK_THRESHOLD && ADMIN_USER_ID) {
    const msg = `⚠️ 在庫僅少\n商品：${productName}（${productId}）\n残り：${stockNow}個`;
    try { await client.pushMessage(ADMIN_USER_ID, { type:"text", text: msg }); } catch {}
  }
}

// ====== 画像アップロード（multer） ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const name = Date.now() + "-" + Math.random().toString(36).slice(2,8) + ext;
    cb(null, name);
  }
});
const fileFilter = (_req, file, cb) => {
  const ok = ["image/png","image/jpeg","image/jpg","image/webp","image/gif"].includes(file.mimetype);
  cb(ok ? null : new Error("unsupported_file_type"), ok);
};
const upload = multer({
  storage, fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ====== 配送料・代引き ======
const SHIPPING_BY_REGION = { "北海道":1100,"東北":900,"関東":800,"中部":800,"近畿":900,"中国":1000,"四国":1000,"九州":1100,"沖縄":1400 };
const COD_FEE = 330;

// ====== LINE client ======
const client = new line.Client(config);

// ====== Flex（商品一覧）— 画像対応（hero に imageUrl を表示） ======
function productsFlex(allProducts) {
  const products = (allProducts || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));

  const bubbles = products.map(p => {
    const bubble = {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: "sm", wrap: true },
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true } : { type:"box", layout:"vertical", contents:[] }
        ]
      },
      footer: {
        type: "box", layout: "horizontal", spacing: "md",
        contents: [
          { type: "button", style: "primary",
            action: { type: "postback", label: "数量を選ぶ", data: `order_qty?${qstr({ id: p.id, qty: 1 })}` } }
        ]
      }
    };
    if (p.imageUrl) {
      bubble.hero = { type: "image", url: p.imageUrl, size: "full", aspectMode: "cover", aspectRatio: "4:3" };
    }
    return bubble;
  });

  // その他（自由入力）
  bubbles.push({
    type: "bubble",
    body: { type: "box", layout: "vertical", spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        { type: "text", text: "商品名と個数だけ入力します。価格入力は不要です。", size: "sm", wrap: true }
      ]},
    footer: { type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary",   action: { type: "postback", label: "商品名を入力する", data: "other_start" } },
        { type: "button", style: "secondary", action: { type: "postback", label: "← 戻る", data: "order_back" } }
      ]}
  });

  return { type: "flex", altText: "商品一覧", contents: bubbles.length===1 ? bubbles[0] : { type:"carousel", contents: bubbles } };
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
              { type: "button", style: "secondary", action: { type: "postback", label: "+1", data: `order_qty?${qstr({ id, qty: Math.min(99, q + 1) })}` } }
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
              action: { type: "postback", label: "現金で支払う（店頭）", data: `order_confirm_view?${qstr({ id, qty, method: "pickup", region: "", payment: "cash" })}` } },
            { type: "button", style: "secondary",
              action: { type: "postback", label: "← 受取方法へ戻る", data: `order_method?${qstr({ id, qty })}` } }
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
  const payText = payment === "cod" ? `代金引換（+${yen(COD_FEE)})` : payment === "bank" ? "銀行振込" : "現金（店頭）";
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
  if (method === "delivery") bodyContents.push({ type: "text", text: "住所が未登録の方は「住所を入力（LIFF）」を押してください。", size: "sm", wrap: true });
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
  const bubble = { type: "bubble",
    body: { type: "box", layout: "vertical", spacing: "md", contents: bodyContents },
    footer: { type: "box", layout: "vertical", spacing: "md", contents: footerButtons }
  };
  // 画像がある場合は見せる（購入直前にも見える方が親切）
  if (product.imageUrl) {
    bubble.hero = { type:"image", url: product.imageUrl, size:"full", aspectMode:"cover", aspectRatio:"4:3" };
  }
  return { type: "flex", altText: "注文内容の最終確認", contents: bubble };
}

// ====== Admin API ======
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, ping: "pong" }); });
app.get("/api/admin/healthz", (_req, res) => res.json({ ok:true, time:new Date().toISOString(), node:process.version, dataDir: DATA_DIR }));

// 自分の userId（admin 用）— 自動入力/「me」解決に使用
app.get("/api/admin/whoami", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok:true, userId: ADMIN_USER_ID || null });
});

// products 取得（imageUrl 含む）
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({
    id: p.id, name: p.name, price: p.price, stock: p.stock ?? 0, desc: p.desc || "", imageUrl: p.imageUrl || ""
  }));
  res.json({ ok:true, items });
});

// 画像アップロード：multipart/form-data; field "file"; 任意で body.productId
app.post("/api/admin/upload-image", requireAdminMW, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:"no_file" });
    const url = `/uploads/${req.file.filename}`;
    const prodId = (req.body?.productId || "").trim();

    if (prodId) {
      const { products, idx } = findProductById(prodId);
      if (idx >= 0) {
        products[idx].imageUrl = url;
        writeProducts(products);
      }
    }
    res.json({ ok:true, url });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "upload_failed" });
  }
});

// 画像URLを商品に設定/解除
app.post("/api/admin/products/image", requireAdminMW, (req, res) => {
  try {
    const productId = resolveProductId(String(req.body?.productId || "").trim());
    const imageUrl  = String(req.body?.imageUrl || "").trim(); // 空なら解除
    const { products, idx } = findProductById(productId);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[idx].imageUrl = imageUrl;
    writeProducts(products);
    res.json({ ok:true, productId, imageUrl });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || "server_error" });
  }
});

// メッセージログ（tail）
app.get("/api/admin/messages", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(200000, Number(req.query.limit || 2000));
  const items = readLogLines(MESSAGES_LOG, limit);
  res.json({ ok:true, items, path: MESSAGES_LOG });
});

// 直近アクティブユーザー
app.get("/api/admin/active-chatters", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(200000, Number(req.query.limit || 50000));
  let items = readLogLines(MESSAGES_LOG, limit).filter(x => x && x.type === "text" && x.userId);
  const set = new Set(items.map(x => x.userId));
  const listFlag = String(req.query.list || "false").toLowerCase() === "true";
  res.json({
    ok: true,
    totalMessages: items.length,
    uniqueUsers: set.size,
    users: listFlag ? Array.from(set) : undefined
  });
});

// Segment / Text
app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  // "me" を管理者IDに解決
  const userIds = uniq(rawIds.map(id => id === "me" ? ADMIN_USER_ID : id));
  const message = (req.body?.message || "").trim();
  if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });
  if (!message) return res.status(400).json({ ok:false, error:"no_message" });

  const chunkSize = 500;
  const results = [];
  for (let i=0; i<userIds.length; i+=chunkSize) {
    const ids = userIds.slice(i, i+chunkSize);
    try { await client.multicast(ids, [{ type:"text", text: message }]); results.push({ ok:true, size: ids.length }); }
    catch (e){ results.push({ ok:false, size: ids.length, error: e?.response?.data || String(e) }); }
  }
  const okCount = results.filter(r=>r.ok).reduce((a,b)=>a+b.size,0);
  const ngCount = results.filter(r=>!r.ok).reduce((a,b)=>a+b.size,0);
  res.json({ ok:true, requested:userIds.length, sent:okCount, failed:ngCount, results });
});

// Segment / Flex
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
app.post("/api/admin/segment/send-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rawIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const userIds = uniq(rawIds.map(id => id === "me" ? ADMIN_USER_ID : id));
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });
    const msg = [{ type: "flex", altText, contents }];

    const chunkSize = 500; let sent=0, failed=0, results=[];
    for (let i=0; i<userIds.length; i+=chunkSize) {
      const ids = userIds.slice(i, i+chunkSize);
      try { await client.multicast(ids, msg); results.push({ ok:true, size: ids.length }); sent+=ids.length; }
      catch (e){ results.push({ ok:false, size: ids.length, error: e?.response?.data || String(e) }); failed+=ids.length; }
    }
    res.json({ ok:true, requested:userIds.length, sent, failed, results });
  } catch (err) {
    res.status(400).json({ ok:false, error: err.message || "bad_request" });
  }
});

// Broadcast / Flex
app.post("/api/admin/broadcast-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    await client.broadcast([{ type: "flex", altText, contents }]);
    res.json({ ok:true });
  } catch (e) {
    const detail = e?.response?.data || e.message || String(e);
    res.status(400).json({ ok:false, error: detail });
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

// ====== イベント処理（direct order 省略せず） ======
async function handleEvent(ev) {
  try {
    // ログ（text/postback）
    if (ev.type === "message" && ev.message?.type === "text") {
      try { fs.appendFileSync(MESSAGES_LOG, JSON.stringify({ ts:new Date().toISOString(), userId: ev.source?.userId || "", type:"text", len:(ev.message.text||"").length })+"\n","utf8"); } catch {}
    }
    if (ev.type === "postback") {
      try { fs.appendFileSync(MESSAGES_LOG, JSON.stringify({ ts:new Date().toISOString(), userId: ev.source?.userId || "", type:"postback", data: String(ev.postback?.data||"").slice(0,200) })+"\n","utf8"); } catch {}
    }

    // ---- message:text ----
    if (ev.type === "message" && ev.message?.type === "text") {
      const text = (ev.message.text || "").trim();
      const sessions = readSessions();
      const uid = ev.source?.userId || "";

      // 久助（テキスト直打ち、例：「久助 2」）
      const kusukeRe = /^久助(?:\s+(\d+))?$/i;
      const km = kusukeRe.exec(text);
      if (km) {
        const qtyStr = km[1];
        if (!qtyStr) {
          sessions[uid] = { await: "kusukeQty" }; writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type:"text", text:"久助の個数を半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(qtyStr)));
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }
      if (sessions[uid]?.await === "kusukeQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) { await client.replyMessage(ev.replyToken, { type:"text", text:"半角数字で入力してください（例：2）" }); return; }
        const qty = Math.max(1, Math.min(99, Number(n)));
        delete sessions[uid]; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }

      // その他（自由入力）
      if (sessions[uid]?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品名を入力してください。" }); return; }
        sessions[uid] = { await: "otherQty", temp: { name } }; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:`「${name}」ですね。個数を半角数字で入力してください。例：2` });
        return;
      }
      if (sessions[uid]?.await === "otherQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) { await client.replyMessage(ev.replyToken, { type:"text", text:"個数は半角数字で入力してください。例：2" }); return; }
        const qty = Math.max(1, Math.min(99, Number(n)));
        const name = sessions[uid].temp?.name || "その他";
        delete sessions[uid]; writeSessions(sessions);
        const id = `other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      // 管理者コマンド（在庫）
      if (ADMIN_USER_ID && ev.source?.userId === ADMIN_USER_ID) {
        const t = text.replace(/\s+/g, " ").trim();
        if (t === "在庫一覧") {
          const items = readProducts().map(p => `・${p.name}（${p.id}）：${Number(p.stock||0)}個`).join("\n");
          await client.replyMessage(ev.replyToken, { type:"text", text: items || "商品がありません。" });
          return;
        }
        if (t.startsWith("在庫 ")) {
          const parts = t.split(" ");
          if (parts.length === 2) {
            const pid = resolveProductId(parts[1]); const { product } = findProductById(pid);
            await client.replyMessage(ev.replyToken, { type:"text", text: product ? `${product.name}：${Number(product.stock||0)}個` : "商品が見つかりません。" });
            return;
          }
          if (parts.length === 4) {
            const op = parts[1], pid = resolveProductId(parts[2]), val = Number(parts[3]);
            try {
              if (op === "設定" || op.toLowerCase() === "set") {
                const r = setStock(pid, val, "admin-text"); const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[設定] ${product?.name || pid}\n${r.before} → ${r.after} 個` });
                await maybeLowStockAlert(pid, product?.name || pid, r.after);
                return;
              }
              if (op === "追加" || op === "+" || op.toLowerCase() === "add") {
                const r = addStock(pid, Math.abs(val), "admin-text"); const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[追加] ${product?.name || pid}\n${r.before} → ${r.after} 個（+${Math.abs(val)}）` });
                return;
              }
              if (op === "減少" || op === "-" || op.toLowerCase() === "sub") {
                const r = addStock(pid, -Math.abs(val), "admin-text"); const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[減少] ${product?.name || pid}\n${r.before} → ${r.after} 個（-${Math.abs(val)}）` });
                await maybeLowStockAlert(pid, product?.name || pid, r.after);
                return;
              }
            } catch (e) {
              await client.replyMessage(ev.replyToken, { type:"text", text:`在庫コマンドエラー：${e.message || e}` });
              return;
            }
          }
        }
      }

      // 一般ユーザー：直接注文/アンケート
      if (text === "直接注文") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      if (text === "アンケート") {
        return client.replyMessage(ev.replyToken, { type:"text", text:"アンケート機能は準備中です。" });
      }
      return client.replyMessage(ev.replyToken, { type:"text", text:"「直接注文」と送ると、商品一覧（画像つき）が表示されます。\n久助は「久助 2」のように、商品名＋半角個数で入力してください。" });
    }

    // ---- postback ----
    if (ev.type === "postback") {
      const d = String(ev.postback?.data || "");

      if (d === "other_start") {
        const sessions = readSessions(); const uid = ev.source?.userId || "";
        sessions[uid] = { await: "otherName" }; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:"その他の商品名を入力してください。" });
        return;
      }
      if (d.startsWith("order_qty?")) {
        const { id, qty } = parseQS(d.replace("order_qty?", ""));
        return client.replyMessage(ev.replyToken, qtyFlex(id, qty));
      }
      if (d.startsWith("order_method?")) {
        const { id, qty } = parseQS(d.replace("order_method?", ""));
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d.startsWith("order_region?")) {
        const { id, qty, method } = parseQS(d.replace("order_region?", ""));
        if (method === "delivery") return client.replyMessage(ev.replyToken, regionFlex(id, qty));
        return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
      }
      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parseQS(d.replace("order_payment?", ""));
        method = (method || "").trim(); region = (region || "").trim(); if (region === "-") region = "";
        if (method === "pickup")  return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
        if (method === "delivery") {
          if (!region) return client.replyMessage(ev.replyToken, regionFlex(id, qty));
          return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "delivery", region));
        }
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, region, payment } = parseQS(d.replace("order_confirm_view?", ""));
        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), imageUrl: "" };
        } else {
          const products = readProducts();
          product = products.find(p => p.id === id);
          if (!product) return client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" });
        }
        return client.replyMessage(ev.replyToken, confirmFlex(product, qty, method, region, payment, LIFF_ID));
      }
      if (d === "order_back") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      if (d.startsWith("order_confirm?")) {
        const { id, qty, method, region, payment } = parseQS(d.replace("order_confirm?", ""));
        const need = Math.max(1, Number(qty) || 1);

        let product = null;
        let products = readProducts();
        let idx = products.findIndex(p => p.id === id);

        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || ""; const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity, imageUrl: "" };
          idx = -1;
        } else {
          if (idx === -1) return client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" });
          product = products[idx];
          if (!product.stock || product.stock < need) {
            const r = [
              { type:"text", text:[
                "申し訳ありません。在庫が不足しています。",
                `商品：${product.name}`,
                `希望数量：${need}個 / 現在在庫：${product.stock||0}個`,
                "", "予約しますか？ 入荷次第ご案内します。"
              ].join("\n") },
              { type:"template", altText:"在庫不足：予約しますか？",
                template: { type:"confirm", text:"予約しますか？",
                  actions: [
                    { type:"postback", label:"予約する", data:`order_reserve?${qstr({ id: product.id, qty: need })}` },
                    { type:"postback", label:"やめる", data:"order_cancel" }
                  ] } }
            ];
            return client.replyMessage(ev.replyToken, r);
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
          ts: new Date().toISOString(), userId: ev.source?.userId || "",
          productId: product.id, productName: product.name, qty: need, price: Number(product.price),
          subtotal, region, shipping: regionFee, payment, codFee, total, method, address: addr
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order) + "\n", "utf8");

        const payText = payment === "cod" ? `代金引換（+${yen(COD_FEE)})` : payment === "bank" ? "銀行振込" : "現金（店頭）";
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
        await client.replyMessage(ev.replyToken, { type:"text", text: userLines.join("\n") });

        if (method === "delivery" && payment === "bank") {
          const lines = ["▼ 振込先"];
          if (BANK_INFO) lines.push(BANK_INFO); else lines.push("（銀行口座情報が未設定です。管理者に連絡してください。）");
          if (BANK_NOTE) { lines.push(""); lines.push(BANK_NOTE); }
          lines.push("", "※ご入金確認後の発送となります。");
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
          if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type:"text", text: adminMsg });
          if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type:"text", text: adminMsg });
        } catch {}
        return;
      }
      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parseQS(d.replace("order_reserve?", ""));
        const products = readProducts();
        const product = products.find(p => p.id === id);
        if (!product) return client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" });

        const r = { ts: new Date().toISOString(), userId: ev.source?.userId || "", productId: product.id, productName: product.name, qty: Math.max(1, Number(qty) || 1), status: "reserved" };
        fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r) + "\n", "utf8");

        await client.replyMessage(ev.replyToken, { type:"text", text: ["予約を受け付けました。入荷次第ご案内します。", `商品：${product.name}`, `数量：${r.qty}個`].join("\n") });
        return;
      }
    }
  } catch (err) {
    console.error("handleEvent error:", err?.response?.data || err?.stack || err);
    if (ev.replyToken) { try { await client.replyMessage(ev.replyToken, { type:"text", text:"エラーが発生しました。もう一度お試しください。" }); } catch {} }
  }
}

// ====== Health ======
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    dataDir: DATA_DIR,
    files: {
      products: PRODUCTS_PATH, ordersLog: ORDERS_LOG, reservationsLog: RESERVATIONS_LOG,
      addresses: ADDRESSES_PATH, surveysLog: SURVEYS_LOG, messagesLog: MESSAGES_LOG,
      sessions: SESSIONS_PATH, notifyState: NOTIFY_STATE_PATH, stockLog: STOCK_LOG, uploads: UPLOAD_DIR
    },
    env: {
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
    }
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
  console.log(`   Uploads:  /uploads -> ${UPLOAD_DIR}`);
  console.log(`   Webhook:  POST /webhook`);
});
