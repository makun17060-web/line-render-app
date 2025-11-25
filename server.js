// server.js — フル機能版（イプシロン + ミニアプリ + 画像管理）
// + Flex配信
// + 「その他＝価格入力なし」
// + 久助専用テキスト購入フロー
// + 予約者連絡API/コマンド（テキスト＆管理API）
// + 店頭受取 Fix（店頭=現金のみ）
// + 銀行振込案内（コメント対応）
// + 画像アップロード/一覧/削除 + 商品へ画像URL紐付け
// + ミニアプリ用 /api/products（久助除外）
// + ミニアプリ用 /api/shipping（住所から地域判定して送料）
// + LIFF 住所保存/取得 API（/api/liff/address, /api/liff/address/me, /api/liff/config）
//   ★ LIFF_ID_ONLINE（products.html）と LIFF_ID_DIRECT（住所直）の2本分離
// + イプシロン決済 /api/pay + 旧URL /api/pay-epsilon
// + イプシロン入金通知 /api/epsilon/notify
// + 汎用 Health チェック, /my-ip

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

// ★ LIFFを2本に分離
const LIFF_ID_ONLINE = (process.env.LIFF_ID_ONLINE || "").trim(); // products.html
const LIFF_ID_DIRECT = (process.env.LIFF_ID_DIRECT || "").trim(); // liff-address-direct.html

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim();

const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "")
  .trim().replace(/\/+$/, "");

// LINE config
const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (!config.channelAccessToken || !config.channelSecret ||
    !LIFF_ID_ONLINE || !LIFF_ID_DIRECT ||
    (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error(
`ERROR: .env の必須値が不足しています。
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- LIFF_ID_ONLINE
- LIFF_ID_DIRECT
- （ADMIN_API_TOKEN または ADMIN_CODE）`
  );
  process.exit(1);
}

// ====== パス定義 ======
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");
const EPSILON_NOTIFY_LOG = path.join(DATA_DIR, "epsilon_notify.log");

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

// ====== ディレクトリ自動作成 ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ====== ミドルウェア ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(PUBLIC_DIR));

app.all("/public/confirm-success.html", (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "confirm-success.html"))
);
app.all("/public/confirm-fail.html", (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, "confirm-fail.html"))
);

app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== データ初期化 ======
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250", name: "久助（えびせん）", price: 250, stock: 20, desc: "お得な割れせん。", image: "" },
    { id: "nori-square-300", name: "四角のりせん", price: 300, stock: 10, desc: "のり香る角せん。", image: "" },
    { id: "premium-ebi-400", name: "プレミアムえびせん", price: 400, stock: 5, desc: "贅沢な旨み。", image: "" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
}
if (!fs.existsSync(ADDRESSES_PATH))
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH))
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH))
  fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");

