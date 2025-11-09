// server.js — 店頭受取で「受取名」を必須化（名前入力フロー追加）版
/* 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN または ADMIN_CODE)
   任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO */
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();      // 互換（クエリ ?code= でも可）

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

// ====== ミドルウェア ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== データパス ======
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH     = path.join(DATA_DIR, "products.json");
const ORDERS_LOG        = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG  = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH    = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG       = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG      = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH     = path.join(DATA_DIR, "sessions.json");

// 在庫管理
const STOCK_LOG         = path.join(DATA_DIR, "stock.log");
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = {
  "久助": "kusuke-250",
  "くすけ": "kusuke-250",
  "kusuke": "kusuke-250",
  "kusuke-250": "kusuke-250",
};
// 一覧から隠す（久助）
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",      name: "久助（えびせん）",     price: 250, stock: 20, desc: "お得な割れせん。" },
    { id: "nori-akasha-340", name: "のりあかしゃ",         price: 340, stock: 20, desc: "海苔の風味豊かなえびせんべい" },
    { id: "uzu-akasha-340",  name: "うずあかしゃ",         price: 340, stock: 10, desc: "渦を巻いたえびせんべい" }
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
}
if (!fs.existsSync(ADDRESSES_PATH)) fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH)) fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");

// 予約者順次通知の状態
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
if (!fs.existsSync(NOTIFY_STATE_PATH)) fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");

// ====== util ======
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

// 在庫
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

// 認可
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

// ログユーティリティ
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// 配送料 & 代引き
const SHIPPING_BY_REGION = {
  "北海道": 1100, "東北": 900, "関東": 800, "中部": 800,
  "近畿": 900, "中国": 1000, "四国": 1000, "九州": 1100, "沖縄": 1400
};
const COD_FEE = 330;

// LINE client
const client = new line.Client(config);

// ====== Flex送信ユーティリティ ======
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

  // 「その他（自由入力）」：価格入力なし（名前→個数→受取方法）
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

  return { type: "flex", altText: "商品一覧", contents: bubbles.length === 1 ? bubbles[0] : { type: "carousel", contents: bubbles } };
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

