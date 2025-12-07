// server-phone-cod.js
// Twilio 代引き専用サーバー（電話注文）
// - Twilio からの着信 => /twilio/cod/entry
// - products.json から商品を読み上げ
// - 個数をプッシュ入力
// - 合計金額を読み上げて注文確定
// - data/orders-phone-cod.log に保存
// - ADMIN_USER_ID に LINE で通知
// - 電話用 LIFF 住所登録（cod-register.html）用の /api/liff/config?kind=cod も提供

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;

// LINE 通知用
const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const LINE_CHANNEL_SECRET      = (process.env.LINE_CHANNEL_SECRET || "").trim();
const ADMIN_USER_ID            = (process.env.ADMIN_USER_ID || "").trim();

// LIFF（電話用住所登録）
const LIFF_ID_COD_REGISTER = (process.env.LIFF_ID_COD_REGISTER || "").trim();

// 公開URL（ログなどで使うだけ）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

// LINE クライアント
let lineClient = null;
if (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET) {
  lineClient = new line.Client({
    channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: LINE_CHANNEL_SECRET,
  });
} else {
  console.warn("⚠️ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が設定されていないため、LINE通知は行われません。");
}

// ====== データパス ======
const ROOT_DIR   = __dirname;
const DATA_DIR   = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

if (!fs.existsSync(DATA_DIR))   fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const PRODUCTS_PATH       = path.join(DATA_DIR, "products.json");
const PHONE_ORDERS_LOG    = path.join(DATA_DIR, "orders-phone-cod.log");
const PHONE_SESSIONS_PATH = path.join(DATA_DIR, "phone-sessions.json");

// ====== ユーティリティ ======
function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function readProducts() {
  // products.json が無ければ簡易サンプルを作成
  if (!fs.existsSync(PRODUCTS_PATH)) {
    const sample = [
      { id: "kusuke-250",       name: "久助（えびせん）", price: 250, stock: 100 },
      { id: "nori-square-300",  name: "四角のりせん",     price: 300, stock: 100 },
      { id: "premium-ebi-400",  name: "プレミアムえびせん", price: 400, stock: 50 },
    ];
    fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
    console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
  }
  return safeReadJSON(PRODUCTS_PATH, []);
}

function readPhoneSessions() {
  return safeReadJSON(PHONE_SESSIONS_PATH, {});
}
function writePhoneSessions(s) {
  fs.writeFileSync(PHONE_SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");
}

function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}

// Twilio の body をログに出す（デバッグ用）
function logTwilioRequest(label, req) {
  console.log(`==== [Twilio] ${label} ====`);
  console.log("Query:", req.query);
  console.log("Body :", req.body);
  console.log("==== end ====");
}

// ====== COD 用の商品一覧 ======
// products.json から 1,2,3... のメニューを自動生成
function buildCodProducts() {
  const products = readProducts();
  const list = [];
  let digit = 1;

  for (const p of products) {
    if (!p || typeof p.price !== "number") continue;
    if (digit > 9) break; // 1桁の DTMF なので 9 まで

    list.push({
      digit: String(digit),  // "1", "2", ...
      id: p.id,
      name: p.name || p.id,
      price: p.price,
    });
    digit++;
  }

  if (!list.length) {
    // 何も無い場合の保険
    list.push({ digit: "1", id: "kusuke-250", name: "久助（えびせん）", price: 250 });
  }

  return list;
}

// メニューを音声用テキストにする
function buildMenuVoiceText(codProducts) {
  // 例：「久助は1を、四角のりせんは2を、プレミアムえびせんは3を押してください。」
  const parts = codProducts.map((p) => `${p.name} は ${p.digit} を`);
  return parts.join("、") + " 押してください。";
}

// ====== ミドルウェア ======
app.use(express.urlencoded({ extended: false })); // Twilio は x-www-form-urlencoded
app.use(express.json());
app.use("/public", express.static(PUBLIC_DIR));

// ====== Health ======
app.get("/", (_req, res) => res.status(200).send("OK (phone-cod)"));
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));

// ====== LIFF config（電話用住所登録 cod-register.html から利用） ======
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "").trim(); // kind=cod など

  if (kind === "cod") {
    return res.json({ liffId: LIFF_ID_COD_REGISTER || "" });
  }

  // 汎用用に一応返しておく（空のままでもOK）
  return res.json({ liffId: LIFF_ID_COD_REGISTER || "" });
});

// ====== Twilio 音声 IVR フロー ======

// 入口：ここを Twilio の「A call comes in」の URL に設定する
// 例: https://server-phone-cod-js.onrender.com/twilio/cod/entry  (POST)
app.post("/twilio/cod/entry", (req, res) => {
  logTwilioRequest("ENTRY", req);

  const COD_PRODUCTS = buildCodProducts();
  const menuVoice = buildMenuVoiceText(COD_PRODUCTS);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。
    手造りえびせんべい、磯屋です。
    こちらは、代金引換ご希望のお客さま専用の自動受付です。
  </Say>

  <Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/product" method="POST">
    <Say language="ja-JP" voice="alice">
      ご希望の商品をお選びください。
      ${menuVoice}
    </Say>
  </Gather>

  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。
    お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml");
  res.send(xml);
});