// ====== ユーティリティ ======
const safeReadJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } };
const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (data) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");
const readAddresses = () => safeReadJSON(ADDRESSES_PATH, {});
const writeAddresses = (data) => fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");
const readSessions = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions = (s) => fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");
const readNotifyState = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (s) => fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s, null, 2), "utf8");

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
const qstr = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`).join("&");
const parse = (data) => {
  const s = data && data.includes("=") ? data : "";
  const o = {};
  s.split("&").forEach((kv) => { const [k, v] = kv.split("="); if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  return o;
};
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

// ====== 在庫ユーティリティ ======
const LOW_STOCK_THRESHOLD = 5;
const PRODUCT_ALIASES = { 久助:"kusuke-250", くすけ:"kusuke-250", kusuke:"kusuke-250", "kusuke-250":"kusuke-250" };
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function resolveProductId(token) { return PRODUCT_ALIASES[token] || token; }

const STOCK_LOG_APPEND = (entry)=>{ try{ fs.appendFileSync(STOCK_LOG, JSON.stringify({ts:new Date().toISOString(),...entry})+"\n"); }catch{} };
function setStock(productId, qty, actor="system"){ 
  const q=Math.max(0,Number(qty)||0);
  const {products,idx,product}=findProductById(productId);
  if(idx<0) throw new Error("product_not_found");
  const before=Number(product.stock||0);
  products[idx].stock=q; writeProducts(products);
  STOCK_LOG_APPEND({action:"set",productId,before,after:q,delta:q-before,actor});
  return {before,after:q};
}
function addStock(productId, delta, actor="system"){
  const d=Number(delta)||0;
  const {products,idx,product}=findProductById(productId);
  if(idx<0) throw new Error("product_not_found");
  const before=Number(product.stock||0);
  const after=Math.max(0,before+d);
  products[idx].stock=after; writeProducts(products);
  STOCK_LOG_APPEND({action:"add",productId,before,after,delta:d,actor});
  return {before,after};
}

async function maybeLowStockAlert(productId, productName, stockNow) {
  const client = new line.Client(config);
  if (stockNow < LOW_STOCK_THRESHOLD && ADMIN_USER_ID) {
    const msg = `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n残り：${stockNow}個`;
    try { await client.pushMessage(ADMIN_USER_ID, { type:"text", text:msg }); } catch {}
  }
}

// ====== 認可 ======
function bearerToken(req) {
  const h=req.headers?.authorization||req.headers?.Authorization||"";
  const m=/^Bearer\s+(.+)$/i.exec(h);
  return m?m[1].trim():null;
}
function requireAdmin(req,res){
  const headerTok=bearerToken(req);
  const queryTok=(req.query?.token||req.query?.code||"").trim();
  const tok=headerTok||queryTok;
  if(ADMIN_API_TOKEN_ENV && tok===ADMIN_API_TOKEN_ENV) return true;
  if(ADMIN_CODE_ENV && tok===ADMIN_CODE_ENV) return true;
  res.status(401).json({ok:false,error:"unauthorized"});
  return false;
}

// ===== 配送料 & 代引き =====
const SHIPPING_BY_REGION = { 北海道:1100, 東北:900, 関東:800, 中部:800, 近畿:900, 中国:1000, 四国:1000, 九州:1100, 沖縄:1400 };
const COD_FEE = 330;

// ===== LINE client =====
const client = new line.Client(config);

// ===== Flex送信ユーティリティ =====
function ensureAltText(altText){
  const s=String(altText||"").trim();
  if(!s) throw new Error("altText is required");
  if(s.length>400) throw new Error("altText too long");
  return s;
}
function validateFlexContents(contents){
  if(!contents||typeof contents!=="object") throw new Error("contents must be object");
  const t=contents.type;
  if(t!=="bubble"&&t!=="carousel") throw new Error("contents.type invalid");
  return contents;
}

// ===== 画像URL整形（Flex用） =====
function toPublicImageUrl(raw){
  if(!raw) return "";
  let s=String(raw).trim(); if(!s) return "";
  s=s.replace(".onrender.com./",".onrender.com/");
  if(/^https?:\/\//i.test(s)) return s;
  let fname=s; const lastSlash=s.lastIndexOf("/");
  if(lastSlash>=0) fname=s.slice(lastSlash+1);
  const pathPart=`/public/uploads/${fname}`;
  const hostFromRender=process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL||"").replace(/^https?:\/\//,"").replace(/\/.*$/,"");
  if(hostFromRender) return `https://${hostFromRender}${pathPart}`;
  return pathPart;
}

// ===== 商品UI（Flex） ======
function productsFlex(allProducts){
  const products=(allProducts||[]).filter(p=>!HIDE_PRODUCT_IDS.has(p.id));
  const bubbles=products.map((p)=>{
    const imgUrl=toPublicImageUrl(p.image);
    return {
      type:"bubble",
      hero: imgUrl?{type:"image",url:imgUrl,size:"full",aspectRatio:"1:1",aspectMode:"cover"}:undefined,
      body:{type:"box",layout:"vertical",spacing:"sm",
        contents:[
          {type:"text",text:p.name,weight:"bold",size:"md",wrap:true},
          {type:"text",text:`価格：${yen(p.price)}　在庫：${p.stock ?? 0}`,size:"sm",wrap:true},
          p.desc?{type:"text",text:p.desc,size:"sm",wrap:true}:{type:"box",layout:"vertical",contents:[]},
        ].filter(Boolean)
      },
      footer:{type:"box",layout:"horizontal",spacing:"md",
        contents:[{type:"button",style:"primary",action:{type:"postback",label:"数量を選ぶ",data:`order_qty?${qstr({id:p.id,qty:1})}`}}]
      }
    };
  });

  bubbles.push({
    type:"bubble",
    body:{type:"box",layout:"vertical",spacing:"sm",
      contents:[
        {type:"text",text:"その他（自由入力）",weight:"bold",size:"md"},
        {type:"text",text:"商品名と個数だけ入力します。価格入力は不要です。",size:"sm",wrap:true},
      ]
    },
    footer:{type:"box",layout:"vertical",spacing:"md",
      contents:[
        {type:"button",style:"primary",action:{type:"postback",label:"商品名を入力する",data:"other_start"}},
        {type:"button",style:"secondary",action:{type:"postback",label:"← 戻る",data:"order_back"}},
      ]
    }
  });

  return { type:"flex", altText:"商品一覧",
    contents: bubbles.length===1?bubbles[0]:{type:"carousel",contents:bubbles}
  };
}

