// server.js — フル機能版 + Flex配信 + 「その他＝価格入力なし」 + 久助専用テキスト購入フロー
// + 予約者連絡API/コマンド + 店頭受取Fix + 銀行振込案内（コメント対応）
// + 画像アップロード/一覧/削除 + 商品へ画像URL紐付け（管理画面用）
// + ミニアプリ用 /api/products（久助除外）
// 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN または ADMIN_CODE)
// 任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE, PUBLIC_BASE_URL

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const multer = require("multer");

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();      // 互換（クエリ ?code= でも可）

// ★ 銀行振込案内（任意）
const BANK_INFO = (process.env.BANK_INFO || "").trim(); // 例: "〇〇銀行 △△支店 普通 1234567 カ)エビセンショップ"
const BANK_NOTE = (process.env.BANK_NOTE || "").trim(); // 例: "振込手数料はお客様ご負担です / お振込名義はご注文者様のお名前でお願いします"

// ★ 公開URL（Renderのhttpsドメインを .env で指定推奨）
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

// ====== パス定義（最上流：ここより前で使わない！） ======
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
// ★ 追加：イプシロン入金通知ログ
const EPSILON_NOTIFY_LOG = path.join(DATA_DIR, "epsilon_notify.log");

// 公開静的/アップロード
const PUBLIC_DIR  = path.join(__dirname, "public");
const UPLOAD_DIR  = path.join(PUBLIC_DIR, "uploads");

// ====== ディレクトリ自動作成 ======
if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR,   { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`📁 Created: ${UPLOAD_DIR}`);
}

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
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH)) fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");

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

// ====== 在庫ユーティリティ ======
const LOW_STOCK_THRESHOLD = 5; // しきい値
const PRODUCT_ALIASES = {
  "久助": "kusuke-250",
  "くすけ": "kusuke-250",
  "kusuke": "kusuke-250",
  "kusuke-250": "kusuke-250",
};
// 直接注文の一覧から隠す商品（久助だけ非表示）
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

// ====== ログ読み込みユーティリティ ======
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function jstRangeFromYmd(ymd) {
  const y = Number(ymd.slice(0,4)), m = Number(ymd.slice(6,8))-1, d = Number(ymd.slice(8,10));
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
// ===== 画像URL整形（Flex用） =====
function toPublicImageUrl(raw) {
  if (!raw) return "";

  let s = String(raw).trim();
  if (!s) return "";

  s = s.replace(".onrender.com./", ".onrender.com/");

  if (/^https?:\/\//i.test(s)) {
    return s;
  }

  let fname = s;
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) {
    fname = s.slice(lastSlash + 1);
  }

  const pathPart = `/public/uploads/${fname}`;

  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

  if (hostFromRender) {
    return `https://${hostFromRender}${pathPart}`;
  }

  return pathPart;
}

