// server-phone-cod.js
// Twilio 代引き専用 自動受付サーバー（ハイブリッド版）
//
// ・商品〜個数〜追加注文〜郵便番号まではプッシュ式（DTMF）
// ・郵便番号から 都道府県 + 市区町村 + 町名 まで自動取得（zipcloud）
// ・商品名は data/products.json から読み込み（先頭9件をメニューに）
// ・「お名前」と「住所の続き（番地・建物名・部屋番号）」だけ OpenAI で丁寧な会話
// ・住所の続きは Google Maps Geocoding API で妥当性チェック
// ・連絡先電話番号はプッシュ式で入力
// ・最後に 商品代 + 送料 + 代引き手数料 の合計金額を確定金額として読み上げ
// ・注文確定時に LINE 管理者へ通知（プッシュ）

"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

// Node.js 18+ なら fetch はグローバルに存在
// 古いバージョンなら node-fetch 等を require してください。

// ==== パス・ファイル ====================================================

const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const COD_LOG = path.join(DATA_DIR, "cod-phone-orders.log");

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

function readProducts() {
  return safeReadJSON(PRODUCTS_PATH, []);
}

// ==== 環境変数 =========================================================

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PORT = process.env.PORT || 3000;

// LINE 通知用
const LINE_CHANNEL_ACCESS_TOKEN =
  (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const LINE_ADMIN_USER_ID = (process.env.LINE_ADMIN_USER_ID || "").trim();

// Google Maps Geocoding 用
const GOOGLE_MAPS_API_KEY = (process.env.GOOGLE_MAPS_API_KEY || "").trim();

// ==== 送料 & 代引き手数料 ==============================================

// server.js 側と同じテーブルを流用
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
 * 住所オブジェクトから送料地域を判定
 */
function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.addr1 || address.address1 || "").trim();
  const hay = pref || addr1;

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

// ==== 通話ごとのメモリ（DTMF + 名前住所 会話） ========================

// 例: DTMF_ORDERS[callSid] = {
//   items: [ { productId, name, price, qty }, ... ],
//   zip: "4780001",
//   addr: { zip, prefecture, city, town, region, shipping },
//   nameStage: "name" | "address" | "done",
//   nameSpeech: "...",
//   addressSpeech: "...",
//   phone: "09012345678",
//   productMenu: [ { digit, id, name }, ... ],
//   googleFormattedAddress: "..." // Google整形済み住所（任意）
// }
const DTMF_ORDERS = {};

// ==== 郵便番号 → 住所 変換 =============================================

/**
 * zipcloud API で 郵便番号→住所 を取得
 * @param {string} zip 例: "4780001"
 */