function qtyFlex(id, qty=1){
  const q=Math.max(1,Math.min(99,Number(qty)||1));
  return {
    type:"flex", altText:"数量を選択してください",
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",spacing:"md",
        contents:[
          {type:"text",text:"数量選択",weight:"bold",size:"lg"},
          {type:"text",text:`現在の数量：${q} 個`,size:"md"},
        ]
      },
      footer:{type:"box",layout:"vertical",spacing:"md",
        contents:[
          {type:"box",layout:"horizontal",spacing:"md",
            contents:[
              {type:"button",style:"secondary",action:{type:"postback",label:"-1",data:`order_qty?${qstr({id,qty:Math.max(1,q-1)})}`}},
              {type:"button",style:"secondary",action:{type:"postback",label:"+1",data:`order_qty?${qstr({id,qty:Math.min(99,q+1)})}`}},
            ]
          },
          {type:"button",style:"primary",action:{type:"postback",label:"受取方法へ",data:`order_method?${qstr({id,qty:q})}`}},
          {type:"button",style:"secondary",action:{type:"postback",label:"← 商品一覧",data:"order_back"}},
        ]
      }
    }
  };
}

function methodFlex(id, qty){
  return {
    type:"flex", altText:"受取方法を選択してください",
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",spacing:"md",
        contents:[
          {type:"text",text:"受取方法",weight:"bold",size:"lg"},
          {type:"text",text:"宅配 または 店頭受取 を選択してください。",wrap:true},
        ]
      },
      footer:{type:"box",layout:"horizontal",spacing:"md",
        contents:[
          {type:"button",style:"primary",action:{type:"postback",label:"宅配（送料あり）",data:`order_region?${qstr({id,qty,method:"delivery"})}`}},
          {type:"button",style:"secondary",action:{type:"postback",label:"店頭受取（送料0円）",data:`order_payment?${qstr({id,qty,method:"pickup",region:"-"})}`}},
        ]
      }
    }
  };
}

function regionFlex(id, qty){
  const regions=Object.keys(SHIPPING_BY_REGION);
  const rows=[];
  for(let i=0;i<regions.length;i+=2){
    rows.push({type:"box",layout:"horizontal",spacing:"md",
      contents: regions.slice(i,i+2).map(r=>({
        type:"button",style:"secondary",
        action:{type:"postback",label:`${r}（${yen(SHIPPING_BY_REGION[r])}）`,
          data:`order_payment?${qstr({id,qty,method:"delivery",region:r})}`}
      }))
    });
  }
  return {
    type:"flex", altText:"地域選択",
    contents:{type:"bubble",
      body:{type:"box",layout:"vertical",spacing:"md",
        contents:[
          {type:"text",text:"地域選択",weight:"bold",size:"lg"},
          {type:"text",text:"地域により送料が異なります。",wrap:true},
        ]
      },
      footer:{type:"box",layout:"vertical",spacing:"sm",contents:rows}
    }
  };
}