// ===== 商品UI（Flex） ======
function productsFlex(allProducts) {
  const products = (allProducts || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));

  const bubbles = products.map(p => {
    const imgUrl = toPublicImageUrl(p.image);

    return {
      type: "bubble",
      hero: imgUrl
        ? {
            type: "image",
            url: imgUrl,
            size: "full",
            aspectRatio: "1:1",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          {
            type: "text",
            text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`,
            size: "sm",
            wrap: true,
          },
          p.desc
            ? { type: "text", text: p.desc, size: "sm", wrap: true }
            : { type: "box", layout: "vertical", contents: [] },
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "数量を選ぶ",
              data: `order_qty?${qstr({ id: p.id, qty: 1 })}`,
            },
          },
        ],
      },
    };
  });

  bubbles.push({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        {
          type: "text",
          text: "商品名と個数だけ入力します。価格入力は不要です。",
          size: "sm",
          wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "postback",
            label: "商品名を入力する",
            data: "other_start",
          },
        },
        {
          type: "button",
          style: "secondary",
          action: { type: "postback", label: "← 戻る", data: "order_back" },
        },
      ],
    },
  });

  return {
    type: "flex",
    altText: "商品一覧",
    contents:
      bubbles.length === 1
        ? bubbles[0]
        : {
            type: "carousel",
            contents: bubbles,
          },
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

// ★ 店頭受取＝現金のみ に対応
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

function confirmFlex(product, qty, method, region, payment, LIFF_ID) {
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
    bodyContents.push({
      type: "text",
      text: "住所が未登録の方は「住所を入力（LIFF）」を押してください。",
      size: "sm",
      wrap: true,
    });
  }

  const footerButtons = [
    {
      type: "button",
      style: "secondary",
      action: { type: "postback", label: "← 商品一覧へ", data: "order_back" },
    },
    {
      type: "button",
      style: "primary",
      action: {
        type: "postback",
        label: "この内容で確定",
        data: `order_confirm?${qstr({ id: product.id, qty, method, region, payment })}`,
      },
    },
  ];
  if (method === "delivery") {
    footerButtons.unshift({
      type: "button",
      style: "secondary",
      action: {
        type: "uri",
        label: "住所を入力（LIFF）",
        uri: `https://liff.line.me/${LIFF_ID}?${qstr({ from: "address", need: "shipping" })}`,
      },
    });
  }

  const imgUrl = toPublicImageUrl(product.image);

  return {
    type: "flex",
    altText: "注文内容の最終確認",
    contents: {
      type: "bubble",
      hero: imgUrl
        ? {
            type: "image",
            url: imgUrl,
            size: "full",
            aspectRatio: "1:1",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: footerButtons,
      },
    },
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
function labelOf(q, code){ return code; }

// ====== LIFF API ======
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

// ★★★ ここから：イプシロン コンビニ・ペイジー入金通知 API ★★★
app.post("/api/epsilon/notify", async (req, res) => {
  try {
    const data = req.body || {};

    // イプシロン側に「OK」をすぐ返す（重要）
    res.send("OK");

    // ログに保存
    try {
      const line = `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`;
      fs.appendFileSync(EPSILON_NOTIFY_LOG, line, "utf8");
    } catch (e) {
      console.error("EPSILON_NOTIFY_LOG 書き込みエラー:", e);
    }

    const orderNumber = data.order_number || data.order_no || "";
    const payMethod   = data.pay_method || "";
    const state       = data.state || data.pay_status || "";
    // ★ memo1 に LINE の userId を送っている前提
    const userId      = data.memo1 || data.user_id || "";

    console.log("=== Epsilon 入金通知受信 ===");
    console.log("orderNumber:", orderNumber);
    console.log("payMethod  :", payMethod);
    console.log("state      :", state);
    console.log("userId     :", userId);

    // ※ state の値はイプシロン仕様に合わせて必要に応じて調整してください
    const isPaid = (state === "2" || state === "paid" || state === "1");

    if (isPaid && userId) {
      const message = {
        type: "text",
        text:
          "コンビニ・ペイジーでのご入金を確認しました。\n" +
          (orderNumber ? `ご注文番号：${orderNumber}\n` : "") +
          "\n商品の発送準備に入らせていただきます。\n今しばらくお待ちください。",
      };

      try {
        await client.pushMessage(userId, message);
        console.log("入金確認メッセージ送信OK →", userId);
      } catch (e) {
        console.error("入金確認メッセージ送信エラー:", e?.response?.data || e);
      }
    } else {
      console.log("入金完了状態ではないか、userId 不明のため LINE送信スキップ");
    }
  } catch (err) {
    console.error("Epsilon notify ハンドラでエラー:", err);
  }
});
// ★★★ イプシロン入金通知 ここまで ★★★

// ====== 管理API（要トークン） ======
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok: true, ping: "pong" }); });

// 注文・予約・住所・アンケート一覧 & 集計
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

// ====== 順次通知（予約者）API ======
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
      state[pid].idx = 1;
      state[pid].updatedAt = new Date().toISOString();
      writeNotifyState(state);
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

