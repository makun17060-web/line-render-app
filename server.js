// server.js — 画像対応・完全差し替え版
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
const PORT = Number(process.env.PORT || 3000);
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV      = (process.env.ADMIN_CODE || "").trim();      // 互換

const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret:      (process.env.LINE_CHANNEL_SECRET || "").trim(),
};
if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error("ERROR: .env の必須値が不足しています。LINE_* と LIFF_ID、ADMIN_* を確認してください。");
  process.exit(1);
}

// ====== ミドルウェア/静的配信 ======
app.use("/api", express.json({ limit: "10mb" }), express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== DATA_DIR & ファイル郡 ======
function pickWritableDir(cands) {
  for (const dir of cands) {
    if (!dir) continue;
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch {}
  }
  const fb = path.join(__dirname, "data");
  fs.mkdirSync(fb, { recursive: true });
  return fb;
}
const DATA_DIR = pickWritableDir([
  (process.env.DATA_DIR || "").trim(),
  (process.env.RENDER_DATA_DIR || "").trim(),
  "/data",
  path.join(__dirname, "data"),
]);

const PRODUCTS_PATH     = path.join(DATA_DIR, "products.json");
const ORDERS_LOG        = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG  = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH    = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG       = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG      = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH     = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG         = path.join(DATA_DIR, "stock.log");
const UPLOADS_DIR       = path.join(DATA_DIR, "uploads");

// 初期化
function initJSON(p, v){ if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8"); }
function initLog(p){ if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8"); }

if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250",        name: "久助（えびせん）",     price: 250,  stock: 30, desc: "お得な割れせん。", imageUrl: "" },
    { id: "nori-akasha-340",   name: "のりあかしゃ",         price: 340,  stock: 20, desc: "海苔の風味豊かなえびせんべい", imageUrl: "" },
    { id: "uzu-akasha-340",    name: "うずあかしゃ",         price: 340,  stock: 10, desc: "渦を巻いたえびせんべい", imageUrl: "" },
    { id: "shio-akasha-340",   name: "潮あかしゃ",           price: 340,  stock: 5,  desc: "あおさトッピング", imageUrl: "" },
    { id: "matsu-akasha-340",  name: "松あかしゃ",           price: 340,  stock: 30, desc: "海老たっぷり高級えびせんべい", imageUrl: "" },
    { id: "iso-akasha-340",    name: "磯あかしゃ",           price: 340,  stock: 30, desc: "高級海苔トッピング", imageUrl: "" },
    { id: "goma-akasha-340",   name: "ごまあかしゃ",         price: 340,  stock: 30, desc: "ごまトッピング", imageUrl: "" },
    { id: "original-set-2000", name: "磯屋オリジナルセット", price: 2000, stock: 30, desc: "6袋セット", imageUrl: "" }
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
}
initJSON(ADDRESSES_PATH, {});
initJSON(SESSIONS_PATH, {});
initJSON(NOTIFY_STATE_PATH, {});
initLog(ORDERS_LOG);
initLog(RESERVATIONS_LOG);
initLog(SURVEYS_LOG);
initLog(MESSAGES_LOG);
initLog(STOCK_LOG);
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// /uploads を公開（画像URL: https://xxx/uploads/ファイル名）
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "7d", immutable: true }));

// ====== 小ユーティリティ ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = { "久助": "kusuke-250", "くすけ": "kusuke-250", "kusuke": "kusuke-250", "kusuke-250": "kusuke-250" };
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]); // 直接注文の一覧から久助を隠す

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
const qstr = (obj) => Object.entries(obj).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
const parse = (data) => {
  const s = data && data.includes("=") ? data : "";
  const o = {}; s.split("&").forEach(kv => { const [k,v] = kv.split("="); if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  return o;
};
const uniq = (arr) => Array.from(new Set((arr||[]).filter(Boolean)));

function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex(p => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function resolveProductId(token) { return PRODUCT_ALIASES[token] || token; }

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
  res.status(401).json({ ok:false, error:"unauthorized" }); return false;
}

// ====== 画像アップロード（multer） ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpeg|jpg|webp|gif)/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  }
});
app.post("/api/admin/upload-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("image")(req, res, (err) => {
    if (err) return res.status(400).json({ ok:false, error:String(err.message||err) });
    if (!req.file) return res.status(400).json({ ok:false, error:"no_file" });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ ok:true, url: fileUrl, filename: req.file.filename });
  });
});

