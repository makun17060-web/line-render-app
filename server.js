// server.js — フル機能版 + Flex配信 + 「その他＝価格入力なし」 + 久助専用テキスト購入フロー
// + 予約者連絡API/コマンド + 店頭受取Fix + 銀行振込案内（コメント対応）
// + 画像アップロード/一覧/削除 + 商品へ画像URL紐付け（管理画面用）
// + ミニアプリ用 /api/products（久助除外）
// + ★ Stripe / Epsilon 切替決済（/api/pay 共通入口 + admin切替）
//
// 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID,
//           (ADMIN_API_TOKEN または ADMIN_CODE)
// 任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE, PUBLIC_BASE_URL
//           PAYMENT_PROVIDER=epsilon|stripe
//           STRIPE_SECRET_KEY, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL
//           EPSILON_* (既存のまま)

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const multer = require("multer");

// ★ Stripe
let stripe = null;
try {
  const sk = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (sk) stripe = require("stripe")(sk);
} catch (e) {
  console.warn("[stripe] not initialized:", e?.message || e);
}

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();      // 互換

// ★ 銀行振込案内（任意）
const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

// ★ 公開URL
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

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

// ====== パス定義 ======
const DATA_DIR = path.join(__dirname, "data");

// ログ/JSON
const PRODUCTS_PATH     = path.join(DATA_DIR, "products.json");
const ORDERS_LOG        = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG  = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH    = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG       = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG      = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH     = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG         = path.join(DATA_DIR, "stock.log");
const EPSILON_NOTIFY_LOG= path.join(DATA_DIR, "epsilon_notify.log");

// ★ 決済プロバイダ保存
const PAYMENT_PROVIDER_PATH = path.join(DATA_DIR, "payment_provider.json");

// 公開静的/アップロード
const PUBLIC_DIR  = path.join(__dirname, "public");
const UPLOAD_DIR  = path.join(PUBLIC_DIR, "uploads");

// ====== ディレクトリ自動作成 ======
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ====== ミドルウェア ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(PUBLIC_DIR));
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== データ初期化 ======
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",      name: "久助（えびせん）",     price: 250, stock: 20, desc: "お得な割れせん。", image: "" },
    { id: "nori-square-300", name: "四角のりせん",         price: 300, stock: 10, desc: "のり香る角せん。", image: "" },
    { id: "premium-ebi-400", name: "プレミアムえびせん",   price: 400, stock: 5,  desc: "贅沢な旨み。",     image: "" }
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
}
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH)) fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(PAYMENT_PROVIDER_PATH)) {
  fs.writeFileSync(PAYMENT_PROVIDER_PATH, JSON.stringify({ provider: (process.env.PAYMENT_PROVIDER || "epsilon") }, null, 2), "utf8");
}

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

// ====== 決済プロバイダ（Stripe/Epsilon）スイッチ ======
function getPaymentProvider() {
  const env = (process.env.PAYMENT_PROVIDER || "").trim();
  if (env === "stripe" || env === "epsilon") return env;
  const st = safeReadJSON(PAYMENT_PROVIDER_PATH, { provider: "epsilon" });
  return (st.provider === "stripe") ? "stripe" : "epsilon";
}
function setPaymentProvider(p) {
  const provider = (p === "stripe") ? "stripe" : "epsilon";
  fs.writeFileSync(PAYMENT_PROVIDER_PATH, JSON.stringify({ provider }, null, 2), "utf8");
  return provider;
}