// ====== 在庫管理 API ======
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock ?? 0,
    desc: p.desc || "",
    image: p.image || ""
  }));
  res.json({ ok:true, items });
});

// ★ 商品情報更新 API（name / price / stock / desc / image）
app.post("/api/admin/products/update", (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const pid = String(req.body?.productId || "").trim();
    if (!pid) {
      return res.status(400).json({ ok: false, error: "productId required" });
    }

    const products = readProducts();
    const idx = products.findIndex(p => p.id === pid);
    if (idx < 0) {
      return res.status(404).json({ ok: false, error: "product_not_found" });
    }

    const p = products[idx];
    const beforeStock = Number(p.stock || 0);

    if (typeof req.body.name === "string") {
      p.name = req.body.name.trim().slice(0, 50);
    }

    if (req.body.price !== undefined) {
      const v = Number(req.body.price);
      if (!Number.isNaN(v) && v >= 0) {
        p.price = v;
      }
    }

    if (req.body.stock !== undefined) {
      const v = Number(req.body.stock);
      if (!Number.isNaN(v) && v >= 0) {
        const after = v;
        p.stock = after;
        writeStockLog({
          action: "set",
          productId: pid,
          before: beforeStock,
          after,
          delta: after - beforeStock,
          actor: "api-update"
        });
      }
    }

    if (typeof req.body.desc === "string") {
      p.desc = req.body.desc.trim().slice(0, 200);
    }

    if (typeof req.body.image === "string") {
      p.image = req.body.image.trim();
    }

    writeProducts(products);
    return res.json({ ok: true, product: p });
  } catch (e) {
    console.error("products/update error:", e);
    return res.status(500).json({ ok: false, error: "update_error" });
  }
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

// ====== ミニアプリ用：商品一覧 API（久助除外） ======
app.get("/api/products", (req, res) => {
  try {
    const items = readProducts()
      .filter(p => p.id !== "kusuke-250") // ★ 久助を除外
      .map(p => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        image: toPublicImageUrl(p.image || "")
      }));
    res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== 予約者一括連絡 ======
app.post("/api/admin/reservations/notify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const pid = resolveProductId(String(req.body?.productId || "").trim());
    const msg = String(req.body?.message || "").trim();
    if (!pid) return res.status(400).json({ ok:false, error:"productId required" });
    if (!msg) return res.status(400).json({ ok:false, error:"message required" });

    const items = readLogLines(RESERVATIONS_LOG, 100000).filter(r => r && r.productId === pid && r.userId);
    const userIds = Array.from(new Set(items.map(r=>r.userId)));
    if (userIds.length === 0) return res.json({ ok:true, sent:0, users:[] });

    const chunkSize = 500;
    let sent = 0;
    for (let i=0;i<userIds.length;i+=chunkSize) {
      const ids = userIds.slice(i, i+chunkSize);
      try {
        await client.multicast(ids, [{ type:"text", text: msg }]);
        sent += ids.length;
      } catch (e) {
        console.error("notify reservations multicast error:", e?.response?.data || e);
      }
    }
    return res.json({ ok:true, productId: pid, requested:userIds.length, sent });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e.message||e) });
  }
});

