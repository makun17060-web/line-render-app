// server.js — フル機能版 + Flex配信 + 「その他＝価格入力なし」 + 久助専用テキスト購入フロー
// + 予約者連絡API/コマンド + 店頭受取/予約で名前入力フロー + 宅配×銀行振込で振込先＆追記コメント自動送信
// .env 必須: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN or ADMIN_CODE)
// 任意: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE

"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

// ====== ENV ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();

const BANK_INFO = (process.env.BANK_INFO || "").trim(); // 振込先
const BANK_NOTE = (process.env.BANK_NOTE || "").trim(); // 追記コメント

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret:      (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error("ERROR: .env の必須値が不足しています。LINE_* / LIFF_ID / (ADMIN_API_TOKEN or ADMIN_CODE)");
  process.exit(1);
}

// ====== Middlewares & Static ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== Data paths ======
const DATA_DIR         = path.join(__dirname, "data");
const PRODUCTS_PATH    = path.join(DATA_DIR, "products.json");
const ORDERS_LOG       = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH   = path.join(DATA_DIR, "addresses.json"); // 名前/住所/電話を保存（名前だけの保存もOK）
const SURVEYS_LOG      = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG     = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH    = path.join(DATA_DIR, "sessions.json");
const STOCK_LOG        = path.join(DATA_DIR, "stock.log");
const NOTIFY_STATE_PATH= path.join(DATA_DIR, "notify_state.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH))  fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",      name: "久助（えびせん）",     price: 250, stock: 20, desc: "お得な割れせん。" },
    { id: "nori-akasha-340", name: "のりあかしゃ",         price: 340, stock: 20, desc: "海苔の風味豊かなえびせんべい" },
    { id: "uzu-akasha-340",  name: "うずあかしゃ",         price: 340, stock: 10, desc: "渦を巻いたえびせんべい" },
    { id: "matsu-akasha-340",name: "松あかしゃ",           price: 340, stock: 30, desc: "海老をたっぷり使用した高級えびせんべい" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ 初期 products.json を作成: ${PRODUCTS_PATH}`);
}

// ====== Configs ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = {
  "久助": "kusuke-250",
  "くすけ": "kusuke-250",
  "kusuke": "kusuke-250",
  "kusuke-250": "kusuke-250",
};
// 一覧から隠す（久助はテキスト入力導線で購入）
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

// ====== Utils ======
const client = new line.Client(config);

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

function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// stock helpers
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
    const msg = `⚠️ 在庫僅少\n商品：${productName}（${productId}）\n残り：${stockNow}個（しきい値 ${LOW_STOCK_THRESHOLD}）`;
    try { if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type:"text", text: msg }); } catch {}
  }
}

// auth helpers
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

  res.status(401).json({ ok:false, error:"unauthorized" });
  return false;
}

// time range helpers (JST day)
function jstRangeFromYmd(ymd) {
  const y = Number(ymd.slice(0,4)), m = Number(ymd.slice(4,6))-1, d = Number(ymd.slice(6,8));
  const startJST = new Date(Date.UTC(y, m, d, -9, 0, 0));
  const endJST   = new Date(Date.UTC(y, m, d+1, -9, 0, 0));
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

// ====== 送料/代引き ======
const SHIPPING_BY_REGION = {
  "北海道": 1100, "東北": 900, "関東": 800, "中部": 800,
  "近畿": 900, "中国": 1000, "四国": 1000, "九州": 1100, "沖縄": 1400
};
const COD_FEE = 330;

// ====== Flex Builders ======
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

function productsFlex(allProducts) {
  const products = (allProducts || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));
  const bubbles = products.map(p => ({
    type: "bubble",
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

  // 「その他（自由入力）」：価格入力なし（名前→個数→受取方法へ）
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

  return { type: "flex", altText: "商品一覧",
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

// 店頭受取＝現金のみ。名前未登録の場合は名前を先に取得する導線に切替える
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
            { type: "text", text: "店頭受取は現金のみです。お受け取りの際の「お名前」をお伺いします。", wrap: true }
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

  // 宅配: 代引き or 銀行振込
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

function confirmFlex(product, qty, method, region, payment, LIFF_ID) {
  // other:NAME(:PRICE)?
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
      action: { type: "uri", label: "住所を入力（LIFF）", uri: `https://liff.line.me/${LIFF_ID}?${qstr({ from: "address", need: "shipping" })}` }
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

// ====== Survey (ダミー: ボタンだけ) ======
const SURVEY_VERSION = 2;
function surveyQ1() {
  return { type:"text", text:"アンケートは準備中です。" };
}

// ====== LIFF APIs ======
app.post("/api/liff/address", async (req, res) => {
  try {
    const { userId, name, phone, postal, prefecture, city, address1, address2 } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    const book = readAddresses();
    book[userId] = {
      name: (name||"").trim(),
      phone: (phone||"").trim(),
      postal: (postal||"").trim(),
      prefecture: (prefecture||"").trim(),
      city: (city||"").trim(),
      address1: (address1||"").trim(),
      address2: (address2||"").trim(),
      ts: new Date().toISOString()
    };
    writeAddresses(book);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
app.get("/api/liff/config", (_req, res) => res.json({ liffId: LIFF_ID }));

// ====== Admin APIs ======
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, ping: "pong" }); });

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