// 商品の imageUrl を更新（id と imageUrl を渡す）
app.post("/api/admin/products/image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!id || !imageUrl) return res.status(400).json({ ok:false, error:"id and imageUrl required" });
    const products = readProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx < 0) return res.status(404).json({ ok:false, error:"product_not_found" });
    products[idx].imageUrl = imageUrl;
    writeProducts(products);
    res.json({ ok:true, product: products[idx] });
  } catch(e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// ====== Health & Ping ======
app.get("/api/health", (_req, res) => {
  res.json({ ok:true, time:new Date().toISOString(), dataDir: DATA_DIR });
});
app.get("/api/admin/ping", (req, res) => { if (!requireAdmin(req, res)) return; res.json({ ok:true, ping:"pong" }); });

// ====== メッセージログ簡易API ======
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit)||100, lines.length));
  return tail.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
app.get("/api/admin/messages", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(200000, Number(req.query.limit || 2000));
  const items = readLogLines(MESSAGES_LOG, limit);
  res.json({ ok:true, items, path: MESSAGES_LOG });
});

// ====== 在庫API（最小限） ======
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map(p => ({ id:p.id, name:p.name, price:p.price, stock:p.stock ?? 0, desc:p.desc || "", imageUrl: p.imageUrl || "" }));
  res.json({ ok:true, items });
});

// ====== LINE client ======
const client = new line.Client(config);