async function lookupAddressByZip(zip) {
  const z = (zip || "").replace(/\D/g, "");
  if (!z || z.length !== 7) return null;

  const url = `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${encodeURIComponent(
    z
  )}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 200 || !data.results || !data.results[0]) {
      return null;
    }

    const r = data.results[0];
    return {
      zip: z,
      prefecture: r.address1 || "",
      city: r.address2 || "",
      town: r.address3 || "",
    };
  } catch (e) {
    console.error("lookupAddressByZip error:", e);
    return null;
  }
}

// ==== OpenAI に 名前・住所 部分だけ丁寧会話させる関数 ==================

/**
 * 名前 or 住所フェーズで、丁寧な会話テキストを生成
 * @param {"name"|"address"} stage
 * @param {string} speechText Twilio の SpeechResult（お客さんが話した内容）
 * @param {object} order 通話中の注文情報（名前・住所テキストも含む）
 * @returns {Promise<string>} 音声で読み上げる日本語テキスト
 */
async function askOpenAIForNameAddress(stage, speechText, order) {
  if (!OPENAI_API_KEY) {
    // フォールバック：OpenAIキーがない場合はシンプルな固定文言
    if (stage === "name") {
      return "ありがとうございます。 お名前を承りました。 続いて、ご住所をお伺いいたしますので、このあとの案内に続けてご住所をお話しください。";
    } else {
      return "ありがとうございます。 ご住所を承りました。 このあと、連絡先のお電話番号をボタン操作でお伺いし、その後で合計金額をご案内いたします。 そのままお待ちください。";
    }
  }

  const nameSpeech = order?.nameSpeech || "";
  const addressSpeech = order?.addressSpeech || "";
  const addr = order?.addr || null;
  const baseAddr = addr
    ? `${addr.prefecture || ""}${addr.city || ""}${addr.town || ""}`
    : "";

  const baseSystem =
    "あなたは「手造りえびせんべい磯屋」の電話受付スタッフです。" +
    "とても丁寧な敬語で、日本語で短く話してください。" +
    "相手はお客様なので、必ず「様」を付けてお呼びしてください。" +
    "電話音声として読み上げられることを前提に、聞き取りやすい自然な文章にしてください。" +
    "不自然な日本語（例:「〜様かろ」「〜様かろう」など）は絶対に使わないでください。";

  let stageSystem;
  if (stage === "name") {
    stageSystem =
      "ユーザーの発話は、お客様のお名前です。" +
      "フルネームまたは名字をできる範囲で判断し、名字のあとに「様」を付けてお呼びください。" +
      "たとえば「木村太郎」の場合は、「木村太郎様でございますね。ありがとうございます。」のように復唱してください。" +
      "そのあとで、「続いて、ご住所をお伺いいたしますので、このあとの案内の後にご住所をお話しください。」と丁寧に伝えてください。";
  } else {
    const addrHint = baseAddr
      ? `すでに郵便番号から「${baseAddr}」までは分かっています。ユーザーの発話は、その続きの番地・建物名・お部屋番号であるとみなしてください。`
      : "";

    stageSystem =
      "ユーザーの発話は、お客様のご住所です。" +
      (nameSpeech
        ? `すでにお名前として「${nameSpeech}」をお伺いしています。`
        : "") +
      addrHint +
      "丁寧に復唱し、「こちらのご住所でお伺いいたしました。」のように確認してください。" +
      "最後に、『このあと、連絡先のお電話番号をボタン操作でお伺いし、その後で、商品代金と送料、代引き手数料を含めた合計金額をご案内いたしますので、そのままお待ちください。』とお伝えしてください。";
  }

  const messages = [
    { role: "system", content: baseSystem },
    { role: "system", content: stageSystem },
    {
      role: "user",
      content: speechText || "",
    },
  ];

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 200,
        temperature: 0.4,
      }),
    });

    const data = await resp.json();
    const aiText =
      data?.choices?.[0]?.message?.content ||
      "ありがとうございます。内容を承りました。";

    // Twilio TTS が読みやすいように、改行はスペースに
    return aiText.replace(/\s+/g, " ");
  } catch (e) {
    console.error("OpenAI name/address error:", e);
    if (stage === "name") {
      return "ありがとうございます。 お名前を承りました。 続いて、ご住所をお伺いいたしますので、このあとの案内の後にご住所をお話しください。";
    } else {
      return "ありがとうございます。 ご住所を承りました。 このあと、連絡先のお電話番号をボタン操作でお伺いし、その後で合計金額をご案内いたします。 そのままお待ちください。";
    }
  }
}

// ==== Google Maps Geocoding API で住所チェック =========================

/**
 * Google Maps Geocoding API で 住所をチェック
 * @param {string} fullAddress zipcloudで取った町名まで + お客様の番地・建物名など
 * @returns {Promise<{ok:boolean, partial:boolean, formattedAddress:string, status:string}>}
 */
async function validateAddressWithGoogle(fullAddress) {
  if (!GOOGLE_MAPS_API_KEY) {
    console.warn("[ADDR] GOOGLE_MAPS_API_KEY 未設定のため Google 検証スキップ");
    return {
      ok: true,
      partial: false,
      formattedAddress: fullAddress,
      status: "NO_KEY",
    };
  }

  const url =
    "https://maps.googleapis.com/maps/api/geocode/json" +
    `?address=${encodeURIComponent(fullAddress)}` +
    `&language=ja&region=jp&key=${GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return {
        ok: false,
        partial: false,
        formattedAddress: "",
        status: data.status,
      };
    }

    const r = data.results[0];
    const partial = !!r.partial_match;

    return {
      ok: !partial, // 完全一致っぽい → true
      partial,
      formattedAddress: r.formatted_address || "",
      status: data.status,
    };
  } catch (e) {
    console.error("[ADDR] Google geocode error:", e);
    // エラー時は注文を落とさないために OK 扱いにしておく
    return {
      ok: true,
      partial: true,
      formattedAddress: fullAddress,
      status: "ERROR",
    };
  }
}