// ====== 在庫ユーティリティ ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = {
  "久助": "kusuke-250",
  "くすけ": "kusuke-250",
  "kusuke": "kusuke-250",
  "kusuke-250": "kusuke-250",
};
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function resolveProductId(token) { return PRODUCT_ALIASES[token] || token; }
function writeStockLog(entry) {
  try { fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts:new Date().toISOString(), ...entry }) + "\n", "utf8"); } catch {}
}
function setStock(productId, qty, actor = "system") {
  const q = Math.max(0, Number(qty)||0);
  const { products, idx } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(products[idx].stock || 0);
  products[idx].stock = q;
  writeProducts(products);
  writeStockLog({ action:"set", productId, before, after:q, delta:(q-before), actor });
  return { before, after:q };
}
function addStock(productId, delta, actor = "system") {
  const d = Number(delta)||0;
  const { products, idx } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(products[idx].stock || 0);
  const after = Math.max(0, before + d);
  products[idx].stock = after;
  writeProducts(products);
  writeStockLog({ action:"add", productId, before, after, delta:d, actor });
  return { before, after };
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  const client = new line.Client(config);
  if (stockNow < LOW_STOCK_THRESHOLD && ADMIN_USER_ID) {
    const msg = `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n残り：${stockNow}個\nしきい値：${LOW_STOCK_THRESHOLD}個`;
    try { await client.pushMessage(ADMIN_USER_ID, { type:"text", text: msg }); } catch {}
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
  res.status(401).json({ ok: false, error:"unauthorized" });
  return false;
}

// ====== ログ読み込みユーティリティ ======
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function jstRangeFromYmd(ymd) {
  const y = Number(ymd.slice(0,4)), m = Number(ymd.slice(5,7))-1, d = Number(ymd.slice(8,10));
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

// ====== 配送料 & 代引き ======
const SHIPPING_BY_REGION = {
  "北海道": 1100, "東北": 900, "関東": 800, "中部": 800,
  "近畿": 900, "中国": 1000, "四国": 1000, "九州": 1100, "沖縄": 1400
};
const COD_FEE = 330;

// ====== LINE client ======
const client = new line.Client(config);

// ===== 画像URL整形（Flex用） =====
function toPublicImageUrl(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";
  s = s.replace(".onrender.com./", ".onrender.com/");
  if (/^https?:\/\//i.test(s)) return s;

  let fname = s;
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) fname = s.slice(lastSlash + 1);

  const pathPart = `/public/uploads/${fname}`;
  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

  if (hostFromRender) return `https://${hostFromRender}${pathPart}`;
  return pathPart;
}

// ===== 商品UI（Flex） ======
function productsFlex(allProducts) {
  const products = (allProducts || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));

  const bubbles = products.map(p => {
    const imgUrl = toPublicImageUrl(p.image);
    return {
      type: "bubble",
      hero: imgUrl ? { type:"image", url:imgUrl, size:"full", aspectRatio:"1:1", aspectMode:"cover" } : undefined,
      body: {
        type:"box", layout:"vertical", spacing:"sm",
        contents: [
          { type:"text", text:p.name, weight:"bold", size:"md", wrap:true },
          { type:"text", text:`価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size:"sm", wrap:true },
          p.desc ? { type:"text", text:p.desc, size:"sm", wrap:true } : { type:"box", layout:"vertical", contents:[] }
        ].filter(Boolean)
      },
      footer: {
        type:"box", layout:"horizontal", spacing:"md",
        contents: [{
          type:"button", style:"primary",
          action:{ type:"postback", label:"数量を選ぶ", data:`order_qty?${qstr({ id:p.id, qty:1 })}` }
        }]
      }
    };
  });

  // その他
  bubbles.push({
    type:"bubble",
    body:{
      type:"box", layout:"vertical", spacing:"sm",
      contents:[
        { type:"text", text:"その他（自由入力）", weight:"bold", size:"md" },
        { type:"text", text:"商品名と個数だけ入力します。価格入力は不要です。", size:"sm", wrap:true }
      ]
    },
    footer:{
      type:"box", layout:"vertical", spacing:"md",
      contents:[
        { type:"button", style:"primary", action:{ type:"postback", label:"商品名を入力する", data:"other_start" } },
        { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:"order_back" } }
      ]
    }
  });

  return {
    type:"flex",
    altText:"商品一覧",
    contents: (bubbles.length === 1) ? bubbles[0] : { type:"carousel", contents:bubbles }
  };
}

function qtyFlex(id, qty = 1) {
  const q = Math.max(1, Math.min(99, Number(qty) || 1));
  return {
    type:"flex", altText:"数量を選択してください",
    contents:{
      type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"数量選択", weight:"bold", size:"lg" },
          { type:"text", text:`現在の数量：${q} 個`, size:"md" }
        ]
      },
      footer:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"box", layout:"horizontal", spacing:"md",
            contents:[
              { type:"button", style:"secondary", action:{ type:"postback", label:"-1", data:`order_qty?${qstr({ id, qty:Math.max(1,q-1) })}` } },
              { type:"button", style:"secondary", action:{ type:"postback", label:"+1", data:`order_qty?${qstr({ id, qty:Math.min(99,q+1) })}` } },
            ]
          },
          { type:"box", layout:"horizontal", spacing:"md",
            contents:[1,2,3,5].map(n=>({
              type:"button", style:n===q?"primary":"secondary",
              action:{ type:"postback", label:`${n}個`, data:`order_qty?${qstr({ id, qty:n })}` }
            }))
          },
          { type:"button", style:"primary", action:{ type:"postback", label:"受取方法へ", data:`order_method?${qstr({ id, qty:q })}` } },
          { type:"button", style:"secondary", action:{ type:"postback", label:"← 商品一覧", data:"order_back" } }
        ]
      }
    }
  };
}

function methodFlex(id, qty) {
  return {
    type:"flex", altText:"受取方法を選択してください",
    contents:{
      type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"受取方法", weight:"bold", size:"lg" },
          { type:"text", text:"宅配 または 店頭受取 を選択してください。", wrap:true }
        ]
      },
      footer:{ type:"box", layout:"horizontal", spacing:"md",
        contents:[
          { type:"button", style:"primary",
            action:{ type:"postback", label:"宅配（送料あり）", data:`order_region?${qstr({ id, qty, method:"delivery" })}` }
          },
          { type:"button", style:"secondary",
            action:{ type:"postback", label:"店頭受取（送料0円）", data:`order_payment?${qstr({ id, qty, method:"pickup", region:"-" })}` }
          }
        ]
      }
    }
  };
}

function regionFlex(id, qty) {
  const regions = Object.keys(SHIPPING_BY_REGION);
  const rows = [];
  for (let i=0;i<regions.length;i+=2) {
    rows.push({
      type:"box", layout:"horizontal", spacing:"md",
      contents: regions.slice(i,i+2).map(r=>({
        type:"button", style:"secondary",
        action:{ type:"postback", label:`${r}（${yen(SHIPPING_BY_REGION[r])}）`, data:`order_payment?${qstr({ id, qty, method:"delivery", region:r })}` }
      }))
    });
  }
  return {
    type:"flex", altText:"地域選択",
    contents:{
      type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"地域選択", weight:"bold", size:"lg" },
          { type:"text", text:"地域により送料が異なります。", wrap:true }
        ]
      },
      footer:{ type:"box", layout:"vertical", spacing:"sm", contents:rows }
    }
  };
}

function paymentFlex(id, qty, method, region) {
  if (method === "pickup") {
    return {
      type:"flex", altText:"お支払い（店頭）",
      contents:{
        type:"bubble",
        body:{ type:"box", layout:"vertical", spacing:"md",
          contents:[
            { type:"text", text:"お支払い方法", weight:"bold", size:"lg" },
            { type:"text", text:"店頭受取は現金のみです。", wrap:true }
          ]
        },
        footer:{ type:"box", layout:"vertical", spacing:"md",
          contents:[
            { type:"button", style:"primary",
              action:{ type:"postback", label:"現金で支払う（店頭）", data:`order_confirm_view?${qstr({ id, qty, method:"pickup", region:"", payment:"cash" })}` }
            },
            { type:"button", style:"secondary",
              action:{ type:"postback", label:"← 受取方法へ戻る", data:`order_method?${qstr({ id, qty })}` }
            }
          ]
        }
      }
    };
  }
  const regionText = method==="delivery" ? `（配送地域：${region}）` : "";
  return {
    type:"flex", altText:"お支払い方法を選択してください",
    contents:{
      type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"お支払い方法", weight:"bold", size:"lg" },
          { type:"text", text:`代引きは +${yen(COD_FEE)}${regionText}`, wrap:true }
        ]
      },
      footer:{ type:"box", layout:"horizontal", spacing:"md",
        contents:[
          { type:"button", style:"primary", action:{ type:"postback", label:`代金引換（+${yen(COD_FEE)}）`, data:`order_confirm_view?${qstr({ id, qty, method, region, payment:"cod" })}` } },
          { type:"button", style:"secondary", action:{ type:"postback", label:"銀行振込", data:`order_confirm_view?${qstr({ id, qty, method, region, payment:"bank" })}` } }
        ]
      }
    }
  };
}

function confirmFlex(product, qty, method, region, payment, LIFF_ID) {
  if (typeof product?.id==="string" && product.id.startsWith("other:")) {
    const parts = product.id.split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    product = { ...product, name: decodeURIComponent(encName || "その他"), price: Number(priceStr||0) };
  }

  const regionFee = method==="delivery" ? (SHIPPING_BY_REGION[region]||0) : 0;
  const codFee = payment==="cod" ? COD_FEE : 0;
  const subtotal = Number(product.price) * Number(qty);
  const total = subtotal + regionFee + codFee;

  const payText =
    payment==="cod" ? `代金引換（+${yen(COD_FEE)})` :
    payment==="bank"? "銀行振込" : "現金（店頭）";

  const lines = [
    `受取方法：${method==="pickup" ? "店頭受取（送料0円）" : `宅配（${region}：${yen(regionFee)}）`}`,
    `支払い：${payText}`,
    `商品：${product.name}`,
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
    `送料：${yen(regionFee)}`,
    `代引き手数料：${yen(codFee)}`,
    `合計：${yen(total)}`
  ];

  const bodyContents = [
    { type:"text", text:"最終確認", weight:"bold", size:"lg" },
    ...lines.map(t=>({ type:"text", text:t, wrap:true }))
  ];
  if (method==="delivery") {
    bodyContents.push({
      type:"text",
      text:"住所が未登録の方は「住所を入力（LIFF）」を押してください。",
      size:"sm", wrap:true
    });
  }

  const footerButtons = [
    { type:"button", style:"secondary", action:{ type:"postback", label:"← 商品一覧へ", data:"order_back" } },
    { type:"button", style:"primary", action:{ type:"postback", label:"この内容で確定", data:`order_confirm?${qstr({ id:product.id, qty, method, region, payment })}` } }
  ];
  if (method==="delivery") {
    footerButtons.unshift({
      type:"button", style:"secondary",
      action:{ type:"uri", label:"住所を入力（LIFF）", uri:`https://liff.line.me/${LIFF_ID}?${qstr({ from:"address", need:"shipping" })}` }
    });
  }

  const imgUrl = toPublicImageUrl(product.image);

  return {
    type:"flex",
    altText:"注文内容の最終確認",
    contents:{
      type:"bubble",
      hero: imgUrl ? { type:"image", url:imgUrl, size:"full", aspectRatio:"1:1", aspectMode:"cover" } : undefined,
      body:{ type:"box", layout:"vertical", spacing:"md", contents:bodyContents },
      footer:{ type:"box", layout:"vertical", spacing:"md", contents:footerButtons }
    }
  };
}

function reserveOffer(product, needQty, stock) {
  return [
    { type:"text", text:[
      "申し訳ありません。在庫が不足しています。",
      `商品：${product.name}`,
      `希望数量：${needQty}個 / 現在在庫：${stock}個`,
      "",
      "予約しますか？ 入荷次第ご案内します。"
    ].join("\n") },
    {
      type:"template", altText:"在庫不足：予約しますか？",
      template:{
        type:"confirm",
        text:"予約しますか？",
        actions:[
          { type:"postback", label:"予約する", data:`order_reserve?${qstr({ id:product.id, qty:needQty })}` },
          { type:"postback", label:"やめる", data:"order_cancel" }
        ]
      }
    }
  ];
}

// ====== LIFF API ======
app.post("/api/liff/address", async (req, res) => {
  try {
    const { userId, name, phone, postal, prefecture, city, address1, address2 } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });
    const book = readAddresses();
    book[userId] = { name, phone, postal, prefecture, city, address1, address2, ts:new Date().toISOString() };
    writeAddresses(book);
    res.json({ ok:true });
  } catch {
    res.status(500).json({ ok:false, error:"server_error" });
  }
});
app.get("/api/liff/config", (_req, res) => res.json({ liffId: LIFF_ID }));

// =====================================================
// ✅ Epsilon 決済（既存ロジックを関数化）
// =====================================================
async function payWithEpsilon(req, res) {
  try {
    const contractCode = (process.env.EPSILON_CONTRACT_CODE || "").trim();
    const stCode       = (process.env.EPSILON_ST_CODE || "10000-0000-00000").trim();
    const orderUrl     = (process.env.EPSILON_ORDER_URL || "https://secure.epsilon.jp/cgi-bin/order/receive_order3.cgi").trim();
    const defaultMail  = (process.env.EPSILON_DEFAULT_MAIL || "").trim();
    const successUrlEnv= (process.env.EPSILON_SUCCESS_URL || "").trim();
    const failureUrlEnv= (process.env.EPSILON_FAILURE_URL || "").trim();

    if (!contractCode) return res.status(500).json({ ok:false, error:"EPSILON_CONTRACT_CODE is not set" });

    const { items, total, lineUserId, lineUserName } = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok:false, error:"no_items" });
    }

    const totalPrice = Math.max(0, Number(total || 0));
    if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
      return res.status(400).json({ ok:false, error:"invalid_total" });
    }

    const first = items[0] || {};
    const itemCode = String(first.id || "ISOYA-ONLINE");
    let   itemName = String(first.name || "商品");
    if (items.length > 1) itemName += " 他";
    itemName = itemName.slice(0, 50);

    let orderNumber = String(Date.now()).replace(/[^0-9]/g, "").slice(0, 32);

    const userId   = (lineUserId || "guest").slice(0, 32);
    const userName = (lineUserName || "LINEユーザー").slice(0, 50);
    const userMail = defaultMail || "no-reply@example.com";

    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
    const host  = req.headers.host;
    const base  = `${proto}://${host}`;
    const successUrl = successUrlEnv || `${base}/public/confirm-success.html`;
    const failureUrl = failureUrlEnv || `${base}/public/confirm-fail.html`;

    const params = new URLSearchParams({
      version:"2",
      contract_code:contractCode,
      user_id:userId,
      user_name:userName,
      user_mail_add:userMail,
      item_code:itemCode,
      item_name:itemName,
      order_number:orderNumber,
      st_code:stCode,
      mission_code:"1",
      item_price:String(totalPrice),
      process_code:"1",
      memo1:lineUserId || "",
      memo2:"",
      success_url:successUrl,
      failure_url:failureUrl,
      xml:"1",
      character_code:"UTF8"
    });

    console.log("[pay-epsilon] request:", orderUrl, params.toString());

    const epsilonRes = await axios.post(orderUrl, params.toString(), {
      headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      timeout:15000
    });

    const body = String(epsilonRes.data || "");
    console.log("[pay-epsilon] response:", body);

    const getAttr = (name) => {
      const re = new RegExp(name + '="([^"]*)"', "i");
      const m = body.match(re);
      return m ? decodeURIComponent(m[1]) : "";
    };

    const result   = getAttr("result");
    const redirect = getAttr("redirect");
    const errCode  = getAttr("err_code");
    const errDet   = getAttr("err_detail");

    if (result === "1" && redirect) {
      return res.json({ ok:true, redirectUrl:redirect, provider:"epsilon" });
    }

    const msg = `Epsilon error result=${result} code=${errCode} detail=${errDet}`;
    console.error("[pay-epsilon] error:", msg);
    return res.status(400).json({ ok:false, error:msg });

  } catch (e) {
    console.error("[pay-epsilon] exception:", e?.response?.data || e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
}

// 既存URLとして残す
app.post("/api/pay-epsilon", payWithEpsilon);

// =====================================================
// ✅ Stripe 決済（Checkout Session）
// =====================================================
async function payWithStripe(req, res) {
  try {
    if (!stripe) return res.status(500).json({ ok:false, error:"STRIPE_SECRET_KEY is not set" });

    const { items, total, lineUserId, lineUserName } = req.body || {};
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok:false, error:"no_items" });
    }

    const totalPrice = Math.max(0, Number(total || 0));
    if (!Number.isFinite(totalPrice) || totalPrice <= 0) {
      return res.status(400).json({ ok:false, error:"invalid_total" });
    }

    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https");
    const host  = req.headers.host;
    const base  = `${proto}://${host}`;

    const successUrl = (process.env.STRIPE_SUCCESS_URL || "").trim() || `${base}/public/confirm-success.html`;
    const cancelUrl  = (process.env.STRIPE_CANCEL_URL  || "").trim() || `${base}/public/confirm-fail.html`;

    // Stripe line items
    const lineItems = items.map(it => ({
      price_data: {
        currency: "jpy",
        product_data: { name: String(it.name || "商品").slice(0, 100) },
        unit_amount: Math.max(0, Number(it.price || 0)),
      },
      quantity: Math.max(1, Number(it.qty || 1)),
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: successUrl + "?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: cancelUrl,
      metadata: {
        lineUserId: lineUserId || "",
        lineUserName: lineUserName || "",
        total: String(totalPrice),
        items: JSON.stringify(items).slice(0, 4500),
      },
    });

    return res.json({ ok:true, redirectUrl: session.url, provider:"stripe" });
  } catch (e) {
    console.error("[pay-stripe] exception:", e?.raw?.message || e.message || e);
    return res.status(500).json({ ok:false, error:"stripe_error" });
  }
}