function paymentFlex(id, qty, method, region){
  if(method==="pickup"){
    return {
      type:"flex", altText:"お支払い（店頭）",
      contents:{
        type:"bubble",
        body:{type:"box",layout:"vertical",spacing:"md",
          contents:[
            {type:"text",text:"お支払い方法",weight:"bold",size:"lg"},
            {type:"text",text:"店頭受取は現金のみです。",wrap:true},
          ]
        },
        footer:{type:"box",layout:"vertical",spacing:"md",
          contents:[
            {type:"button",style:"primary",action:{type:"postback",label:"現金で支払う（店頭）",data:`order_confirm_view?${qstr({id,qty,method:"pickup",region:"",payment:"cash"})}`}},
            {type:"button",style:"secondary",action:{type:"postback",label:"← 受取方法へ戻る",data:`order_method?${qstr({id,qty})}`}},
          ]
        }
      }
    };
  }

  return {
    type:"flex", altText:"お支払い方法を選択してください",
    contents:{
      type:"bubble",
      body:{type:"box",layout:"vertical",spacing:"md",
        contents:[
          {type:"text",text:"お支払い方法",weight:"bold",size:"lg"},
          {type:"text",text:`代引きは +${yen(COD_FEE)}（配送地域：${region}）`,wrap:true},
        ]
      },
      footer:{type:"box",layout:"horizontal",spacing:"md",
        contents:[
          {type:"button",style:"primary",action:{type:"postback",label:`代金引換（+${yen(COD_FEE)}）`,data:`order_confirm_view?${qstr({id,qty,method,region,payment:"cod"})}`}},
          {type:"button",style:"secondary",action:{type:"postback",label:"銀行振込",data:`order_confirm_view?${qstr({id,qty,method,region,payment:"bank"})}`}},
        ]
      }
    }
  };
}

function confirmFlex(product, qty, method, region, payment, liffIdForBtn){
  if(typeof product?.id==="string" && product.id.startsWith("other:")){
    const parts=product.id.split(":");
    const encName=parts[1]||"";
    const priceStr=parts[2]||"0";
    product={...product,name:decodeURIComponent(encName||"その他"),price:Number(priceStr||0)};
  }

  const regionFee = method==="delivery" ? (SHIPPING_BY_REGION[region]||0) : 0;
  const codFee = payment==="cod"? COD_FEE : 0;
  const subtotal = Number(product.price)*Number(qty);
  const total = subtotal+regionFee+codFee;

  const payText = payment==="cod" ? `代金引換（+${yen(COD_FEE)}）` : payment==="bank" ? "銀行振込" : "現金（店頭）";

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
    {type:"text",text:"最終確認",weight:"bold",size:"lg"},
    ...lines.map(t=>({type:"text",text:t,wrap:true}))
  ];

  if(method==="delivery"){
    bodyContents.push({type:"text",text:"住所が未登録の方は「住所を入力（LIFF）」を押してください。",size:"sm",wrap:true});
  }

  const footerButtons = [
    {type:"button",style:"secondary",action:{type:"postback",label:"← 商品一覧へ",data:"order_back"}},
    {type:"button",style:"primary",action:{type:"postback",label:"この内容で確定",data:`order_confirm?${qstr({id:product.id,qty,method,region,payment})}`}},
  ];

  if(method==="delivery"){
    footerButtons.unshift({
      type:"button",style:"secondary",
      action:{
        type:"uri",
        label:"住所を入力（LIFF）",
        uri:`https://liff.line.me/${liffIdForBtn}?${qstr({from:"address",need:"shipping"})}`
      }
    });
  }

  const imgUrl = toPublicImageUrl(product.image);
  return {
    type:"flex", altText:"注文内容の最終確認",
    contents:{
      type:"bubble",
      hero: imgUrl?{type:"image",url:imgUrl,size:"full",aspectRatio:"1:1",aspectMode:"cover"}:undefined,
      body:{type:"box",layout:"vertical",spacing:"md",contents:bodyContents},
      footer:{type:"box",layout:"vertical",spacing:"md",contents:footerButtons}
    }
  };
}

function reserveOffer(product, needQty, stock){
  return [
    {type:"text",text:[
      "申し訳ありません。在庫が不足しています。",
      `商品：${product.name}`,
      `希望数量：${needQty}個 / 現在在庫：${stock}個`,
      "",
      "予約しますか？ 入荷次第ご案内します。"
    ].join("\n")},
    {type:"template",altText:"在庫不足：予約しますか？",
      template:{type:"confirm",text:"予約しますか？",
        actions:[
          {type:"postback",label:"予約する",data:`order_reserve?${qstr({id:product.id,qty:needQty})}`},
          {type:"postback",label:"やめる",data:"order_cancel"}
        ]}}
  ];
}

