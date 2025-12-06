"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

// ==== fetch( ) 対応（LINE通知用） ======================================

let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // node-fetch が入っていない場合もあるので try/catch
    // インストール済みならこちらが使われる
    fetchFn = require("node-fetch");
  } catch (e) {
    console.warn(
      "[WARN] fetch がグローバルにも node-fetch にも見つかりません。" +
        "LINEへの通知はスキップされます。"
    );
  }
}

// ==== パス・ファイル ====================================================

const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const COD_LOG = path.join(DATA_DIR, "cod-phone-orders.log");
const CUSTOMERS_PATH = path.join(DATA_DIR, "cod-customers.json");

// data ディレクトリを必ず作成
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ==== 共通ユーティリティ ================================================

function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function readProducts() {
  return safeReadJSON(PRODUCTS_PATH, []);
}

/**
 * 会員データ
 * 形式:
 * {
 *   "1234": { name, phone, zip, address, lineUserId, ... },
 *   "5678": { ... }
 * }
 */
function readCustomers() {
  return safeReadJSON(CUSTOMERS_PATH, {});
}

/**
 * lineUserId から会員情報を検索
 * 戻り値: { code, customer } or null
 */
function findCustomerByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  const customers = readCustomers();
  for (const code of Object.keys(customers)) {
    const c = customers[code];
    if (c && c.lineUserId && c.lineUserId === lineUserId) {
      return { code, customer: c };
    }
  }
  return null;
}

// ==== 環境変数 =========================================================

const PORT = process.env.PORT || 3000;

// LINE 通知用
const LINE_CHANNEL_ACCESS_TOKEN =
  (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const LINE_ADMIN_USER_ID = (process.env.LINE_ADMIN_USER_ID || "").trim();

// ==== 送料 & 代引き手数料 ==============================================

const SHIPPING_BY_REGION = {
  北海道: 1560,
  東北: 1070,
  関東: 960,
  中部: 960,
  近畿: 960,
  中国: 1070,
  四国: 1180,
  九州: 1190,
  沖縄: 1840,
};

// 代引き手数料：固定 330円
const COD_FEE = 330;

/**
 * 住所文字列から送料地域を判定
 */
function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.addr1 || address.address1 || "").trim();
  const hay = pref + addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if (/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿)/.test(hay)) return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if (/(沖縄)/.test(hay)) return "沖縄";

  return "";
}

// ==== 通話ごとのメモリ ================================================

// 例: DTMF_ORDERS[callSid] = {
//   items: [ { productId, name, price, qty }, ... ],
//   memberCode: "1234",
//   customer: { name, phone, zip, address, lineUserId },
//   addr: { region, shipping },
// }
const DTMF_ORDERS = {};

// ==== LINE 管理者への通知関数（注文）===================================