// =====================================================
// ✅ 共通入口：/api/pay
//   provider は (1) req.body.provider か (2) PAYMENT_PROVIDER/env or file
// =====================================================
app.post("/api/pay", async (req, res) => {
  const bodyProvider = (req.body?.provider || "").trim();
  const provider = (bodyProvider === "stripe" || bodyProvider === "epsilon")
    ? bodyProvider
    : getPaymentProvider();

  if (provider === "stripe") return payWithStripe(req, res);
  return payWithEpsilon(req, res);
});

// ★★★ イプシロン入金通知（既存） ★★★
app.post("/api/epsilon/notify", async (req, res) => {
  try {
    const data = req.body || {};
    res.send("OK");

    try {
      const lineStr = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
      fs.appendFileSync(EPSILON_NOTIFY_LOG, lineStr, "utf8");
    } catch (e) {
      console.error("EPSILON_NOTIFY_LOG error:", e);
    }

    const orderNumber = data.order_number || data.order_no || "";
    const payMethod   = data.pay_method || "";
    const state       = data.state || data.pay_status || "";
    const userId      = data.memo1 || data.user_id || "";

    const isPaid = (state === "2" || state === "paid" || state === "1");
    if (isPaid && userId) {
      const message = {
        type:"text",
        text:
          "コンビニ・ペイジーでのご入金を確認しました。\n" +
          (orderNumber ? `ご注文番号：${orderNumber}\n` : "") +
          "\n商品の発送準備に入らせていただきます。\n今しばらくお待ちください。",
      };
      try { await client.pushMessage(userId, message); } catch {}
    }
  } catch (err) {
    console.error("epsilon notify error:", err);
  }
});