// 在庫・ログ
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({ id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0, desc:p.desc || "" }));
  res.json({ ok:true, items });
});
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

// 予約者連絡（まとめて）
app.post("/api/admin/reservations/notify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const pid = resolveProductId(String(req.body?.productId || "").trim());
    const msg = String(req.body?.message || "").trim();
    if (!pid) return res.status(400).json({ ok:false, error:"productId required" });
    if (!msg) return res.status(400).json({ ok:false, error:"message required" });

    const items = readLogLines(RESERVATIONS_LOG, 100000).filter(r => r && r.productId === pid && r.userId);
    const userIds = Array.from(new Set(items.map(r => r.userId)));
    if (userIds.length === 0) return res.json({ ok:true, sent:0, users:[] });

    const chunk = 500;
    let sent = 0;
    for (let i=0;i<userIds.length;i+=chunk) {
      const ids = userIds.slice(i, i+chunk);
      try { await client.multicast(ids, [{ type:"text", text: msg }]); sent += ids.length; }
      catch(e){ console.error("notify multicast error:", e?.response?.data || e); }
    }
    res.json({ ok:true, productId: pid, requested:userIds.length, sent });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e.message||e) });
  }
});

// 順次通知（開始/次/停止）
function buildReservationQueue(productId) {
  const all = readLogLines(RESERVATIONS_LOG, 200000)
    .filter(r => r && r.productId === productId && r.userId && r.ts)
    .sort((a,b) => new Date(a.ts) - new Date(b.ts));
  const seen = new Set();
  const ids  = [];
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
    state[pid].idx = idx; state[pid].updatedAt = new Date().toISOString(); writeNotifyState(state);
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

// Insight (フォロワー数など)
function yyyymmddJST(offsetDays = -1) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9*60*60*1000);
  jst.setDate(jst.getDate() + offsetDays);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth()+1).padStart(2,"0");
  const d = String(jst.getUTCDate()).padStart(2,"0");
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
      const r = await axios.get(url, { headers:{ Authorization:`Bearer ${config.channelAccessToken}` }, timeout:10000 });
      const { followers = null, targetedReaches = null, blocks = null } = r.data || {};
      return res.json({ ok:true, date, followers, targetedReaches, blocks, raw:r.data });
    } catch (e) {
      const status = e?.response?.status || 500;
      const detail = e?.response?.data || { message: e.message || String(e) };
      tried.push({ date, status, detail });
      if (status === 401 || status === 403) return res.status(200).json({ ok:false, status, detail, tried });
    }
  }
  return res.status(200).json({ ok:false, error:"no_usable_date", tried });
});
app.get("/admin/audience-count", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, "/api/admin/audience-count" + qs);
});