// ====== セグメント配信（テキスト/Flex） ======
app.post("/api/admin/segment/preview", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try{
    const t = (req.body?.type || "").trim();

    const uniqIds = (arr) => Array.from(new Set(arr.filter(Boolean)));
    const rng = () => {
      if (req.body?.date) {
        const r = jstRangeFromYmd(String(req.body.date));
        return (items, getTs) => filterByIsoRange(items, getTs, r.from, r.to);
      }
      return (items) => items;
    };

    if (t === "activeChatters") {
      const limit = Math.min(200000, Number(req.body?.limit || 50000));
      let items = readLogLines(MESSAGES_LOG, limit);
      items = rng("date")(items, x => x.ts);
      const ids = uniqIds(items.filter(x=>x && x.type==="text" && x.userId).map(x=>x.userId));
      return res.json({ ok:true, type:t, total: ids.length, userIds: ids });
    }
    if (t === "textSenders") {
      const limit = Math.min(200000, Number(req.body?.limit || 50000));
      let items = readLogLines(MESSAGES_LOG, limit);
      items = (req.body?.date)
        ? filterByIsoRange(items, x => x.ts, jstRangeFromYmd(String(req.body.date)).from, jstRangeFromYmd(String(req.body.date)).to)
        : items;

      const ids = Array.from(new Set(
        items
          .filter(x => x && x.type === "text" && x.userId)
          .map(x => x.userId)
      ));

      return res.json({ ok: true, type: t, total: ids.length, userIds: ids });
    }

    if (t === "survey") {
      const limit = Math.min(200000, Number(req.body?.limit || 50000));
      let items = readLogLines(SURVEYS_LOG, limit);
      items = rng("date")(items, x => x.ts);
      const q1 = Array.isArray(req.body?.q1codes) ? req.body.q1codes : null;
      const q2 = Array.isArray(req.body?.q2codes) ? req.body.q2codes : null;
      const q3 = Array.isArray(req.body?.q3codes) ? req.body.q3codes : null;
      const ids = uniqIds(items.filter(it=>{
        const a = it?.answers || {};
        return (!q1 || q1.includes(a?.q1?.code||"")) &&
               (!q2 || q2.includes(a?.q2?.code||"")) &&
               (!q3 || q3.includes(a?.q3?.code||""));
      }).map(it=>it.userId));
      return res.json({ ok:true, type:t, total: ids.length, userIds: ids });
    }
    
    if (t === "orders") {
      const limit = Math.min(200000, Number(req.body?.limit || 50000));
      let items = readLogLines(ORDERS_LOG, limit);
      items = rng("date")(items, x => x.ts);
      const pids = Array.isArray(req.body?.productIds) ? req.body.productIds : null;
      const method = (req.body?.method || "").trim();
      const payment= (req.body?.payment || "").trim();
      const ids = uniqIds(items.filter(o=>{
        if (pids && pids.length>0 && !pids.includes(o.productId)) return false;
        if (method && o.method !== method) return false;
        if (payment && o.payment !== payment) return false;
        return !!o.userId;
      }).map(o=>o.userId));
      return res.json({ ok:true, type:t, total: ids.length, userIds: ids });
    }
    if (t === "addresses") {
      const book = readAddresses();
      const ids = uniqIds(Object.keys(book || {}));
      return res.json({ ok:true, type:t, total: ids.length, userIds: ids });
    }

    return res.status(400).json({ ok:false, error:"unknown_type" });
  }catch(e){
    console.error("segment preview error:", e);
    return res.status(500).json({ ok:false, error:"server_error" });
  }
});
app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userIds = Array.isArray(req.body?.userIds) ? uniq(req.body.userIds) : [];
  const message = (req.body?.message || "").trim();
  if (userIds.length === 0) return res.status(400).json({ ok:false, error:"no_users" });
  if (!message)           return res.status(400).json({ ok:false, error:"no_message" });
  const chunkSize = 500;
  const results = [];
  let okCount=0, ngCount=0, batches=0;
  for (let i=0; i<userIds.length; i+=chunkSize) {
    const ids = userIds.slice(i, i+chunkSize);
    try{
      await client.multicast(ids, [{ type: "text", text: message }]);
      results.push({ size: ids.length, ok:true }); okCount+=ids.length; batches++;
    }catch(e){
      console.error("multicast error:", e?.response?.data || e);
      results.push({ size: ids.length, ok:false, error: e?.response?.data || String(e) }); ngCount+=ids.length; batches++;
    }
  }
  return res.json({ ok:true, requested:userIds.length, sent:okCount, failed:ngCount, batches, results });
});
app.post("/api/admin/segment/send-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds) ? Array.from(new Set(req.body.userIds.filter(Boolean))) : [];
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

// ====== 画像アップロード & 管理 API（管理者のみ） ======

// multer ストレージ
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
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  }
});