// 商品選択後：Digits=1,2,3... が送られてくる
app.post("/twilio/cod/product", (req, res) => {
  logTwilioRequest("PRODUCT", req);

  const COD_PRODUCTS = buildCodProducts();
  const digit = (req.body.Digits || "").trim();
  const callSid = (req.body.CallSid || "").trim();

  const product = COD_PRODUCTS.find((p) => p.digit === digit);

  if (!product) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。
    もう一度やり直してください。
  </Say>
  <Redirect method="POST">/twilio/cod/entry</Redirect>
</Response>`;
    res.type("text/xml");
    res.send(xml);
    return;
  }

  // セッションに商品を書いておく
  const sessions = readPhoneSessions();
  sessions[callSid] = {
    ...(sessions[callSid] || {}),
    productId: product.id,
    productName: product.name,
    unitPrice: product.price,
  };
  writePhoneSessions(sessions);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="2" timeout="10" action="/twilio/cod/qty" method="POST">
    <Say language="ja-JP" voice="alice">
      ${product.name} をお選びいただきました。
      個数を、2桁までの半角数字で入力してください。
      例えば、2個なら 0 2、10個なら 1 0 のように押してください。
    </Say>
  </Gather>

  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。
    お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml");
  res.send(xml);
});

// 個数入力後
app.post("/twilio/cod/qty", (req, res) => {
  logTwilioRequest("QTY", req);

  const callSid = (req.body.CallSid || "").trim();
  const digits  = (req.body.Digits || "").replace(/^0+/, ""); // 先頭ゼロ除去

  let qty = Number(digits || "0");
  if (!qty || qty < 1) qty = 1;
  if (qty > 99) qty = 99;

  const sessions = readPhoneSessions();
  const sess = sessions[callSid] || {};

  if (!sess.productId || !sess.unitPrice) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    商品情報の取得に失敗しました。
    お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`;
    res.type("text/xml");
    res.send(xml);
    return;
  }

  sess.qty = qty;
  sess.ts  = new Date().toISOString();
  sessions[callSid] = sess;
  writePhoneSessions(sessions);

  const subtotal = sess.unitPrice * qty;

  // ここでは送料・代引き手数料は固定 or 後から連絡前提にしておく
  const shipping = 0;
  const codFee   = 0;
  const total    = subtotal + shipping + codFee;

  const fromNumber = (req.body.From || "").trim();
  const toNumber   = (req.body.To   || "").trim();

  // ログに保存
  const orderRecord = {
    ts: sess.ts,
    callSid,
    from: fromNumber,
    to: toNumber,
    productId: sess.productId,
    productName: sess.productName,
    unitPrice: sess.unitPrice,
    qty,
    subtotal,
    shipping,
    codFee,
    total,
    via: "phone-cod",
  };
  try {
    fs.appendFileSync(PHONE_ORDERS_LOG, JSON.stringify(orderRecord) + "\n", "utf8");
    console.log("📦 phone-cod order logged:", orderRecord);
  } catch (e) {
    console.error("phone-cod orders log error:", e);
  }

  // 管理者に LINE 通知
  if (lineClient && ADMIN_USER_ID) {
    const msg =
      "🧾【電話 代引き注文】\n" +
      `発信：${fromNumber}\n` +
      `商品：${sess.productName}\n` +
      `数量：${qty}個\n` +
      `小計：${yen(subtotal)}\n` +
      (shipping ? `送料：${yen(shipping)}\n` : "") +
      (codFee   ? `代引き手数料：${yen(codFee)}\n` : "") +
      `合計：${yen(total)}\n` +
      (PUBLIC_BASE_URL
        ? `\nログ: ${PUBLIC_BASE_URL}/data/orders-phone-cod.log`
        : "");

    lineClient
      .pushMessage(ADMIN_USER_ID, { type: "text", text: msg })
      .then(() => console.log("📨 admin notified by LINE"))
      .catch((e) => console.error("admin notify error:", e?.response?.data || e));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。
    ${sess.productName} を、${qty}個で承りました。
    合計金額は、${total}円 です。
    詳しいお届け先などは、後ほどスタッフより確認のお電話を差し上げます。
  </Say>
  <Say language="ja-JP" voice="alice">
    ご注文ありがとうございました。
    それでは、失礼いたします。
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml");
  res.send(xml);
});

// ====== 住所登録 LIFF を電話と組み合わせたい場合のメモ ======
// ・電話終了後に SMS やチラシから QR コードで cod-register.html を開いてもらい、
//   住所を登録 → 別サーバー または 同じサーバーの /api/liff/address へ保存、という構成がおすすめ。
// ・この server-phone-cod.js には、「/api/liff/config?kind=cod」で LIFF ID を返すところだけ実装しています。
//   実際の住所保存APIは、LINE連携サーバー側(server.js)の実装と揃えると管理しやすいです。

// ====== サーバー起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 server-phone-cod.js started on port ${PORT}`);
  console.log(`   Health: GET /health`);
  console.log(`   Twilio entry: POST /twilio/cod/entry`);
  console.log(`   LIFF config (電話用): GET /api/liff/config?kind=cod`);
});