// ==== LINE 管理者への通知関数 ==========================================

/**
 * 電話代引き注文を LINE 管理者に通知
 * @param {object} payload - 注文情報
 */
async function notifyLineAdminForCodOrder(payload) {
  if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_ADMIN_USER_ID) {
    console.warn(
      "[COD/LINE] LINE_CHANNEL_ACCESS_TOKEN または LINE_ADMIN_USER_ID が未設定のため、通知をスキップします。"
    );
    return;
  }

  try {
    const {
      ts,
      callSid,
      items = [],
      zip,
      addr,
      nameSpeech,
      addressSpeech,
      phone,
      itemsTotal,
      shipping,
      codFee,
      finalTotal,
      googleFormattedAddress,
    } = payload;

    const when = ts || new Date().toISOString();

    const addrBase = addr
      ? `${addr.prefecture || ""}${addr.city || ""}${addr.town || ""}`
      : "";
    const fullAddress =
      googleFormattedAddress ||
      (addrBase || addressSpeech ? `${addrBase}${addressSpeech || ""}` : "（未取得）");

    const nameText = nameSpeech || "（未取得）";
    const phoneText = phone || "（未取得）";
    const zipText = zip || "（未取得）";
    const regionText = addr?.region || "（不明）";

    const itemsLines = items.length
      ? items
          .map((it) => {
            const lineTotal = (it.price || 0) * (it.qty || 0);
            return `・${it.name || "商品"} x ${it.qty || 0}個 = ${
              lineTotal
            }円`;
          })
          .join("\n")
      : "（商品情報がありません）";

    const message =
      `【電話代引き 新規注文】\n` +
      `日時: ${when}\n` +
      `CallSid: ${callSid || "（なし）"}\n\n` +
      `▼ご注文商品\n${itemsLines}\n\n` +
      `商品小計: ${itemsTotal}円\n` +
      `送料: ${shipping}円（地域: ${regionText}）\n` +
      `代引き手数料: ${codFee}円\n` +
      `合計金額: ${finalTotal}円\n\n` +
      `▼お客様情報\n` +
      `お名前: ${nameText}\n` +
      `郵便番号: ${zipText}\n` +
      `住所: ${fullAddress}\n` +
      `電話番号: ${phoneText}\n\n` +
      `※この注文は Twilio 電話受付（代引き専用）からです。`;

    const resp = await fetch("https://api.line.me/v2/bot/message/push", {
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
            text: message.slice(0, 2000), // 念のため 2000文字でカット
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        "[COD/LINE] push error:",
        resp.status,
        resp.statusText,
        text
      );
    } else {
      console.log("[COD/LINE] 管理者へ注文通知を送信しました。");
    }
  } catch (e) {
    console.error("[COD/LINE] notify error:", e);
  }
}

// ==== Express アプリ ===================================================

const app = express();
const urlencoded = express.urlencoded({ extended: false });

// ======================================================================
// 1) エントリーポイント /twilio/cod（プッシュ式入り口）
// ======================================================================

app.all("/twilio/cod", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";

  // この通話の注文情報をリセット
  DTMF_ORDERS[callSid] = { items: [] };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。 こちらは、ボタン操作による代金引換ご注文専用の自動受付です。
  </Say>
  <Say language="ja-JP" voice="alice">
    まず、商品と個数をボタンでご指定いただき、 そのあとに郵便番号7桁をご入力いただきます。 最後に、お名前とご住所をお伺いし、 連絡先のお電話番号をボタンでご入力いただいたうえで、 商品代金に送料と代引き手数料を加えた合計金額を、ご案内いたします。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 2) 商品選択 → /twilio/cod/product