// 店頭受取は現金のみ + ここでは使用しない（名前先取り）
// 宅配は 代引 or 振込
function paymentFlex(id, qty, method, region) {
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

function confirmFlex(product, qty, method, region, payment, LIFF_ID, pickupName) {
  // other:NAME(:PRICE)? の復元
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
    ...(method === "pickup" && pickupName ? [`受取名：${pickupName}`] : []),
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
    { type: "button", style: "primary",
      action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method, region, payment, pname: pickupName || "" })}` } },
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

// ====== アンケート（省略：元のまま使う場合はここに実装） ======
const SURVEY_VERSION = 2;
const SURVEY_SCHEMA = {
  q1: { title: "Q1. 当店を知ったきっかけは？", options: [{code:"sns",label:"SNS"},{code:"intro",label:"紹介"},{code:"walk",label:"通りがかり"}] },
  q2: { title: "Q2. お好きな味は？", options: [{code:"salt",label:"塩"},{code:"nori",label:"のり"},{code:"ebi",label:"えび濃いめ"}] },
  q3: { title: "Q3. 新商品情報を受け取りますか？", options: [{code:"ok",label:"受け取る"},{code:"ng",label:"受け取らない"}] },
};
function labelOf(q, code){ const o=(SURVEY_SCHEMA[q]?.options||[]).find(x=>x.code===code); return o?o.label:code; }
function surveyQ1(){ return { type:"text", text:"（アンケート準備中）" }; }
function surveyQ2(){ return { type:"text", text:"（アンケート準備中）" }; }
function surveyQ3(){ return { type:"text", text:"（アンケート準備中）" }; }

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

// ====== 管理API（必要最低限・抜粋） ======
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({ id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0, desc:p.desc || "" }));
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
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();

      // --- 店頭受取：名前入力待ちフロー ---
      if (sess?.await === "pickupName") {
        const name = text.slice(0, 30).trim();
        if (!name) {
          await client.replyMessage(ev.replyToken, { type:"text", text:"お受取時のお名前を入力してください（例：山田太郎）" });
          return;
        }
        const tmp = sess.temp || {};
        delete sessions[uid]; writeSessions(sessions);

        // 支払いは現金固定 / 地域は空
        const id = tmp.id, qty = tmp.qty;
        await client.replyMessage(ev.replyToken,
          confirmFlex(resolveProduct(id), qty, "pickup", "", "cash", LIFF_ID, name)
        );
        return;
      }

      // ★ 久助：半角個数クイック
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

      // ★ その他（価格入力なし）
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

      // 管理者向け簡易コマンド（在庫一覧など）
      if (ev.source?.userId && ADMIN_USER_ID && ev.source.userId === ADMIN_USER_ID) {
        const t = text.replace(/\s+/g, " ").trim();
        if (t === "在庫一覧") {
          const items = readProducts().map(p => `・${p.name}（${p.id}）：${Number(p.stock||0)}個`).join("\n");
          await client.replyMessage(ev.replyToken, { type:"text", text: items || "商品がありません。" });
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
      return client.replyMessage(ev.replyToken, { type: "text", text: "「直接注文」と送ると、商品一覧が表示されます。\n久助は「久助 2」のように、商品名＋半角個数でご入力ください。" });
    }

    if (ev.type === "postback") {
      const d = ev.postback?.data || "";

      // その他開始
      if (d === "other_start") {
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await: "otherName" };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, { type: "text", text: "その他の商品名を入力してください。" });
        return;
      }

      // 注文フロー
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
        return client.replyMessage(ev.replyToken, { type:"text", text:"不正なフローです。やり直してください。" });
      }

      // ★ 店頭受取はここで「受取名」入力を挟む
      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parse(d.replace("order_payment?", ""));
        method = (method || "").trim();
        region = (region || "").trim();
        if (region === "-") region = "";

        const uid = ev.source?.userId || "";
        const sessions = readSessions();

        if (method === "pickup") {
          // 受取名をテキストで尋ね、OKなら confirmFlex へ（現金固定）
          sessions[uid] = { await: "pickupName", temp: { id, qty } };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, { type:"text", text:"お受取時のお名前を入力してください（例：山田太郎）" });
          return;
        }

        if (method === "delivery") {
          if (!region) return client.replyMessage(ev.replyToken, regionFlex(id, qty));
          return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "delivery", region));
        }
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }

      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, region, payment, pname } = parse(d.replace("order_confirm_view?", ""));
        const product = resolveProduct(id);
        if (!product) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
        return client.replyMessage(ev.replyToken, confirmFlex(product, qty, method, region, payment, LIFF_ID, pname));
      }

      if (d === "order_back") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }

      if (d.startsWith("order_confirm?")) {
        const { id, qty, method, region, payment, pname } = parse(d.replace("order_confirm?", ""));
        const need = Math.max(1, Number(qty) || 1);

        let product = null;
        let products = readProducts();
        let idx = products.findIndex(p => p.id === id);

        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
          idx = -1; // 在庫処理なし
        } else {
          if (idx === -1) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりませんでした。" });
          product = products[idx];
          if (!product.stock || product.stock < need) {
            return client.replyMessage(ev.replyToken, reserveOffer(product, need, product.stock || 0));
          }
          products[idx].stock = Number(product.stock) - need;
          writeProducts(products);
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
          pickupName: method === "pickup" ? (pname || "") : "",
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
          ...(method === "pickup" && order.pickupName ? [`受取名：${order.pickupName}`] : []),
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

        // 宅配 + 銀行振込：振込先案内
        if (method === "delivery" && payment === "bank") {
          const bankInfo = (process.env.BANK_INFO || "").trim();
          const bankMsg = bankInfo
            ? `▼ 振込先\n${bankInfo}\n\n※ご入金確認後の発送となります。`
            : "▼ 振込先\n（銀行口座情報が未設定です。管理者に連絡してください。）";
          try {
            await client.pushMessage(ev.source.userId, { type: "text", text: bankMsg });
          } catch {}
        }

        // 管理者通知
        const adminMsg = [
          "🧾 新規注文",
          `ユーザーID：${ev.source?.userId || ""}`,
          ...(order.pickupName ? [`受取名：${order.pickupName}`] : []),
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
        return;
      }

      // アンケート（省略版）
      if (d.startsWith("survey_q2?")) return client.replyMessage(ev.replyToken, surveyQ2());
      if (d.startsWith("survey_q3?")) return client.replyMessage(ev.replyToken, surveyQ3());
      if (d.startsWith("survey_submit?")) {
        const { ans1, ans2, ans3 } = parse(d.replace("survey_submit?", ""));
        const rec = { ts: new Date().toISOString(), userId: ev.source?.userId || "", version: SURVEY_VERSION, answers: {
          q1: { code: ans1, label: labelOf("q1", ans1) },
          q2: { code: ans2, label: labelOf("q2", ans2) },
          q3: { code: ans3, label: labelOf("q3", ans3) },
        }};
        try { fs.appendFileSync(SURVEYS_LOG, JSON.stringify(rec) + "\n", "utf8"); } catch {}
        await client.replyMessage(ev.replyToken, { type: "text", text: "アンケートのご協力、ありがとうございました！" });
        return;
      }
    }
  } catch (err) {
    console.error("handleEvent error:", err?.response?.data || err?.stack || err);
    if (ev.replyToken) { try { await client.replyMessage(ev.replyToken, { type: "text", text: "エラーが発生しました。もう一度お試しください。" }); } catch {} }
  }
}

// 商品解決（id→商品）
function resolveProduct(id){
  if (String(id).startsWith("other:")) {
    const parts = String(id).split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    return { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: Infinity };
  }
  const { product } = findProductById(id);
  return product || null;
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
      BANK_INFO: !!process.env.BANK_INFO
    }
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log("   LIFF address page: /public/liff-address.html  (open via https://liff.line.me/LIFF_ID)");
});