async function notifyLineAdminForCodOrder(payload) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_ADMIN_USER_ID) {
    console.warn(
      "[COD/LINE] LINE_CHANNEL_ACCESS_TOKEN または LINE_ADMIN_USER_ID が未設定のため、注文通知をスキップします。"
    );
    return;
  }
  if (!fetchFn) {
    console.warn(
      "[COD/LINE] fetch が未定義のため、注文通知をスキップします。"
    );
    return;
  }

  try {
    const {
      ts,
      callSid,
      items = [],
      addr,
      customer,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      memberCode,
    } = payload;

    const when = ts || new Date().toISOString();

    const fullAddress = customer?.address || "（未登録）";
    const nameText = customer?.name || "（未登録）";
    const phoneText = customer?.phone || "（未登録）";
    const regionText = addr?.region || "（不明）";

    const itemsLines = items.length
      ? items
          .map((it) => {
            const lineTotal = (it.price || 0) * (it.qty || 0);
            return `・${it.name || "商品"} x ${it.qty || 0}個 = ${lineTotal}円`;
          })
          .join("\n")
      : "（商品情報がありません）";

    const memberLine = memberCode ? `会員番号: ${memberCode}\n` : "";

    const message =
      `【電話代引き 新規注文】\n` +
      `日時: ${when}\n` +
      `CallSid: ${callSid || "（なし）"}\n` +
      memberLine +
      `\n` +
      `▼ご注文商品\n${itemsLines}\n\n` +
      `商品小計: ${itemsTotal}円\n` +
      `送料: ${shipping}円（地域: ${regionText}）\n` +
      `代引き手数料: ${codFee}円\n` +
      `合計金額: ${finalTotal}円\n\n` +
      `▼お客様情報\n` +
      `お名前: ${nameText}\n` +
      `住所: ${fullAddress}\n` +
      `電話番号: ${phoneText}\n\n` +
      `※この注文は Twilio 電話受付（代引き専用・会員番号方式）からです。`;

    const resp = await fetchFn("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: LINE_ADMIN_USER_ID,
        messages: [
          {
            type: "text",
            text: message.slice(0, 2000),
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        "[COD/LINE] push(order) error:",
        resp.status,
        resp.statusText,
        text
      );
    } else {
      console.log("[COD/LINE] 管理者へ注文通知を送信しました。");
    }
  } catch (e) {
    console.error("[COD/LINE] notify(order) error:", e);
  }
}

// ==== LINE 管理者への通知関数（住所登録）===============================

async function notifyLineAdminForCustomerRegister(payload) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_ADMIN_USER_ID) {
    console.warn(
      "[COD/LINE] LINE_CHANNEL_ACCESS_TOKEN または LINE_ADMIN_USER_ID が未設定のため、住所登録通知をスキップします。"
    );
    return;
  }
  if (!fetchFn) {
    console.warn(
      "[COD/LINE] fetch が未定義のため、住所登録通知をスキップします。"
    );
    return;
  }

  try {
    const { ts, code, name, phone, zip, address, isUpdate, lineUserId } =
      payload;
    const when = ts || new Date().toISOString();

    const mode = isUpdate
      ? "【電話代引き 住所登録（更新）】"
      : "【電話代引き 住所登録（新規）】";

    const message =
      `${mode}\n` +
      `日時: ${when}\n\n` +
      `会員番号: ${code}\n` +
      `お名前: ${name}\n` +
      `電話番号: ${phone || "（未入力）"}\n` +
      `郵便番号: ${zip || "（未入力）"}\n` +
      `住所: ${address}\n` +
      `LINEユーザーID: ${lineUserId || "（未連携）"}\n\n` +
      `※この登録は cod-register.html / LIFF から行われました。`;

    const resp = await fetchFn("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        to: LINE_ADMIN_USER_ID,
        messages: [
          {
            type: "text",
            text: message.slice(0, 2000),
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        "[COD/LINE] push(customer) error:",
        resp.status,
        resp.statusText,
        text
      );
    } else {
      console.log("[COD/LINE] 管理者へ住所登録通知を送信しました。");
    }
  } catch (e) {
    console.error("[COD/LINE] notify(customer) error:", e);
  }
}

// ==== Express アプリ ===================================================

const app = express();
const urlencoded = express.urlencoded({ extended: false });
const jsonParser = express.json();

// ---- CORS（LIFF / 別ドメイン からのアクセス許可） --------------------

app.use((req, res, next) => {
  // 必要なら特定ドメインだけに絞る: "https://line-render-app-1.onrender.com" など
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    // Preflight
    return res.sendStatus(200);
  }
  next();
});

// 静的ファイル（/public 以下の HTML など）を配信
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use("/public", express.static(PUBLIC_DIR));
}