// ====== LIFF API ======
// ★ 保存（フラット形式に統一）
// 受け取り: { userId, postal, prefecture, city, address1, address2, name, phone }
app.post("/api/liff/address", (req, res) => {
  try {
    const {
      userId, name, phone, postal, prefecture, city, address1, address2
    } = req.body || {};
    if (!userId) return res.status(400).json({ ok:false, error:"userId required" });

    const book = readAddresses();
    book[userId] = {
      name, phone, postal, prefecture, city, address1, address2,
      ts: new Date().toISOString()
    };
    writeAddresses(book);
    res.json({ ok:true });
  } catch (e) {
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// 自分の住所取得
app.get("/api/liff/address/me", (req, res) => {
  try {
    const userId = String(req.query.userId || req.headers["x-line-userid"] || "").trim();
    const book = readAddresses();
    if (userId && book[userId]) return res.json({ ok:true, address: book[userId] });

    const vals = Object.values(book || {});
    let last=null;
    if (vals.length){ vals.sort((a,b)=>new Date(b.ts||0)-new Date(a.ts||0)); last=vals[0]; }
    return res.json({ ok:true, address:last });
  } catch (e) {
    res.json({ ok:false, address:null });
  }
});

// ★ LIFF 設定（online/direct返し分け）
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "online");
  if (kind === "direct") return res.json({ liffId: LIFF_ID_DIRECT });
  return res.json({ liffId: LIFF_ID_ONLINE });
});

// ====== ミニアプリ用：商品一覧 API（久助除外） ======
app.get("/api/products", (req, res) => {
  try {
    const items = readProducts()
      .filter((p) => p.id !== "kusuke-250")
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        image: toPublicImageUrl(p.image || ""),
      }));
    res.json({ ok: true, products: items });
  } catch (e) {
    res.status(500).json({ ok:false, error:"server_error" });
  }
});