// ======================================================================

app.post("/twilio/cod/product", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  const products = readProducts();
  const menu = products.slice(0, 9); // DTMFで1〜9まで

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

  // この通話のメニュー定義を保存（digit → product id / name）
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
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// 商品選択の結果を処理 → 個数入力へ
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
// 3) 個数入力 → 注文リストに追加 → 追加注文の有無
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
  const name = p?.name || productNameFromMenu || "ご指定の商品";
  const price = Number(p?.price || 0);

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
// 4) 追加注文の有無 → 1:商品選択へ戻る / 2: 郵便番号入力へ
// ======================================================================

app.post("/twilio/cod/more", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digit = (req.body.Digits || "").trim();

  let twiml;

  if (digit === "1") {
    // 追加注文 → 再び商品選択へ
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    では、追加のご注文をお伺いします。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
  } else if (digit === "2") {
    // これで全部 → 郵便番号入力へ
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/twilio/cod/zip</Redirect>
</Response>`;
  } else {
    // 入力エラー
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

// 追加注文の有無 再入力
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
// 5) 郵便番号入力（7桁）→ /twilio/cod/zip
// ======================================================================

app.post("/twilio/cod/zip", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="7" action="/twilio/cod/zip-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      お届け先の郵便番号7桁を、 ハイフンなしでご入力ください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/twilio/cod/zip-handler", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const zip = (req.body.Digits || "").trim();

  const order = DTMF_ORDERS[callSid] || { items: [] };
  order.zip = zip;

  let addr = null;
  try {
    addr = await lookupAddressByZip(zip);
  } catch (e) {
    console.error("zip lookup error:", e);
  }

  if (!addr || !addr.prefecture) {
    order.addr = null;
    DTMF_ORDERS[callSid] = order;

    const twimlFail = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    郵便番号から住所を確認できませんでした。 送料は0円として計算し、商品代金と代引き手数料のみでご案内いたします。
  </Say>
  <Redirect method="POST">/twilio/cod/name-addr</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlFail);
  }

  // 地域・送料を判定
  let region = "";
  let shipping = 0;
  try {
    region = detectRegionFromAddress({
      prefecture: addr.prefecture,
      address1: `${addr.city || ""}${addr.town || ""}`,
    });
    if (region) shipping = SHIPPING_BY_REGION[region] || 0;
  } catch (e) {
    console.error("detectRegionFromAddress error:", e);
  }

  order.addr = {
    ...addr,
    region,
    shipping,
  };
  DTMF_ORDERS[callSid] = order;

  const addrText = `${addr.prefecture}${addr.city}${addr.town}`;
  const shipText = region
    ? `お届け先は、${addrText}と判定されました。 この地域の送料は${shipping}円です。`
    : `お届け先は、${addrText}と判定されましたが、送料は0円として計算いたします。`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${shipText}
  </Say>
  <Redirect method="POST">/twilio/cod/name-addr</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ======================================================================
// 5.5) 名前・住所だけ OpenAI で丁寧な会話 + Google住所チェック
// ======================================================================

// 名前フェーズ開始
app.post("/twilio/cod/name-addr", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };
  order.nameStage = "name"; // まずは名前フェーズ
  order.nameSpeech = "";
  order.addressSpeech = "";
  DTMF_ORDERS[callSid] = order;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/cod/name-addr-handler"
          method="POST">
    <Say language="ja-JP" voice="alice">
      最後に、お名前とご住所をお伺いします。 まず、お名前をフルネームで、 ゆっくりお話しください。 話し終わりましたら、 そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、 通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// 名前 or 住所の発話を受け取り → OpenAI で丁寧な応答 → 必要なら Google住所チェック
app.post("/twilio/cod/name-addr-handler", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const speech = (req.body.SpeechResult || "").trim();

  let order = DTMF_ORDERS[callSid] || { items: [] };
  const stage = order.nameStage || "name";

  if (!speech) {
    if (stage === "name") {
      const twimlNoSpeech = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    すみません、音声がうまく聞き取れませんでした。 もう一度、お名前をゆっくりお話しいただけますか。
  </Say>
  <Redirect method="POST">/twilio/cod/name-addr</Redirect>
</Response>`;
      return res.type("text/xml").send(twimlNoSpeech);
    } else {
      const twimlNoSpeech = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    すみません、音声がうまく聞き取れませんでした。 もう一度、ご住所の続きの番地や建物名、お部屋番号をお話しいただけますか。
  </Say>
  <Redirect method="POST">/twilio/cod/name-addr</Redirect>
</Response>`;
      return res.type("text/xml").send(twimlNoSpeech);
    }
  }

  if (stage === "name") {
    // ======== 名前フェーズ ========
    order.nameSpeech = speech;
    DTMF_ORDERS[callSid] = order;

    const aiReply = await askOpenAIForNameAddress("name", speech, order);

    order = DTMF_ORDERS[callSid] || order;
    order.nameStage = "address";
    DTMF_ORDERS[callSid] = order;

    const baseAddr =
      order.addr
        ? `${order.addr.prefecture || ""}${order.addr.city || ""}${order.addr.town || ""}`
        : "";

    const addrGuide = baseAddr
      ? `郵便番号から、「${baseAddr}」まではこちらで確認できていますので、 その続きの番地や建物名、お部屋番号をゆっくりお話しください。`
      : `ご住所を、都道府県から番地、建物名、お部屋番号まで、ゆっくりお話しください。`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/cod/name-addr-handler"
          method="POST">
    <Say language="ja-JP" voice="alice">
      ${addrGuide} 話し終わりましたら、 そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、 通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;

    return res.type("text/xml").send(twiml);
  }

  // ======== 住所フェーズ（住所の続き） ========
  order.addressSpeech = speech;
  DTMF_ORDERS[callSid] = order;

  // まず AI の丁寧な返事を作る
  const aiReply = await askOpenAIForNameAddress("address", speech, order);

  const baseAddr =
    order.addr
      ? `${order.addr.prefecture || ""}${order.addr.city || ""}${order.addr.town || ""}`
      : "";

  const fullAddrForCheck = `${baseAddr}${order.addressSpeech || ""}`;

  // Google 住所チェック
  const gResult = await validateAddressWithGoogle(fullAddrForCheck);

  let twiml;

  if (!gResult.ok) {
    // ★ 住所として怪しい → もう一度住所だけ聞き直す
    const retryText =
      "住所がうまく認識できませんでした。 番地・建物名・お部屋番号を含めて、もう一度ゆっくりお話しいただけますか。";

    // stageは address のままにして再度このハンドラに戻ってくる
    order = DTMF_ORDERS[callSid] || order;
    order.nameStage = "address";
    DTMF_ORDERS[callSid] = order;

    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Say language="ja-JP" voice="alice">
    ${retryText}
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/cod/name-addr-handler"
          method="POST">
    <Say language="ja-JP" voice="alice">
      もう一度、ご住所の続きの番地や建物名、お部屋番号をお話しください。 話し終わりましたら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、 通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  } else {
    // ★ OK → 電話番号フェーズへ進む
    order = DTMF_ORDERS[callSid] || order;
    order.nameStage = "done";
    order.googleFormattedAddress = gResult.formattedAddress || null;
    DTMF_ORDERS[callSid] = order;

    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Redirect method="POST">/twilio/cod/phone</Redirect>
</Response>`;
  }

  return res.type("text/xml").send(twiml);
});