// 接続テスト（管理画面から叩く）
app.get("/api/admin/connection-test", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok:true, uploads:true, uploadDir: "/public/uploads" });
});

// アップロード
app.post("/api/admin/upload-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("image")(req, res, (err) => {
    if (err) {
      const msg = err?.message === "File too large" ? "file_too_large" : (err?.message || "upload_error");
      return res.status(400).json({ ok:false, error: msg });
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

    res.json({
      ok:true,
      file: filename,
      url,
      path: relPath,
      size: req.file.size,
      mimetype: req.file.mimetype
    });
  });
});

// 一覧
app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
      .filter(f => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map(name => {
        const p = path.join(UPLOAD_DIR, name);
        const st = fs.statSync(p);
        return {
          name,
          url: `/public/uploads/${name}`,
          path: `/public/uploads/${name}`,
          bytes: st.size,
          mtime: st.mtimeMs
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    res.json({ ok: true, items: files });
  } catch (e) {
    console.error("images list error:", e);
    res.status(500).json({ ok: false, error: "list_error" });
  }
});

// 削除
app.delete("/api/admin/images/:name", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const base = (req.params?.name || "").replace(/\.\./g,"").replace(/[\/\\]/g,"");
  const p = path.join(UPLOAD_DIR, base);
  try {
    if (!fs.existsSync(p)) return res.status(404).json({ ok:false, error:"not_found" });
    fs.unlinkSync(p);
    res.json({ ok:true, deleted: base });
  } catch(e) { res.status(500).json({ ok:false, error:"delete_error" }); }
});