// ====== ミニアプリ用：送料計算 API ======
function detectRegionFromAddress(address={}){
  const pref=String(address.prefecture||address.pref||"").trim();
  const addr1=String(address.addr1||address.address1||"").trim();
  const hay=pref||addr1;
  if(/北海道/.test(hay)) return "北海道";
  if(/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if(/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if(/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if(/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿)/.test(hay)) return "近畿";
  if(/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if(/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if(/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if(/(沖縄)/.test(hay)) return "沖縄";
  return "";
}

app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};
    const itemsTotal = items.reduce((sum,it)=>sum+(Number(it.price)||0)*(Number(it.qty)||0),0);
    const region = detectRegionFromAddress(address);
    const shipping = region ? (SHIPPING_BY_REGION[region]||0) : 0;
    const finalTotal = itemsTotal + shipping;
    res.json({ ok:true, itemsTotal, region, shipping, finalTotal });
  } catch (e) {
    res.status(400).json({ ok:false, error:e.message||"shipping_error" });
  }
});

// ====== Webhook ======
app.post("/webhook", line.middleware(config), async (req,res)=>{
  try{
    const events=req.body.events||[];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  }catch(err){
    console.error("Webhook error:", err?.response?.data||err);
    res.status(500).end();
  }
});

// ====== イベント処理 ======
async function handleEvent(ev){
  try{
    if(ev.type==="message" && ev.message?.type==="text"){
      try{
        fs.appendFileSync(MESSAGES_LOG, JSON.stringify({
          ts:new Date().toISOString(),
          userId:ev.source?.userId||"",
          type:"text",
          len:(ev.message.text||"").length
        })+"\n");
      }catch{}

      const sessions=readSessions();
      const uid=ev.source?.userId||"";
      const sess=sessions[uid]||null;
      const text=(ev.message.text||"").trim();
      const t=text.replace(/\s+/g," ").trim();

      if(t==="問い合わせ"){
        await client.replyMessage(ev.replyToken,{type:"text",text:"お問い合わせありがとうございます。\nこのままトークにご質問内容を送ってください。\nスタッフが確認して返信します。"});
        return;
      }

      // 久助テキスト注文
      const kusukeRe=/^久助(?:\s+(\d+))?$/i;
      const km=kusukeRe.exec(text);
      if(km){
        const qtyStr=km[1];
        if(!qtyStr){
          sessions[uid]={await:"kusukeQty"}; writeSessions(sessions);
          await client.replyMessage(ev.replyToken,{type:"text",text:"久助の個数を半角数字で入力してください（例：2）"});
          return;
        }
        const qty=Math.max(1,Math.min(99,Number(qtyStr)));
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250",qty));
        return;
      }
      if(sess?.await==="kusukeQty"){
        if(!/^\d+$/.test(text)){
          await client.replyMessage(ev.replyToken,{type:"text",text:"半角数字で入力してください（例：2）"});
          return;
        }
        const qty=Math.max(1,Math.min(99,Number(text)));
        delete sessions[uid]; writeSessions(sessions);
        await client.replyMessage(ev.replyToken, methodFlex("kusuke-250",qty));
        return;
      }

      // その他フロー
      if(sess?.await==="otherName"){
        const name=text.slice(0,50).trim();
        if(!name){
          await client.replyMessage(ev.replyToken,{type:"text",text:"商品名を入力してください。"});
          return;
        }
        sessions[uid]={await:"otherQty", temp:{name}};
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken,{type:"text",text:`「${name}」ですね。個数を半角数字で入力してください。例：2`});
        return;
      }
      if(sess?.await==="otherQty"){
        if(!/^\d+$/.test(text)){
          await client.replyMessage(ev.replyToken,{type:"text",text:"個数は半角数字で入力してください。例：2"});
          return;
        }
        const qty=Math.max(1,Math.min(99,Number(text)));
        const name=sess.temp?.name||"その他";
        delete sessions[uid]; writeSessions(sessions);
        const id=`other:${encodeURIComponent(name)}:0`;
        await client.replyMessage(ev.replyToken, methodFlex(id,qty));
        return;
      }

      // 一般ユーザー
      if(text==="直接注文"){
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }
      return;
    }

    if(ev.type==="postback"){
      const d=ev.postback?.data||"";

      if(d==="other_start"){
        const sessions=readSessions();
        const uid=ev.source?.userId||"";
        sessions[uid]={await:"otherName"}; writeSessions(sessions);
        await client.replyMessage(ev.replyToken,{type:"text",text:"その他の商品名を入力してください。"});
        return;
      }

      if(d.startsWith("order_qty?")){
        const {id,qty}=parse(d.replace("order_qty?",""));
        await client.replyMessage(ev.replyToken, qtyFlex(id,qty));
        return;
      }
      if(d.startsWith("order_method?")){
        const {id,qty}=parse(d.replace("order_method?",""));
        await client.replyMessage(ev.replyToken, methodFlex(id,qty));
        return;
      }
      if(d.startsWith("order_region?")){
        const {id,qty,method}=parse(d.replace("order_region?",""));
        if(method==="delivery") await client.replyMessage(ev.replyToken, regionFlex(id,qty));
        else await client.replyMessage(ev.replyToken, paymentFlex(id,qty,"pickup",""));
        return;
      }
      if(d.startsWith("order_payment?")){
        let {id,qty,method,region}=parse(d.replace("order_payment?",""));
        method=(method||"").trim(); region=(region||"").trim();
        if(region==="-" ) region="";
        if(method==="pickup"){ await client.replyMessage(ev.replyToken, paymentFlex(id,qty,"pickup","")); return; }
        if(method==="delivery"){
          if(!region){ await client.replyMessage(ev.replyToken, regionFlex(id,qty)); return; }
          await client.replyMessage(ev.replyToken, paymentFlex(id,qty,"delivery",region)); return;
        }
        await client.replyMessage(ev.replyToken, methodFlex(id,qty)); return;
      }

      if(d.startsWith("order_confirm_view?")){
        const {id,qty,method,region,payment}=parse(d.replace("order_confirm_view?",""));
        let product;
        if(String(id).startsWith("other:")){
          const parts=String(id).split(":");
          product={ id, name:decodeURIComponent(parts[1]||"その他"), price:Number(parts[2]||0) };
        }else{
          const products=readProducts();
          product=products.find(p=>p.id===id);
          if(!product){
            await client.replyMessage(ev.replyToken,{type:"text",text:"商品が見つかりませんでした。"});
            return;
          }
        }
        // ★ 直接注文の住所ボタンは DIRECT LIFF を使う
        await client.replyMessage(ev.replyToken, confirmFlex(product, qty, method, region, payment, LIFF_ID_DIRECT));
        return;
      }

      if(d==="order_back"){
        await client.replyMessage(ev.replyToken, productsFlex(readProducts()));
        return;
      }

      if(d.startsWith("order_confirm?")){
        const {id,qty,method,region,payment}=parse(d.replace("order_confirm?",""));
        const need=Math.max(1,Number(qty)||1);

        let product=null;
        let products=readProducts();
        let idx=products.findIndex(p=>p.id===id);

        if(String(id).startsWith("other:")){
          const parts=String(id).split(":");
          product={ id, name:decodeURIComponent(parts[1]||"その他"), price:Number(parts[2]||0), stock:Infinity };
          idx=-1;
        }else{
          if(idx===-1){
            await client.replyMessage(ev.replyToken,{type:"text",text:"商品が見つかりませんでした。"});
            return;
          }
          product=products[idx];
          if(!product.stock || product.stock<need){
            await client.replyMessage(ev.replyToken, reserveOffer(product, need, product.stock||0));
            return;
          }
          products[idx].stock=Number(product.stock)-need;
          writeProducts(products);
          await maybeLowStockAlert(product.id, product.name, products[idx].stock);
        }

        const regionFee = method==="delivery" ? (SHIPPING_BY_REGION[region]||0) : 0;
        const codFee = payment==="cod" ? COD_FEE : 0;
        const subtotal = Number(product.price)*need;
        const total = subtotal+regionFee+codFee;

        const addrBook=readAddresses();
        const addr=addrBook[ev.source?.userId||""]||null;

        const order={
          ts:new Date().toISOString(),
          userId:ev.source?.userId||"",
          productId:product.id,
          productName:product.name,
          qty:need,
          price:Number(product.price),
          subtotal,
          region,
          shipping:regionFee,
          payment,
          codFee,
          total,
          method,
          address:addr,
          image:product.image||"",
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order)+"\n");

        const payText = payment==="cod" ? `代金引換（+${yen(COD_FEE)}）` : payment==="bank" ? "銀行振込" : "現金（店頭）";

        const userLines=[
          "ご注文ありがとうございます！",
          `受取方法：${method==="pickup"?"店頭受取（送料0円）":`宅配（${region}）`}`,
          `支払い：${payText}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)}`,
          `送料：${yen(regionFee)}`,
          `代引き手数料：${yen(codFee)}`,
          `合計：${yen(total)}`,
        ];

        if(method==="delivery"){
          userLines.push("");
          userLines.push(
            addr
              ? `お届け先：${addr.postal||""} ${addr.prefecture||""}${addr.city||""}${addr.address1||""}${addr.address2?(" "+addr.address2):""}\n氏名：${addr.name||""}\n電話：${addr.phone||""}`
              : "住所未登録です。メニューの「住所を入力（LIFF）」から登録してください。"
          );
        }else{
          userLines.push("", "店頭でのお受け取りをお待ちしています。");
        }

        await client.replyMessage(ev.replyToken,{type:"text",text:userLines.join("\n")});

        if(method==="delivery" && payment==="bank"){
          const lines=[];
          lines.push("▼ 振込先");
          lines.push(BANK_INFO || "（銀行口座情報が未設定です。管理者に連絡してください。）");
          if(BANK_NOTE){ lines.push("", BANK_NOTE); }
          lines.push("", "※ご入金確認後の発送となります。");
          try{ await client.pushMessage(ev.source.userId,{type:"text",text:lines.join("\n")}); }catch{}
        }

        return;
      }

      if(d.startsWith("order_reserve?")){
        const {id,qty}=parse(d.replace("order_reserve?",""));
        const products=readProducts();
        const product=products.find(p=>p.id===id);
        if(!product){
          await client.replyMessage(ev.replyToken,{type:"text",text:"商品が見つかりませんでした。"});
          return;
        }
        const r={ ts:new Date().toISOString(), userId:ev.source?.userId||"", productId:product.id, productName:product.name, qty:Math.max(1,Number(qty)||1), status:"reserved" };
        fs.appendFileSync(RESERVATIONS_LOG, JSON.stringify(r)+"\n");

        await client.replyMessage(ev.replyToken,{type:"text",text:`予約を受け付けました。入荷次第ご案内します。\n商品：${product.name}\n数量：${r.qty}個`});
        return;
      }
    }
  }catch(err){
    console.error("handleEvent error:", err);
    if(ev.replyToken){
      try{ await client.replyMessage(ev.replyToken,{type:"text",text:"エラーが発生しました。もう一度お試しください。"}); }catch{}
    }
  }
}

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log("   ONLINE LIFF endpoint : /public/products.html");
  console.log("   DIRECT LIFF endpoint : /public/liff-address-direct.html");
});