// ====== Flex（画像つき） ======
function productsFlex(all) {
  const items = (all || []).filter(p => !HIDE_PRODUCT_IDS.has(p.id));
  const bubbles = items.map(p => {
    const hasImg = !!p.imageUrl;
    const bodyContents = [
      { type:"text", text:p.name, weight:"bold", size:"md", wrap:true },
      { type:"text", text:`価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size:"sm", wrap:true },
      p.desc ? { type:"text", text:p.desc, size:"sm", wrap:true } : { type:"box", layout:"vertical", contents:[] }
    ];
    const bubble = {
      type:"bubble",
      ...(hasImg ? { hero: { type:"image", url: absoluteUrl(p.imageUrl), size:"full", aspectRatio:"20:13", aspectMode:"cover" } } : {}),
      body: { type:"box", layout:"vertical", spacing:"sm", contents: bodyContents },
      footer: {
        type:"box", layout:"horizontal", spacing:"md",
        contents:[ { type:"button", style:"primary", action:{ type:"postback", label:"数量を選ぶ", data:`order_qty?${qstr({ id:p.id, qty:1 })}` } } ]
      }
    };
    return bubble;
  });

  // その他
  bubbles.push({
    type:"bubble",
    body:{ type:"box", layout:"vertical", spacing:"sm", contents:[
      { type:"text", text:"その他（自由入力）", weight:"bold", size:"md" },
      { type:"text", text:"商品名と個数だけ入力します。価格入力は不要です。", size:"sm", wrap:true }
    ]},
    footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"button", style:"primary", action:{ type:"postback", label:"商品名を入力する", data:"other_start" } },
      { type:"button", style:"secondary", action:{ type:"postback", label:"← 戻る", data:"order_back" } }
    ]}
  });

  return { type:"flex", altText:"商品一覧", contents: bubbles.length===1 ? bubbles[0] : { type:"carousel", contents:bubbles } };
}
function absoluteUrl(p) {
  if (!p) return "";
  // すでに http(s) ならそのまま、/ から始まるなら同一オリジン扱い
  if (/^https?:\/\//i.test(p)) return p;
  return p.startsWith("/") ? p : "/"+p;
}

// ====== 簡易 Webhook（数量選択まわりのみ） ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try { await Promise.all((req.body.events||[]).map(handleEvent)); res.status(200).end(); }
  catch(e){ console.error("Webhook error:", e?.response?.data || e); res.status(500).end(); }
});

function qtyFlex(id, qty=1) {
  const q = Math.max(1, Math.min(99, Number(qty)||1));
  return {
    type:"flex", altText:"数量を選択してください",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"数量選択", weight:"bold", size:"lg" },
          { type:"text", text:`現在の数量：${q} 個`, size:"md" }
        ]},
      footer:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"box", layout:"horizontal", spacing:"md",
            contents:[
              { type:"button", style:"secondary", action:{ type:"postback", label:"-1", data:`order_qty?${qstr({ id, qty: Math.max(1,q-1) })}` } },
              { type:"button", style:"secondary", action:{ type:"postback", label:"+1", data:`order_qty?${qstr({ id, qty: Math.min(99,q+1) })}` } }
            ]},
          { type:"box", layout:"horizontal", spacing:"md",
            contents:[1,2,3,5].map(n => ({ type:"button", style: n===q ? "primary":"secondary", action:{ type:"postback", label:`${n}個`, data:`order_qty?${qstr({ id, qty:n })}` } })) },
          { type:"button", style:"primary", action:{ type:"postback", label:"受取方法へ", data:`order_method?${qstr({ id, qty:q })}` } },
          { type:"button", style:"secondary", action:{ type:"postback", label:"← 商品一覧", data:"order_back" } }
        ]}
    }
  };
}
function methodFlex(id, qty){
  return {
    type:"flex", altText:"受取方法を選択してください",
    contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md",
        contents:[
          { type:"text", text:"受取方法", weight:"bold", size:"lg" },
          { type:"text", text:"宅配 または 店頭受取 を選択してください。", wrap:true }
        ]},
      footer:{ type:"box", layout:"horizontal", spacing:"md",
        contents:[
          { type:"button", style:"primary", action:{ type:"postback", label:"宅配（送料あり）", data:`order_region?${qstr({ id, qty, method:"delivery" })}` } },
          { type:"button", style:"secondary", action:{ type:"postback", label:"店頭受取（送料0円）", data:`order_payment?${qstr({ id, qty, method:"pickup", region:"-" })}` } }
        ]}
    }
  };
}
const SHIPPING_BY_REGION = {
  "北海道":1100,"東北":900,"関東":800,"中部":800,"近畿":900,"中国":1000,"四国":1000,"九州":1100,"沖縄":1400
};
const COD_FEE = 330;

function regionFlex(id, qty) {
  const regions = Object.keys(SHIPPING_BY_REGION);
  const rows = [];
  for (let i=0;i<regions.length;i+=2){
    rows.push({ type:"box", layout:"horizontal", spacing:"md",
      contents: regions.slice(i,i+2).map(r => ({
        type:"button", style:"secondary",
        action:{ type:"postback", label:`${r}（${yen(SHIPPING_BY_REGION[r])}）`, data:`order_payment?${qstr({ id, qty, method:"delivery", region:r })}` }
      }))
    });
  }
  return { type:"flex", altText:"地域選択", contents:{ type:"bubble",
    body:{ type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"text", text:"地域選択", weight:"bold", size:"lg" },
      { type:"text", text:"地域により送料が異なります。", wrap:true }
    ]},
    footer:{ type:"box", layout:"vertical", spacing:"sm", contents: rows }
  }};
}
function paymentFlex(id, qty, method, region){
  if (method === "pickup") {
    return { type:"flex", altText:"お支払い（店頭）", contents:{ type:"bubble",
      body:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"text", text:"お支払い方法", weight:"bold", size:"lg" },
        { type:"text", text:"店頭受取は現金のみです。", wrap:true }
      ]},
      footer:{ type:"box", layout:"vertical", spacing:"md", contents:[
        { type:"button", style:"primary", action:{ type:"postback", label:"現金で支払う（店頭）", data:`order_confirm_view?${qstr({ id, qty, method:"pickup", region:"", payment:"cash" })}` } },
        { type:"button", style:"secondary", action:{ type:"postback", label:"← 受取方法へ戻る", data:`order_method?${qstr({ id, qty })}` } }
      ]}
    }};
  }
  const regionText = method === "delivery" ? `（配送地域：${region}）` : "";
  return { type:"flex", altText:"お支払い方法を選択してください", contents:{ type:"bubble",
    body:{ type:"box", layout:"vertical", spacing:"md", contents:[
      { type:"text", text:"お支払い方法", weight:"bold", size:"lg" },
      { type:"text", text:`代引きは +${yen(COD_FEE)}${regionText}`, wrap:true }
    ]},
    footer:{ type:"box", layout:"horizontal", spacing:"md", contents:[
      { type:"button", style:"primary", action:{ type:"postback", label:`代金引換（+${yen(COD_FEE)}）`, data:`order_confirm_view?${qstr({ id, qty, method, region, payment:"cod" })}` } },
      { type:"button", style:"secondary", action:{ type:"postback", label:"銀行振込", data:`order_confirm_view?${qstr({ id, qty, method, region, payment:"bank" })}` } }
    ]}
  }};
}

async function handleEvent(ev){
  try{
    if (ev.type === "message" && ev.message?.type === "text") {
      try{ fs.appendFileSync(MESSAGES_LOG, JSON.stringify({ ts:new Date().toISOString(), userId: ev.source?.userId||"", type:"text", len:(ev.message.text||"").length })+"\n","utf8"); }catch{}
      const text = (ev.message.text||"").trim();
      if (text === "直接注文") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
      return client.replyMessage(ev.replyToken, { type:"text", text:"「直接注文」と送ると、画像つきの商品一覧が表示されます。" });
    }
    if (ev.type === "postback") {
      try{ fs.appendFileSync(MESSAGES_LOG, JSON.stringify({ ts:new Date().toISOString(), userId: ev.source?.userId||"", type:"postback", data: String(ev.postback?.data||"").slice(0,200) })+"\n","utf8"); }catch{}
      const d = String(ev.postback?.data || "");
      if (d === "other_start") return client.replyMessage(ev.replyToken, { type:"text", text:"その他の商品名を入力してください。（この簡易版では未実装）" });
      if (d.startsWith("order_qty?")) {
        const { id, qty } = parse(d.replace("order_qty?",""));
        return client.replyMessage(ev.replyToken, qtyFlex(id, qty));
      }
      if (d.startsWith("order_method?")) {
        const { id, qty } = parse(d.replace("order_method?",""));
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d.startsWith("order_region?")) {
        const { id, qty, method } = parse(d.replace("order_region?",""));
        if (method === "delivery") return client.replyMessage(ev.replyToken, regionFlex(id, qty));
        return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
      }
      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parse(d.replace("order_payment?",""));
        method = (method||"").trim(); region = (region||"").trim(); if (region === "-") region = "";
        if (method === "pickup")   return client.replyMessage(ev.replyToken, paymentFlex(id, qty, "pickup", ""));
        if (method === "delivery") return client.replyMessage(ev.replyToken, region ? paymentFlex(id, qty, "delivery", region) : regionFlex(id, qty));
        return client.replyMessage(ev.replyToken, methodFlex(id, qty));
      }
      if (d === "order_back") {
        return client.replyMessage(ev.replyToken, productsFlex(readProducts()));
      }
    }
  }catch(e){
    console.error("handleEvent error:", e?.response?.data || e);
    if (ev.replyToken) { try { await client.replyMessage(ev.replyToken, { type:"text", text:"エラーが発生しました。もう一度お試しください。" }); } catch {} }
  }
}

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
  console.log(`   Uploads:  /uploads  （保存先: ${UPLOADS_DIR}）`);
});