// セグメント配信（テキスト/フレックス）
app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userIds = Array.isArray(req.body?.userIds) ? uniq(req.body.userIds) : [];
  const message = (req.body?.message || "").trim();
  if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });
  if (!message)           return res.status(400).json({ ok:false, error:"no_message" });

  const chunk = 500;
  const results = [];
  let okCount=0, ngCount=0;
  for (let i=0;i<userIds.length;i+=chunk) {
    const ids = userIds.slice(i, i+chunk);
    try{ await client.multicast(ids, [{ type:"text", text: message }]); results.push({ ok:true, size:ids.length }); okCount+=ids.length; }
    catch(e){ results.push({ ok:false, size:ids.length, error:e?.response?.data || String(e) }); ngCount+=ids.length; }
  }
  res.json({ ok:true, requested:userIds.length, sent:okCount, failed:ngCount, batches:results.length, results });
});
app.post("/api/admin/broadcast-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    // ここは altText/contents 両方を渡す（UIから直接叩く用）
    const altText = ensureAltText(req.body?.altText || "お知らせ");
    const contents = validateFlexContents(req.body?.contents || req.body); // 互換
    await client.broadcast([{ type: "flex", altText, contents }]);
    return res.json({ ok:true });
  } catch (e) {
    const detail = e?.response?.data || e.message || String(e);
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
    // 軽量メッセージログ
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        const rec = { ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "text", len: (ev.message.text || "").length };
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const textRaw = (ev.message.text || "");
      const text = textRaw.trim();

      // ★ 久助専用：半角個数入力 → 数量Flexをスキップして受取方法へ
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
      if (sessions[uid]?.await === "kusukeQty") {
        if (!/^\d+$/.test(text)) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"半角数字で入力してください（例：2）" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(text)));
        delete sessions[uid]; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250", qty));
        return;
      }

      // ★ その他（自由入力）：名前→個数→受取方法（価格0固定）
      if (sessions[uid]?.await === "otherName") {
        const name = (textRaw || "").slice(0, 50).trim();
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品名を入力してください。" }); return; }
        sessions[uid] = { await: "otherQty", temp: { name } };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:`「${name}」ですね。個数を半角数字で入力してください。例：2` });
        return;
      }
      if (sessions[uid]?.await === "otherQty") {
        if (!/^\d+$/.test(text)) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"個数は半角数字で入力してください。例：2" });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(text)));
        const name = sessions[uid].temp?.name || "その他";
        delete sessions[uid]; writeSessions(sessions);
        const id = `other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      // ★ 店頭受取のとき、名前が未登録ならここで受け取る（注文確定直前に仕込んだセッション）
      if (sessions[uid]?.await === "pickupName") {
        const name = text.slice(0, 30);
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"お名前を入力してください。例：山田太郎" }); return; }

        // 名前だけでも addresses に保存
        const book = readAddresses();
        const prev = book[uid] || {};
        book[uid] = { ...prev, name, ts: new Date().toISOString() };
        writeAddresses(book);

        // 保留中の注文情報を続行
        const ord = sessions[uid]?.pendingOrder;
        delete sessions[uid];
        writeSessions(sessions);

        if (ord) {
          await finalizeOrderAndReply(ev, ord.id, ord.qty, "pickup", "", "cash");
          return;
        }
      }

      // ★ 予約時：名前が未登録なら取得 → 予約記録へ
      if (sessions[uid]?.await === "reserveName") {
        const name = text.slice(0, 30);
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"お名前を入力してください。例：山田太郎" }); return; }

        const book = readAddresses();
        const prev = book[uid] || {};
        book[uid] = { ...prev, name, ts: new Date().toISOString() };
        writeAddresses(book);

        const pending = sessions[uid]?.pendingReserve; // { id, qty }
        delete sessions[uid];
        writeSessions(sessions);

        if (pending) {
          await writeReservationAndReply(ev, pending.id, pending.qty);
          return;
        }
      }

      // ★ 管理者向けテキストコマンド（在庫/予約連絡）
      if (ev.source?.userId && ADMIN_USER_ID && ev.source.userId === ADMIN_USER_ID) {
        const t = text.replace(/\s+/g, " ").trim();

        if (t === "在庫一覧") {
          const items = readProducts().map(p => `・${p.name}（${p.id}）：${Number(p.stock||0)}個`).join("\n");
          await client.replyMessage(ev.replyToken, { type:"text", text: items || "商品がありません。" });
          return;
        }
        if (t.startsWith("在庫 ")) {
          const parts = t.split(" ");
          if (parts.length === 2) { // 在庫 {nameOrId}
            const pid = resolveProductId(parts[1]);
            const { product } = findProductById(pid);
            await client.replyMessage(ev.replyToken, { type:"text", text: product ? `${product.name}：${Number(product.stock||0)}個` : "商品が見つかりません。" });
            return;
          }
          if (parts.length === 4) { // 在庫 設定|追加|減少 {nameOrId} {数値}
            const op = parts[1]; const pid = resolveProductId(parts[2]); const val = Number(parts[3]);
            try {
              if (op === "設定" || op.toLowerCase() === "set") {
                const r = setStock(pid, val, "admin-text");
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[設定] ${product?.name || pid}\n${r.before} → ${r.after} 個` });
                await maybeLowStockAlert(pid, product?.name || pid, r.after);
                return;
              }
              if (op === "追加" || op === "+" || op.toLowerCase() === "add") {
                const r = addStock(pid, Math.abs(val), "admin-text");
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[追加] ${product?.name || pid}\n${r.before} → ${r.after} 個（+${Math.abs(val)}）` });
                return;
              }
              if (op === "減少" || op === "-" || op.toLowerCase() === "sub") {
                const r = addStock(pid, -Math.abs(val), "admin-text");
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, { type:"text", text:`[減少] ${product?.name || pid}\n${r.before} → ${r.after} 個（-${Math.abs(val)}）` });
                await maybeLowStockAlert(pid, product?.name || pid, r.after);
                return;
              }
            } catch (e) {
              await client.replyMessage(ev.replyToken, { type:"text", text:`在庫コマンドエラー：${e.message || e}` });
              return;
            }
          }
          if (parts.length === 3 && /^[+-]\d+$/.test(parts[2])) { // 在庫 {nameOrId} ±数値
            const pid = resolveProductId(parts[1]); const delta = Number(parts[2]);
            try{
              const r = addStock(pid, delta, "admin-text");
              const { product } = findProductById(pid);
              const sign = delta >= 0 ? "+" : "";
              await client.replyMessage(ev.replyToken, { type:"text", text:`[調整] ${product?.name || pid}\n${r.before} → ${r.after} 個（${sign}${delta}）` });
              await maybeLowStockAlert(pid, product?.name || pid, r.after);
            }catch(e){
              await client.replyMessage(ev.replyToken, { type:"text", text:`在庫コマンドエラー：${e.message || e}` });
            }
            return;
          }
          await client.replyMessage(ev.replyToken, { type:"text", text:
            "在庫コマンド:\n・在庫一覧\n・在庫 久助\n・在庫 設定 久助 50 / 追加 10 / 減少 3\n・在庫 久助 +5 / 在庫 久助 -2"
          });
          return;
        }

        // 予約連絡系（開始/次/停止 は下の通常導線の直前に別処理あり）
        if (t.startsWith("予約連絡 ")) {
          const m = /^予約連絡\s+(\S+)\s+([\s\S]+)$/.exec(t);
          if (!m) { await client.replyMessage(ev.replyToken, { type:"text", text:"使い方：予約連絡 {商品名またはID} {本文}" }); return; }
          const pid = resolveProductId(m[1]);
          const message = m[2].trim();
          const items = readLogLines(RESERVATIONS_LOG, 100000).filter(r => r && r.productId === pid && r.userId);
          const userIds = Array.from(new Set(items.map(r=>r.userId)));
          if (userIds.length === 0) { await client.replyMessage(ev.replyToken, { type:"text", text:`予約者が見つかりませんでした。（${pid}）` }); return; }
          try {
            const chunk = 500;
            for (let i=0;i<userIds.length;i+=chunk) { await client.multicast(userIds.slice(i,i+chunk), [{ type:"text", text: message }]); }
            await client.replyMessage(ev.replyToken, { type:"text", text:`予約者 ${userIds.length}名に送信しました。` });
          } catch (e) {
            await client.replyMessage(ev.replyToken, { type:"text", text:`送信エラー：${e?.response?.data?.message || e.message || e}` });
          }
          return;
        }
      }

      // 順次通知（テキストコマンド）— 管理者限定
      if (ev.source?.userId && ADMIN_USER_ID && ev.source.userId === ADMIN_USER_ID) {
        const tcmd = text.replace(/\s+/g," ").trim();

        if (tcmd.startsWith("予約連絡開始 ")) {
          const m = /^予約連絡開始\s+(\S+)\s+([\s\S]+)$/.exec(tcmd);
          if (!m) { await client.replyMessage(ev.replyToken, { type:"text", text:"使い方：予約連絡開始 {商品名/ID} {本文}" }); return; }
          const pid = resolveProductId(m[1]);
          const message = m[2].trim();
          const userIds = buildReservationQueue(pid);
          const state = readNotifyState();
          state[pid] = { idx:0, userIds, message, updatedAt:new Date().toISOString() };
          state.__lastPid = pid;
          writeNotifyState(state);

          if (userIds.length === 0) { await client.replyMessage(ev.replyToken, { type:"text", text:`予約者がいません。（${pid}）` }); return; }
          try {
            await client.pushMessage(userIds[0], { type:"text", text: message });
            state[pid].idx = 1; state[pid].updatedAt = new Date().toISOString(); writeNotifyState(state);
            await client.replyMessage(ev.replyToken, { type:"text", text:`開始：${pid}\n1/${userIds.length} 件送信しました。「予約連絡次」で続行。` });
          } catch (e) {
            await client.replyMessage(ev.replyToken, { type:"text", text:`送信エラー：${e?.response?.data?.message || e.message || e}` });
          }
          return;
        }

        if (tcmd === "予約連絡次" || tcmd.startsWith("予約連絡次 ")) {
          const m = /^予約連絡次(?:\s+(\S+))?(?:\s+(\d+))?$/.exec(tcmd);
          const pid = resolveProductId(m?.[1] || readNotifyState().__lastPid || "");
          const count = Math.max(1, Number(m?.[2] || 1));
          const state = readNotifyState();
          const st = state[pid];
          if (!pid || !st) { await client.replyMessage(ev.replyToken, { type:"text", text:"先に「予約連絡開始 {商品} {本文}」を実行してください。" }); return; }

          const { userIds, message } = st;
          let { idx } = st;
          const total = userIds.length;
          if (idx >= total) { await client.replyMessage(ev.replyToken, { type:"text", text:`完了済み：${idx}/${total}` }); return; }

          let sent = 0;
          for (let i=0; i<count && idx < total; i++, idx++) {
            try { await client.pushMessage(userIds[idx], { type:"text", text: message }); sent++; } catch {}
          }
          state[pid].idx = idx; state[pid].updatedAt = new Date().toISOString(); writeNotifyState(state);
          await client.replyMessage(ev.replyToken, { type:"text", text:`${sent}件送信：${idx}/${total}` });
          return;
        }

        if (tcmd.startsWith("予約連絡停止")) {
          const m = /^予約連絡停止(?:\s+(\S+))?$/.exec(tcmd);
          const pid = resolveProductId(m?.[1] || readNotifyState().__lastPid || "");
          const state = readNotifyState();
          if (pid && state[pid]) delete state[pid];
          if (state.__lastPid === pid) delete state.__lastPid;
          writeNotifyState(state);
          await client.replyMessage(ev.replyToken, { type:"text", text:`停止しました：${pid || "(未指定)"}` });
          return;
        }
      }

      // 通常導線
      if (text === "直接注文") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      if (text === "アンケート") {
        return client.replyMessage(ev.replyToken, surveyQ1());
      }

      return client.replyMessage(ev.replyToken, { type: "text", text: "「直接注文」と送ると商品一覧が表示されます。\n久助は「久助 2」のように、商品名＋半角個数でご入力ください。" });
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

        if (method === "pickup") {
          return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
        }
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
        // 店頭受取のとき名前が未登録なら先に名前入力
        const uid = ev.source?.userId || "";
        const book = readAddresses();
        const hasName = !!(book[uid]?.name);

        if (method === "pickup" && !hasName) {
          const sessions = readSessions();
          sessions[uid] = { await:"pickupName", pendingOrder:{ id, qty } };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type:"text", text:"店頭でお呼びするお名前を入力してください。例：山田太郎" });
          return;
        }

        await finalizeOrderAndReply(ev, id, qty, method, region, payment);
        return;
      }

      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parse(d.replace("order_reserve?", ""));
        // 予約時：名前がなければ先に取得
        const uid = ev.source?.userId || "";
        const book = readAddresses();
        const hasName = !!(book[uid]?.name);

        if (!hasName) {
          const sessions = readSessions();
          sessions[uid] = { await:"reserveName", pendingReserve:{ id, qty } };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type:"text", text:"予約者名を入力してください。例：山田太郎" });
          return;
        }

        await writeReservationAndReply(ev, id, qty);
        return;
      }
    }
  } catch (err) {
    console.error("handleEvent error:", err?.response?.data || err?.stack || err);
    if (ev.replyToken) { try { await client.replyMessage(ev.replyToken, { type: "text", text: "エラーが発生しました。もう一度お試しください。" }); } catch {} }
  }
}

// ====== 注文確定処理（共通） ======
async function finalizeOrderAndReply(ev, id, qty, method, region, payment) {
  const need = Math.max(1, Number(qty) || 1);

  let product = null;
  let products = readProducts();
  let idx = products.findIndex(p => p.id === id);

  if (String(id).startsWith("other:")) {
    const parts = String(id).split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
    idx = -1; // 在庫減算なし
  } else {
    if (idx === -1) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" }); return; }
    product = products[idx];
    if (!product.stock || product.stock < need) {
      await client.replyMessage(ev.replyToken, reserveOffer(product, need, product.stock || 0));
      return;
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
        ? `お届け先：${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name || ""}\n電話：${addr.phone || ""}`
        : "住所未登録です。メニューの「住所を入力（LIFF）」から登録してください。"
    );
  } else {
    // 店頭受取：名前が登録されていれば表示
    if (addr?.name) {
      userLines.push("", `お受け取り名：${addr.name}`);
    } else {
      userLines.push("", "お受け取り名は来店時にお伺いします。");
    }
  }

  await client.replyMessage(ev.replyToken, { type: "text", text: userLines.join("\n") });

  // 銀行振込案内（宅配 + bank のとき）
  if (method === "delivery" && payment === "bank") {
    const bankMsg =
      (BANK_INFO ? `▼ 振込先\n${BANK_INFO}` : "▼ 振込先\n（銀行口座情報が未設定です。管理者にご連絡ください）")
      + (BANK_NOTE ? `\n\n${BANK_NOTE}` : "\n\n※ご入金確認後の発送となります。");

    try {
      await client.pushMessage(ev.source.userId, { type: "text", text: bankMsg });
    } catch (e) { console.error("bank info send error:", e?.response?.data || e); }
  }

  // 管理者通知
  const adminMsg = [
    "🧾 新規注文",
    `ユーザーID：${ev.source?.userId || ""}`,
    `商品：${product.name}`,
    `数量：${need}個`,
    `小計：${yen(subtotal)} / 送料：${yen(regionFee)} / 代引：${yen(codFee)} / 合計：${yen(total)}`,
    `受取：${method}${method === "delivery" ? `（${region}）` : ""} / 支払：${payment}`,
    (addr
      ? `住所/氏名/TEL：${addr.postal || ""} ${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""}${addr.address2 ? " " + addr.address2 : ""}\n${addr.name || ""} / ${addr.phone || ""}`
      : "住所：未登録")
  ].join("\n");
  try {
    if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
    if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminMsg });
  } catch {}
}

// ====== 予約記録＆返信 ======
async function writeReservationAndReply(ev, productId, qtyRaw) {
  const products = readProducts();
  const product = products.find(p => p.id === productId);
  if (!product) { await client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" }); return; }

  const r = {
    ts: new Date().toISOString(),
    userId: ev.source?.userId || "",
    productId: product.id,
    productName: product.name,
    qty: Math.max(1, Number(qtyRaw) || 1),
    status: "reserved"
  };
  fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r) + "\n", "utf8");

  await client.replyMessage(ev.replyToken, { type: "text", text: ["予約を受け付けました。入荷次第ご案内します。", `商品：${product.name}`, `数量：${r.qty}個`].join("\n") });

  try {
    const adminReserve = ["📝 予約受付", `ユーザーID：${ev.source?.userId || ""}`, `商品：${product.name}`, `数量：${r.qty}個`].join("\n");
    if (ADMIN_USER_ID) await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminReserve });
    if (MULTICAST_USER_IDS.length > 0) await client.multicast(MULTICAST_USER_IDS, { type: "text", text: adminReserve });
  } catch {}
}

// ====== Health ======
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.head("/health", (_req, res) => res.status(200).end());
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    env: {
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
      BANK_INFO: !!BANK_INFO,
      BANK_NOTE: !!BANK_NOTE,
    }
  });
});

// ====== Listen ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log("   Health:  GET  /health");
  console.log("   LIFF address page: /public/liff-address.html  (open via https://liff.line.me/LIFF_ID)");
});