// ====== 管理API ======
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok:true, ping:"pong" }); });

// ★ 決済プロバイダを変更する管理API
app.post("/api/admin/payment-provider/set", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = (req.body?.provider || "").trim();
  const provider = setPaymentProvider(p);
  res.json({ ok:true, provider });
});
app.get("/api/admin/payment-provider", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok:true, provider: getPaymentProvider() });
});

// 注文・予約・住所・アンケート一覧 & 集計（既存）
app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(ORDERS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from:req.query.from, to:req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x=>x.ts, range.from, range.to);
  res.json({ ok:true, items });
});
app.get("/api/admin/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(RESERVATIONS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from:req.query.from, to:req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x=>x.ts, range.from, range.to);
  res.json({ ok:true, items });
});
app.get("/api/admin/addresses", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok:true, items: readAddresses() });
});
app.get("/api/admin/surveys", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 2000));
  let items = readLogLines(SURVEYS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to) range = { from:req.query.from, to:req.query.to };
  if (range.from || range.to) items = filterByIsoRange(items, x=>x.ts, range.from, range.to);
  res.json({ ok:true, items });
});

// ====== 在庫管理 API（既存） ======
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({
    id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0, desc:p.desc||"", image:p.image||""
  }));
  res.json({ ok:true, items });
});
app.post("/api/admin/products/update", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = String(req.body?.productId || "").trim();
    if (!pid) return res.status(400).json({ ok:false, error:"productId required" });

    const products = readProducts();
    const idx = products.findIndex(p => p.id === pid);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });

    const p = products[idx];
    const beforeStock = Number(p.stock || 0);

    if (typeof req.body.name === "string") p.name = req.body.name.trim().slice(0, 50);
    if (req.body.price !== undefined) {
      const v = Number(req.body.price);
      if (!Number.isNaN(v) && v >= 0) p.price = v;
    }
    if (req.body.stock !== undefined) {
      const v = Number(req.body.stock);
      if (!Number.isNaN(v) && v >= 0) {
        p.stock = v;
        writeStockLog({ action:"set", productId:pid, before:beforeStock, after:v, delta:v-beforeStock, actor:"api-update" });
      }
    }
    if (typeof req.body.desc === "string") p.desc = req.body.desc.trim().slice(0, 200);
    if (typeof req.body.image === "string") p.image = req.body.image.trim();

    writeProducts(products);
    res.json({ ok:true, product:p });
  } catch (e) {
    console.error("products/update error:", e);
    res.status(500).json({ ok:false, error:"update_error" });
  }
});
app.get("/api/admin/stock/logs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(10000, Number(req.query.limit || 200));
  res.json({ ok:true, items: readLogLines(STOCK_LOG, limit) });
});
app.post("/api/admin/stock/set", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId((req.body?.productId || "").trim());
    const qty = Number(req.body?.qty);
    res.json({ ok:true, productId:pid, ...setStock(pid, qty, "api") });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});