// ======================================================================
// 0) 会員情報 登録用 API（住所入力の別画面 / LIFF から使う）
// ======================================================================
//
// POST /api/cod/customers
// body: { code, name, phone, zip, address, lineUserId }
//
// - code: 4〜8桁の数字
// - すでに同じ code が存在する場合はエラー（重複チェック）
//   → { ok:false, error:"...", code:"DUPLICATE_CODE" }
//
// GET /api/cod/customers/:code
// - 登録内容の確認用
//
// GET /api/cod/customers/by-line/:lineUserId
// GET /api/cod/customers/by-line?lineUserId=xxxxx
// - LINEユーザーID から会員番号を逆引き
app.post("/api/cod/customers", jsonParser, async (req, res) => {
  try {
    const { code, name, phone, zip, address, lineUserId } = req.body || {};

    // ---- 入力チェック ------------------------------------
    const codeStr = String(code || "").trim();
    if (!codeStr || !/^\d{4,8}$/.test(codeStr)) {
      return res
        .status(400)
        .json({ ok: false, error: "code(会員番号) は4〜8桁の数字で入力してください。" });
    }

    if (!name || !String(name).trim()) {
      return res
        .status(400)
        .json({ ok: false, error: "name(お名前) が未入力です。" });
    }

    if (!address || !String(address).trim()) {
      return res
        .status(400)
        .json({ ok: false, error: "address(ご住所) が未入力です。" });
    }

    const phoneStr = phone ? String(phone).replace(/-/g, "").trim() : "";
    if (phoneStr && !/^\d{9,11}$/.test(phoneStr)) {
      return res.status(400).json({
        ok: false,
        error: "phone(電話番号) は9〜11桁の数字で入力してください。",
      });
    }

    const zipStr = zip ? String(zip).replace(/-/g, "").trim() : "";
    const lineUserIdStr = lineUserId ? String(lineUserId).trim() : "";

    // ---- 重複チェック ------------------------------------
    const customers = readCustomers();
    if (customers[codeStr]) {
      return res.status(400).json({
        ok: false,
        error: "この会員番号はすでに登録されています。",
        code: "DUPLICATE_CODE",
      });
    }

    // ---- 保存 --------------------------------------------
    const now = new Date().toISOString();

    customers[codeStr] = {
      name: String(name).trim(),
      phone: phoneStr,
      zip: zipStr,
      address: String(address).trim(),
      lineUserId: lineUserIdStr,  // ★ LINEユーザーID を紐付け
      updatedAt: now,
      createdAt: now,
    };

    writeJSON(CUSTOMERS_PATH, customers);

    // 管理者へ LINE 通知（新規登録）
    await notifyLineAdminForCustomerRegister({
      ts: now,
      code: codeStr,
      name: String(name).trim(),
      phone: phoneStr,
      zip: zipStr,
      address: String(address).trim(),
      lineUserId: lineUserIdStr,
      isUpdate: false,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/cod/customers error:", e);
    return res.status(500).json({ ok: false, error: "internal error" });
  }
});

app.get("/api/cod/customers/:code", (req, res) => {
  const code = (req.params.code || "").trim();
  if (!code) {
    return res.status(400).json({ ok: false, error: "code is required" });
  }

  const customers = readCustomers();
  const c = customers[code];
  if (!c) {
    return res.status(404).json({ ok: false, error: "not found" });
  }

  return res.json({ ok: true, customer: c });
});
// lineUserId から登録済み会員を探す API
// GET /api/cod/customers/lookup-by-line?lineUserId=xxxxx
app.get("/api/cod/customers/lookup-by-line", (req, res) => {
  const lineUserId = (req.query.lineUserId || "").trim();
  if (!lineUserId) {
    return res.status(400).json({ ok: false, error: "lineUserId is required" });
  }

  const customers = readCustomers();

  let foundCode = null;
  let foundCustomer = null;

  for (const [code, c] of Object.entries(customers)) {
    if (c.lineUserId && c.lineUserId === lineUserId) {
      foundCode = code;
      foundCustomer = c;
      break;
    }
  }

  if (!foundCustomer) {
    return res.status(404).json({ ok: false, error: "not found" });
  }

  return res.json({
    ok: true,
    code: foundCode,
    customer: foundCustomer,
  });
});

app.get("/api/cod/customers/by-line/:lineUserId", (req, res) => {
  const lineUserId = (req.params.lineUserId || "").trim();
  if (!lineUserId) {
    return res
      .status(400)
      .json({ ok: false, error: "lineUserId is required" });
  }

  const found = findCustomerByLineUserId(lineUserId);
  if (!found) {
    return res.status(404).json({ ok: false, error: "not found" });
  }

  return res.json({
    ok: true,
    code: found.code,
    customer: found.customer,
  });
});

// クエリ版 (?lineUserId=xxxxx) も許可しておく
app.get("/api/cod/customers/by-line", (req, res) => {
  const lineUserId = (req.query.lineUserId || "").trim();
  if (!lineUserId) {
    return res
      .status(400)
      .json({ ok: false, error: "lineUserId is required" });
  }

  const found = findCustomerByLineUserId(lineUserId);
  if (!found) {
    return res.status(404).json({ ok: false, error: "not found" });
  }

  return res.json({
    ok: true,
    code: found.code,
    customer: found.customer,
  });
});

// ======================================================================
// 1) エントリーポイント /twilio/cod
// ======================================================================

app.all("/twilio/cod", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";

  DTMF_ORDERS[callSid] = {
    items: [],
  };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。 こちらは、ボタン操作による代金引換ご注文専用の自動受付です。
  </Say>
  <Say language="ja-JP" voice="alice">
    まず、商品と個数をボタンでご指定いただきます。 そのあとに、事前にご登録いただいた会員番号をボタンでご入力いただき、 ご登録済みのご住所とお電話番号にお届けいたします。 商品代金に送料と代引き手数料を加えた合計金額を、最後にご案内いたします。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 2) 商品選択
// ======================================================================

app.post("/twilio/cod/product", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  const products = readProducts();
  const menu = products.slice(0, 9);

  if (menu.length === 0) {
    const twimlNoProducts = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    申し訳ございません。 現在、ご案内できる商品がございません。 恐れ入りますが、また時間をおいておかけ直しください。
  </Say>
  <Hangup/>
</Response>`;
    return res.type("text/xml").send(twimlNoProducts);
  }

  order.productMenu = menu.map((p, idx) => ({
    digit: String(idx + 1),
    id: p.id,
    name: p.name,
  }));
  DTMF_ORDERS[callSid] = order;

  const menuText = order.productMenu
    .map((m) => `${m.name}は${m.digit}を`)
    .join("、 ");

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod/product-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      ご希望の商品をお選びください。 ${menuText} 押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

app.post("/twilio/cod/product-handler", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digit = (req.body.Digits || "").trim();

  const order = DTMF_ORDERS[callSid] || { items: [] };
  const menu = order.productMenu || [];
  const opt = menu.find((o) => o.digit === digit);

  if (!opt) {
    const menuText = menu.length
      ? menu.map((m) => `${m.name}は${m.digit}を`).join("、 ")
      : "商品をお選びください。";

    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。 ${menuText} 押してください。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlError);
  }

  order.currentProductId = opt.id;
  order.currentProductName = opt.name;
  DTMF_ORDERS[callSid] = order;

  const label = opt.name || "ご希望の商品";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="2" action="/twilio/cod/qty" method="POST">
    <Say language="ja-JP" voice="alice">
      ${label}の個数を押してください。 1から99までの数字でご入力いただけます。 入力後、シャープは不要です。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 3) 個数入力 → 追加注文の有無
// ======================================================================

app.post("/twilio/cod/qty", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digits = (req.body.Digits || "").trim();

  const qty = parseInt(digits, 10);
  if (!qty || qty <= 0) {
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    個数の入力が正しくありません。 1から99までの数字でご入力ください。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlError);
  }

  const order = DTMF_ORDERS[callSid] || { items: [] };
  const productId = order.currentProductId;
  const productNameFromMenu = order.currentProductName;

  if (!productId) {
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    商品の選択情報が見つかりませんでした。 恐れ入りますが、最初からお試しください。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
    DTMF_ORDERS[callSid] = { items: [] };
    return res.type("text/xml").send(twimlError);
  }

  const products = readProducts();
  const p = products.find((x) => x.id === productId);
  const name = (p && p.name) || productNameFromMenu || "ご指定の商品";
  const price = Number((p && p.price) || 0);

  order.items.push({
    productId,
    name,
    price,
    qty,
  });
  delete order.currentProductId;
  delete order.currentProductName;
  DTMF_ORDERS[callSid] = order;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。 ${name}を${qty}個でお預かりしました。
  </Say>
  <Gather numDigits="1" action="/twilio/cod/more" method="POST">
    <Say language="ja-JP" voice="alice">
      他にご注文はございますか。 さらにご注文がある場合は1を、 以上でよろしければ2を押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 4) 追加注文の有無 → 2なら会員番号入力へ
// ======================================================================

app.post("/twilio/cod/more", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digit = (req.body.Digits || "").trim();

  let twiml;

  if (digit === "1") {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    では、追加のご注文をお伺いします。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
  } else if (digit === "2") {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/twilio/cod/member</Redirect>
</Response>`;
  } else {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。 さらにご注文がある場合は1を、 以上でよろしければ2を押してください。
  </Say>
  <Redirect method="POST">/twilio/cod/more-retry</Redirect>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});

app.post("/twilio/cod/more-retry", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod/more" method="POST">
    <Say language="ja-JP" voice="alice">
      さらにご注文がある場合は1を、 以上でよろしければ2を押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ======================================================================
// 5) 会員番号入力（DTMF）→ 会員情報の読込 & 送料計算
// ======================================================================

app.post("/twilio/cod/member", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="8" action="/twilio/cod/member-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      事前にご登録いただいた会員番号を、 4桁から8桁の数字で押してください。 入力後、シャープは不要です。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/twilio/cod/member-handler", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digits = (req.body.Digits || "").trim();

  if (!digits || digits.length < 4 || digits.length > 8 || !/^\d+$/.test(digits)) {
    const twimlErr = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    会員番号の入力が確認できませんでした。 4桁から8桁の数字でご入力ください。
  </Say>
  <Redirect method="POST">/twilio/cod/member</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlErr);
  }

  const customers = readCustomers();
  const customer = customers[digits];

  if (!customer) {
    const twimlNotFound = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力いただいた会員番号に対応するご登録情報が見つかりませんでした。 番号をお確かめのうえ、もう一度ご入力いただくか、 恐れ入りますが、別の方法でご注文をお願いいたします。
  </Say>
  <Redirect method="POST">/twilio/cod/member-retry</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlNotFound);
  }

  const order = DTMF_ORDERS[callSid] || { items: [] };

  order.memberCode = digits;
  order.customer = {
    name: customer.name || "",
    phone: customer.phone || "",
    zip: customer.zip || "",
    address: customer.address || "",
    lineUserId: customer.lineUserId || "",
  };

  // 送料計算（住所文字列から地域判定）
  const fullAddr = order.customer.address || "";
  let region = "";
  let shipping = 0;
  try {
    region = detectRegionFromAddress({
      prefecture: fullAddr,
      address1: fullAddr,
    });
    if (region) {
      shipping = SHIPPING_BY_REGION[region] || 0;
    }
  } catch (e) {
    console.error("detectRegionFromAddress error:", e);
  }

  order.addr = {
    region,
    shipping,
  };

  DTMF_ORDERS[callSid] = order;

  const confirmName = order.customer.name || "お客様";
  const twimlOk = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。 会員番号、${digits}番、 ${confirmName}様のご登録情報で承ります。 このあと、 ご注文内容と合計金額を確認いたしますので、 そのままお待ちください。
  </Say>
  <Redirect method="POST">/twilio/cod/summary</Redirect>
</Response>`;

  return res.type("text/xml").send(twimlOk);
});

app.post("/twilio/cod/member-retry", urlencoded, (req, res) => {
  const twimlRetry = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="8" action="/twilio/cod/member-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      もう一度、会員番号を、 4桁から8桁の数字で押してください。 入力後、シャープは不要です。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できなかったため、 通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  res.type("text/xml").send(twimlRetry);
});

// ======================================================================
// 6) 合計金額の読み上げ → ログ保存＋LINE通知 → 終了
// ======================================================================

app.post("/twilio/cod/summary", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  const customer = order.customer || {
    name: "",
    phone: "",
    zip: "",
    address: "",
    lineUserId: "",
  };

  let itemsText = "";
  let itemsTotal = 0;

  if (!order.items || order.items.length === 0) {
    itemsText = "ご注文内容が確認できませんでした。";
  } else {
    const partsText = order.items.map((item) => {
      const lineTotal = item.price * item.qty;
      itemsTotal += lineTotal;
      return `${item.name}を${item.qty}個`;
    });
    itemsText = partsText.join("、") + "で承りました。";
  }

  let shipping = 0;
  let shippingText = "送料は0円として計算いたします。";

  if (order.addr && order.addr.shipping != null) {
    shipping = Number(order.addr.shipping || 0);
    if (order.addr.region) {
      shippingText = `送料は${order.addr.region}地域の${shipping}円です。`;
    } else {
      shippingText = `送料は${shipping}円です。`;
    }
  }

  const codFee = COD_FEE;
  const finalTotal = itemsTotal + shipping + codFee;

  const nameAddrText =
    customer.name || customer.address
      ? ` お名前とご住所は、「${[customer.name || "", customer.address || ""]
          .filter(Boolean)
          .join("、")}」のご登録情報で承ります。`
      : "";

  const phoneText = customer.phone
    ? ` ご連絡先のお電話番号は、「${customer.phone}」のご登録で承ります。`
    : "";

  const summaryText =
    itemsText +
    nameAddrText +
    phoneText +
    ` 商品代金の合計は税込みで${itemsTotal}円です。 ` +
    `${shippingText} 代引き手数料は${codFee}円です。 ` +
    `商品代金、送料、代引き手数料を合わせたお支払い合計金額は、${finalTotal}円になります。`;

  const logPayload = {
    ts: new Date().toISOString(),
    callSid,
    items: order.items,
    addr: order.addr || null,
    customer,
    memberCode: order.memberCode || null,
    itemsTotal,
    shipping,
    codFee,
    finalTotal,
  };

  // ログファイルに1行追記
  try {
    fs.appendFileSync(COD_LOG, JSON.stringify(logPayload) + "\n", "utf8");
  } catch (e) {
    console.error("cod log write error:", e);
  }

  // 管理者へ LINE 通知
  await notifyLineAdminForCodOrder(logPayload);

  // メモリから削除
  delete DTMF_ORDERS[callSid];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${summaryText}
  </Say>
  <Say language="ja-JP" voice="alice">
    ご注文ありがとうございます。 それでは、失礼いたします。
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// Health check / root
// ======================================================================

app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/plain")
    .send("phone-cod server ok. Twilio entry: POST /twilio/cod");
});

app.get("/health", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);
app.get("/healthz", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    env: {
      LINE_CHANNEL_ACCESS_TOKEN: !!LINE_CHANNEL_ACCESS_TOKEN,
      LINE_ADMIN_USER_ID: !!LINE_ADMIN_USER_ID,
    },
  });
});

// ======================================================================
// 起動
// ======================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📦 COD phone member server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/cod");
  console.log(
    "   LINE notify:",
    LINE_CHANNEL_ACCESS_TOKEN ? "token OK" : "token MISSING",
    LINE_ADMIN_USER_ID ? "admin OK" : "admin MISSING"
  );
});