// 商品に画像URLを紐付け（単機能API：既存管理画面用）
app.post("/api/admin/products/set-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = String(req.body?.productId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!pid) return res.status(400).json({ ok:false, error:"productId required" });
    const { products, idx, product } = findProductById(pid);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[idx].image = imageUrl;
    writeProducts(products);
    res.json({ ok:true, product: products[idx] });
  } catch(e) {
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
        const rec = { ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "text", len: (ev.message.text || "").length };
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

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

      if (sess?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) { await client.replyMessage(ev.replyToken, { type:"text", text:"商品名を入力してください。" }); return; }
        sessions[uid] = { await: "otherQty", temp: { name } };
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

      if (ev.source?.userId && ADMIN_USER_ID && ev.source.userId === ADMIN_USER_ID) {
        if (t === "在庫一覧") {
          const items = readProducts().map(p => `・${p.name}（${p.id}）：${Number(p.stock||0)}個`).join("\n");
          await client.replyMessage(ev.replyToken, { type:"text", text: items || "商品がありません。" });
          return;
        }
        if (t.startsWith("在庫 ")) {
          const parts = t.split(" ");
          if (parts.length === 2) {
            const pid = resolveProductId(parts[1]);
            const { product } = findProductById(pid);
            if (!product) await client.replyMessage(ev.replyToken, { type:"text", text:"商品が見つかりません。" });
            else await client.replyMessage(ev.replyToken, { type:"text", text:`${product.name}：${Number(product.stock||0)}個` });
            return;
          }
          if (parts.length === 4) {
            const op = parts[1];
            const pid = resolveProductId(parts[2]);
            const val = Number(parts[3]);
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
          if (parts.length === 3 && /^[+-]\d+$/.test(parts[2])) {
            const pid = resolveProductId(parts[1]);
            const delta = Number(parts[2]);
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
            "在庫コマンド使い方：\n" +
            "・在庫一覧\n" +
            "・在庫 久助\n" +
            "・在庫 設定 久助 50\n" +
            "・在庫 追加 久助 10\n" +
            "・在庫 減少 久助 3\n" +
            "・在庫 久助 +5 / 在庫 久助 -2"
          });
          return;
        }

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
            for (let i=0;i<userIds.length;i+=chunk) {
              await client.multicast(userIds.slice(i,i+chunk), [{ type:"text", text: message }]);
            }
            await client.replyMessage(ev.replyToken, { type:"text", text:`予約者 ${userIds.length}名に送信しました。` });
          } catch (e) {
            await client.replyMessage(ev.replyToken, { type:"text", text:`送信エラー：${e?.response?.data?.message || e.message || e}` });
          }
          return;
        }

        if (t.startsWith("予約連絡開始 ")) {
          const m = /^予約連絡開始\s+(\S+)\s+([\s\S]+)$/.exec(t);
          if (!m) { await client.replyMessage(ev.replyToken, { type:"text", text:"使い方：予約連絡開始 {商品名/ID} {本文}" }); return; }
          const pid = resolveProductId(m[1]);
          const message = m[2].trim();
          const userIds = buildReservationQueue(pid);
          const state = readNotifyState();
          state[pid] = { idx:0, userIds, message, updatedAt: new Date().toISOString() };
          state.__lastPid = pid;
          writeNotifyState(state);

          if (userIds.length === 0) { await client.replyMessage(ev.replyToken, { type:"text", text:`予約者がいません。（${pid}）` }); return; }
          try {
            await client.pushMessage(userIds[0], { type:"text", text: message });
            state[pid].idx = 1; state[pid].updatedAt = new Date().toISOString(); writeNotifyState(state);
            await client.replyMessage(ev.replyToken, { type:"text", text:`開始：${pid}\n1/${userIds.length} 件送信しました。次へ進むには「予約連絡次」と送ってください。` });
          } catch (e) {
            await client.replyMessage(ev.replyToken, { type:"text", text:`送信エラー：${e?.response?.data?.message || e.message || e}` });
          }
          return;
        }
        if (t === "予約連絡次" || t.startsWith("予約連絡次 ")) {
          const m = /^予約連絡次(?:\s+(\S+))?(?:\s+(\d+))?$/.exec(t);
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
        if (t.startsWith("予約連絡停止")) {
          const m = /^予約連絡停止(?:\s+(\S+))?$/.exec(t);
          const pid = resolveProductId(m?.[1] || readNotifyState().__lastPid || "");
          const state = readNotifyState();
          if (pid && state[pid]) delete state[pid];
          if (state.__lastPid === pid) delete state.__lastPid;
          writeNotifyState(state);
          await client.replyMessage(ev.replyToken, { type:"text", text:`停止しました：${pid || "(未指定)"}` });
          return;
        }
      }

      if (text === "直接注文") { return client.replyMessage(ev.replyToken, productsFlex(readProducts())); }
      if (text === "アンケート") { return client.replyMessage(ev.replyToken, { type:"text", text:"アンケート機能は準備中です。" }); }
      return client.replyMessage(ev.replyToken, { type: "text", text: "「直接注文」と送ると、商品一覧が表示されます。\n久助は「久助 2」のように、商品名＋半角個数でご入力ください。" });
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
          address: addr,
          image: product.image || ""
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
          if (BANK_INFO) { lines.push(BANK_INFO); }
          else { lines.push("（銀行口座情報が未設定です。管理者に連絡してください。）"); }
          if (BANK_NOTE) { lines.push("", BANK_NOTE); }
          lines.push("", "※ご入金確認後の発送となります。");
          try { await client.pushMessage(ev.source.userId, { type:"text", text: lines.join("\n") }); }
          catch (e) { console.error("bank info send error:", e?.response?.data || e); }
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
            : "住所：未登録"),
          product.image ? `画像：${product.image}` : ""
        ].filter(Boolean).join("\n");
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

// ====== Health checks ======
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
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
    }
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log("   LIFF address page: /public/liff-address.html  (open via https://liff.line.me/LIFF_ID)");
});