app.post("/api/admin/stock/add", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId((req.body?.productId || "").trim());
    const delta = Number(req.body?.delta);
    res.json({ ok:true, productId:pid, ...addStock(pid, delta, "api") });
  } catch (e) {
    res.status(400).json({ ok:false, error:String(e.message||e) });
  }
});

// ====== ミニアプリ用：商品一覧 API（久助除外） ======
app.get("/api/products", (_req, res) => {
  try {
    const items = readProducts()
      .filter(p => p.id !== "kusuke-250")
      .map(p => ({
        id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0,
        desc:p.desc || "", image: toPublicImageUrl(p.image || "")
      }));
    res.json({ ok:true, products:items });
  } catch (e) {
    console.error("/api/products error:", e);
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ====== 画像アップロード & 管理 API（既存） ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || "image").replace(/[^\w.\-]+/g, "_");
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits:{ fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  }
});
app.get("/api/admin/connection-test", (req,res)=>{
  if (!requireAdmin(req,res)) return;
  res.json({ ok:true, uploads:true, uploadDir:"/public/uploads" });
});
app.post("/api/admin/upload-image", (req,res)=>{
  if (!requireAdmin(req,res)) return;
  upload.single("image")(req,res,(err)=>{
    if (err) {
      const msg = err?.message === "File too large" ? "file_too_large" : (err?.message || "upload_error");
      return res.status(400).json({ ok:false, error:msg });
    }
    if (!req.file) return res.status(400).json({ ok:false, error:"no_file" });

    const filename = req.file.filename;
    const relPath = `/public/uploads/${filename}`;
    let base = PUBLIC_BASE_URL;
    if (!base) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host  = req.headers.host;
      base = `${proto}://${host}`;
    }
    const url = `${base}${relPath}`;

    res.json({ ok:true, file:filename, url, path:relPath, size:req.file.size, mimetype:req.file.mimetype });
  });
});
app.get("/api/admin/images", (req,res)=>{
  if (!requireAdmin(req,res)) return;
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map(name => {
        const p = path.join(UPLOAD_DIR, name);
        const st = fs.statSync(p);
        return { name, url:`/public/uploads/${name}`, path:`/public/uploads/${name}`, bytes:st.size, mtime:st.mtimeMs };
      })
      .sort((a,b)=>b.mtime-a.mtime);
    res.json({ ok:true, items:files });
  } catch (e) {
    console.error("images list error:", e);
    res.status(500).json({ ok:false, error:"list_error" });
  }
});
app.delete("/api/admin/images/:name", (req,res)=>{
  if (!requireAdmin(req,res)) return;
  const base = (req.params?.name || "").replace(/\.\./g,"").replace(/[\/\\]/g,"");
  const p = path.join(UPLOAD_DIR, base);
  try {
    if (!fs.existsSync(p)) return res.status(404).json({ ok:false, error:"not_found" });
    fs.unlinkSync(p);
    res.json({ ok:true, deleted:base });
  } catch {
    res.status(500).json({ ok:false, error:"delete_error" });
  }
});
app.post("/api/admin/products/set-image", (req,res)=>{
  if (!requireAdmin(req,res)) return;
  try {
    const pid = String(req.body?.productId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!pid) return res.status(400).json({ ok:false, error:"productId required" });
    const { products, idx } = findProductById(pid);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[idx].image = imageUrl;
    writeProducts(products);
    res.json({ ok:true, product:products[idx] });
  } catch {
    res.status(500).json({ ok:false, error:"save_error" });
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
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        const rec = { ts:new Date().toISOString(), userId:ev.source?.userId||"", type:"text", len:(ev.message.text||"").length };
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

      // 久助テキスト注文
      const kusukeRe = /^久助(?:\s+(\d+))?$/i;
      const km = kusukeRe.exec(text);
      if (km) {
        const qtyStr = km[1];
        if (!qtyStr) {
          sessions[uid] = { await:"kusukeQty" };
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

      // その他
      if (sess?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品名を入力してください。" }); return; }
        sessions[uid] = { await:"otherQty", temp:{ name } };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:`「${name}」ですね。個数を半角数字で入力してください。例：2` });
        return;
      }
      if (sess?.await === "otherQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) { await client.replyMessage(ev.replyToken, { type:"text", text:"個数は半角数字で入力してください。例：2" }); return; }
        const qty = Math.max(1, Math.min(99, Number(n)));
        const name = sess.temp?.name || "その他";
        delete sessions[uid]; writeSessions(sessions);
        const id = `other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      // 管理者コマンド（在庫/予約連絡など）
      if (uid && ADMIN_USER_ID && uid === ADMIN_USER_ID) {
        if (t === "在庫一覧") {
          const items = readProducts().map(p => `・${p.name}（${p.id}）：${Number(p.stock||0)}個`).join("\n");
          await client.replyMessage(ev.replyToken, { type:"text", text: items || "商品がありません。" });
          return;
        }
      }

      if (text === "直接注文") { await client.replyMessage(ev.replyToken, productsFlex(readProducts())); return; }
      if (text === "アンケート") { await client.replyMessage(ev.replyToken, { type:"text", text:"アンケートは準備中です。" }); return; }

      await client.replyMessage(ev.replyToken, {
        type:"text",
        text:"「直接注文」と送ると、商品一覧が表示されます。\n久助は「久助 2」のように商品名＋半角個数でご入力ください。"
      });
      return;
    }

    if (ev.type === "postback") {
      const d = ev.postback?.data || "";

      if (d === "other_start") {
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await:"otherName" };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type:"text", text:"その他の商品名を入力してください。" });
        return;
      }

      if (d.startsWith("order_qty?")) {
        const { id, qty } = parse(d.replace("order_qty?", ""));
        await client.replyMessage(ev.replyToken, qtyFlex(id, qty));
        return;
      }
      if (d.startsWith("order_method?")) {
        const { id, qty } = parse(d.replace("order_method?", ""));
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }
      if (d.startsWith("order_region?")) {
        const { id, qty, method } = parse(d.replace("order_region?", ""));
        if (method==="delivery") await client.replyMessage(ev.replyToken, regionFlex(id, qty));
        else await client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
        return;
      }
      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parse(d.replace("order_payment?", ""));
        method = (method||"").trim();
        region = (region||"").trim();
        if (region === "-") region = "";

        if (method==="pickup") { await client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", "")); return; }
        if (method==="delivery") {
          if (!region) { await client.replyMessage(ev.replyToken, regionFlex(id, qty)); return; }
          await client.replyMessage(ev.replyToken, paymentFlex(id, qty, "delivery", region));
          return;
        }
        await client.replyMessage(ev.replyToken, methodFlex(id, qty));
        return;
      }

      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, region, payment } = parse(d.replace("order_confirm_view?", ""));
        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price:Number(priceStr||0) };
        } else {
          product = readProducts().find(p => p.id === id);
          if (!product) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" }); return; }
        }
        await client.replyMessage(ev.replyToken, confirmFlex(product, qty, method, region, payment, LIFF_ID));
        return;
      }

      if (d === "order_back") {
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }

      // 確定
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
          product = { id, name: decodeURIComponent(encName || "その他"), price:Number(priceStr||0), stock:Infinity };
          idx = -1;
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

        const regionFee = method==="delivery" ? (SHIPPING_BY_REGION[region] || 0) : 0;
        const codFee = payment==="cod" ? COD_FEE : 0;
        const subtotal = Number(product.price) * need;
        const total = subtotal + regionFee + codFee;

        const addrBook = readAddresses();
        const addr = addrBook[ev.source?.userId || ""] || null;

        const order = {
          ts:new Date().toISOString(),
          userId:ev.source?.userId||"",
          productId:product.id,
          productName:product.name,
          qty:need,
          price:Number(product.price),
          subtotal, region, shipping:regionFee,
          payment, codFee, total, method,
          address:addr,
          image:product.image||""
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order) + "\n", "utf8");

        const payText =
          payment==="cod"  ? `代金引換（+${yen(COD_FEE)})` :
          payment==="bank" ? "銀行振込" : "現金（店頭）";

        const userLines = [
          "ご注文ありがとうございます！",
          `受取方法：${method==="pickup" ? "店頭受取（送料0円）" : `宅配（${region}）`}`,
          `支払い：${payText}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)}`,
          `送料：${yen(regionFee)}`,
          `代引き手数料：${yen(codFee)}`,
          `合計：${yen(total)}`
        ];
        if (method==="delivery") {
          userLines.push("");
          userLines.push(
            addr
              ? `お届け先：${addr.postal} ${addr.prefecture}${addr.city}${addr.address1}${addr.address2 ? " " + addr.address2 : ""}\n氏名：${addr.name}\n電話：${addr.phone}`
              : "住所未登録です。メニューの「住所を入力（LIFF）」から登録してください。"
          );
        } else {
          userLines.push("", "店頭でのお受け取りをお待ちしています。");
        }
        await client.replyMessage(ev.replyToken, { type:"text", text:userLines.join("\n") });
        return;
      }

      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parse(d.replace("order_reserve?", ""));
        const product = readProducts().find(p => p.id === id);
        if (!product) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりませんでした。" }); return; }

        const r = { ts:new Date().toISOString(), userId:ev.source?.userId||"", productId:product.id, productName:product.name, qty:Math.max(1,Number(qty)||1), status:"reserved" };
        fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r) + "\n", "utf8");
        await client.replyMessage(ev.replyToken, { type:"text", text:`予約を受け付けました。\n商品：${product.name}\n数量：${r.qty}個` });
        return;
      }
    }
  } catch (err) {
    console.error("handleEvent error:", err?.response?.data || err?.stack || err);
    if (ev.replyToken) {
      try { await client.replyMessage(ev.replyToken, { type:"text", text:"エラーが発生しました。もう一度お試しください。" }); } catch {}
    }
  }
}

// ====== Outbound IP チェック ======
app.get("/my-ip", async (_req, res) => {
  try {
    const r = await axios.get("https://api.ipify.org?format=json", { timeout:5000 });
    const ip = (r.data && r.data.ip) ? r.data.ip : null;
    res.json({ ok:true, outbound_ip:ip, note:"この outbound_ip をイプシロンの「注文情報発信元IP」に登録してください" });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
});

// ====== Health checks ======
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.head("/health", (_req, res) => res.status(200).end());
app.get("/api/health", (_req, res) => {
  res.json({
    ok:true,
    time:new Date().toISOString(),
    node:process.version,
    provider:getPaymentProvider(),
    env:{
      PORT:!!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN:!!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET:!!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID:!!process.env.LIFF_ID,
      ADMIN_API_TOKEN:!!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE:!!ADMIN_CODE_ENV,
      STRIPE_SECRET_KEY:!!process.env.STRIPE_SECRET_KEY,
      EPSILON_CONTRACT_CODE:!!process.env.EPSILON_CONTRACT_CODE,
    }
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log("   LIFF address page: /public/liff-address.html");
  console.log("   Payment provider:", getPaymentProvider());
});