// ======================================================================
// 5.7) 連絡先電話番号をプッシュで取得
// ======================================================================

app.post("/twilio/cod/phone", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="11" action="/twilio/cod/phone-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      続いて、 ご連絡先のお電話番号をお伺いします。 市外局番からハイフンなしで、 9桁から11桁の数字を押してください。 入力後、シャープは不要です。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/twilio/cod/phone-handler", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digits = (req.body.Digits || "").trim();

  if (!digits || digits.length < 9 || digits.length > 11 || !/^\d+$/.test(digits)) {
    const twimlErr = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話番号の入力が確認できませんでした。 市外局番からハイフンなしで、 9桁から11桁の数字でご入力ください。
  </Say>
  <Redirect method="POST">/twilio/cod/phone</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlErr);
  }

  const order = DTMF_ORDERS[callSid] || { items: [] };
  order.phone = digits;
  DTMF_ORDERS[callSid] = order;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。 お電話番号は、 ${digits} でお預かりいたしました。 このあと、 ご注文内容と合計金額を確認いたしますので、 そのままお待ちください。
  </Say>
  <Redirect method="POST">/twilio/cod/summary</Redirect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ======================================================================
// 6) 合計金額の読み上げ → 終了 /twilio/cod/summary
// ======================================================================

app.post("/twilio/cod/summary", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  const nameSpeech = order.nameSpeech || "";
  const addressSpeech = order.addressSpeech || "";
  const phoneDigits = order.phone || "";

  let itemsText = "";
  let itemsTotal = 0;

  if (order.items.length === 0) {
    itemsText = "ご注文内容が確認できませんでした。";
  } else {
    const parts = order.items.map((item) => {
      const lineTotal = item.price * item.qty;
      itemsTotal += lineTotal;
      return `${item.name}を${item.qty}個`;
    });
    itemsText = parts.join("、") + "で承りました。";
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

  const baseAddr =
    order.addr
      ? `${order.addr.prefecture || ""}${order.addr.city || ""}${order.addr.town || ""}`
      : "";

  const googleAddr = order.googleFormattedAddress || "";
  const fullAddressText =
    googleAddr ||
    (baseAddr || addressSpeech
      ? `${baseAddr}${addressSpeech || ""}`
      : "");

  const nameAddrText =
    nameSpeech || fullAddressText
      ? ` お名前とご住所は、「${[
          nameSpeech || "",
          fullAddressText || "",
        ]
          .filter(Boolean)
          .join("、")}」とお伺いしました。`
      : "";

  const phoneText =
    phoneDigits
      ? ` ご連絡先のお電話番号は、「${phoneDigits}」でお伺いしました。`
      : "";

  const summaryText =
    itemsText +
    nameAddrText +
    phoneText +
    ` 商品代金の合計は税込みで${itemsTotal}円です。 ` +
    `${shippingText} 代引き手数料は${codFee}円です。 ` +
    `商品代金、送料、代引き手数料を合わせたお支払い合計金額は、${finalTotal}円になります。`;

  // ログに残す（★ このログ内容をそのまま LINE 通知にも使う）
  const logPayload = {
    ts: new Date().toISOString(),
    callSid,
    items: order.items,
    zip: order.zip || null,
    addr: order.addr || null,
    nameSpeech: nameSpeech || null,
    addressSpeech: addressSpeech || null,
    googleFormattedAddress: googleAddr || null,
    phone: phoneDigits || null,
    itemsTotal,
    shipping,
    codFee,
    finalTotal,
  };

  try {
    fs.appendFileSync(COD_LOG, JSON.stringify(logPayload) + "\n", "utf8");
  } catch (e) {
    console.error("cod log write error:", e);
  }

  // ★ LINE 管理者へ通知（失敗しても通話フローには影響しないようにしておく）
  await notifyLineAdminForCodOrder(logPayload);

  // 使い終わったので削除
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
// Health check
// ======================================================================

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
      OPENAI_API_KEY: !!OPENAI_API_KEY,
      LINE_CHANNEL_ACCESS_TOKEN: !!LINE_CHANNEL_ACCESS_TOKEN,
      LINE_ADMIN_USER_ID: !!LINE_ADMIN_USER_ID,
      GOOGLE_MAPS_API_KEY: !!GOOGLE_MAPS_API_KEY,
    },
  });
});

// ======================================================================
// 起動
// ======================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📦 COD phone hybrid server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/cod");
  console.log(
    "   LINE notify:",
    LINE_CHANNEL_ACCESS_TOKEN ? "token OK" : "token MISSING",
    LINE_ADMIN_USER_ID ? "admin OK" : "admin MISSING"
  );
  console.log(
    "   Google Geocoding:",
    GOOGLE_MAPS_API_KEY ? "key OK" : "key MISSING"
  );
});
