// server-phone-cod.js
// Twilio 代引き専用 自動受付サーバー
// ・商品〜郵便番号まではプッシュ式（DTMF）
// ・名前と住所のところだけ OpenAI で丁寧な会話
// ・最後に商品代 + 送料 + 代引き手数料の合計を読み上げ

"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

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

// ==== 商品マスタ（DTMF 番号 → products.json の id） ====================
// ★ products.json の id に合わせて必要なら修正してください
const DTMF_PRODUCT_OPTIONS = [
  { digit: "1", id: "kusuke",         label: "久助" },
  { digit: "2", id: "square-norisen", label: "四角のりせん" },
  { digit: "3", id: "premium-ebisen", label: "プレミアムえびせん" },
];

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
//   addr: { prefecture, city, town, region, shipping },
//   nameStage: "name" | "address" | "done",
//   nameSpeech: "...",
//   addressSpeech: "..."
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
    // フォールバック：OpenAIキーがない場合はシンプルに固定文言
    if (stage === "name") {
      return "ありがとうございます。 お名前を承りました。 続いて、ご住所をお伺いいたしますので、このあとの案内に続けてご住所をお話しください。";
    } else {
      return "ありがとうございます。 ご住所を承りました。 このあと、合計金額をご案内いたしますので、そのままお待ちください。";
    }
  }

  const nameSpeech = order?.nameSpeech || "";
  const addressSpeech = order?.addressSpeech || "";
  const addr = order?.addr || null;

  const baseSystem =
    "あなたは「手造りえびせんべい磯屋」の電話受付スタッフです。" +
    "とても丁寧な敬語で、日本語で短く話してください。" +
    "相手はお客様なので、必ず「様」を付けてお呼びしてください。" +
    "電話音声として読み上げられることを前提に、聞き取りやすい自然な文章にしてください。";

  let stageSystem;
  if (stage === "name") {
    stageSystem =
      "ユーザーの発話は、お客様のお名前です。" +
      "フルネームまたは名字をできる範囲で判断し、名字のあとに「様」を付けてお呼びください。" +
      "たとえば「木村太郎」の場合は、「木村太郎様でございますね。ありがとうございます。」のように復唱してください。" +
      "そのあとで、「続いて、ご住所をお伺いいたしますので、このあとの案内の後にご住所をお話しください。」と丁寧に伝えてください。" +
      "不自然な日本語（例:『〜様かろ』など）は絶対に使わないでください。";
  } else {
    // address
    const addrHint = addr
      ? `なお、郵便番号から「${addr.prefecture}${addr.city}${addr.town}」付近であることは分かっています。これを参考にしても構いませんが、間違っていそうな場合は無理に合わせず、ユーザーの発話を優先してください。`
      : "";
    stageSystem =
      "ユーザーの発話は、お客様のご住所です。" +
      (nameSpeech
        ? `すでにお名前として「${nameSpeech}」をお伺いしています。`
        : "") +
      addrHint +
      "丁寧に復唱し、「こちらのご住所でお伺いいたしました。」のように確認してください。" +
      "最後に、『このあと、商品代金と送料、代引き手数料を含めた合計金額をご案内いたしますので、そのままお待ちください。』とお伝えしてください。" +
      "不自然な日本語（例:『〜様かろ』など）は絶対に使わないでください。";
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
      return "ありがとうございます。 ご住所を承りました。 このあと、合計金額をご案内いたしますので、そのままお待ちください。";
    }
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
    まず、商品と個数をボタンでご指定いただき、 そのあとに郵便番号7桁をご入力いただきます。 最後に、お名前とご住所をお伺いし、 商品代金に送料と代引き手数料を加えた合計金額を、ご案内いたします。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 2) 商品選択 → /twilio/cod/product
// ======================================================================

app.post("/twilio/cod/product", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod/product-handler" method="POST">
    <Say language="ja-JP" voice="alice">
      ご希望の商品をお選びください。 久助は1を、 四角のりせんは2を、 プレミアムえびせんは3を押してください。
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

  const opt = DTMF_PRODUCT_OPTIONS.find((o) => o.digit === digit);

  if (!opt) {
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。 久助は1、 四角のりせんは2、 プレミアムえびせんは3を押してください。
  </Say>
  <Redirect method="POST">/twilio/cod/product</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlError);
  }

  if (!DTMF_ORDERS[callSid]) {
    DTMF_ORDERS[callSid] = { items: [] };
  }
  DTMF_ORDERS[callSid].currentProductId = opt.id;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="2" action="/twilio/cod/qty" method="POST">
    <Say language="ja-JP" voice="alice">
      ${opt.label}の個数を押してください。 1から99までの数字でご入力いただけます。 入力後、シャープは不要です。
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
  const name = p?.name || "ご指定の商品";
  const price = Number(p?.price || 0);

  order.items.push({
    productId,
    name,
    price,
    qty,
  });
  delete order.currentProductId;
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
// 5.5) 名前・住所だけ OpenAI で丁寧な会話
// ======================================================================

// 名前フェーズ開始
app.post("/twilio/cod/name-addr", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };
  order.nameStage = "name";   // まずは名前フェーズ
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

// 名前 or 住所の発話を受け取り → OpenAI で丁寧な応答 → 次へ
app.post("/twilio/cod/name-addr-handler", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const speech = (req.body.SpeechResult || "").trim();

  let order = DTMF_ORDERS[callSid] || { items: [] };
  const stage = order.nameStage || "name";

  if (!speech) {
    const twimlNoSpeech = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    すみません、音声がうまく聞き取れませんでした。 もう一度、お名前をゆっくりお話しいただけますか。
  </Say>
  <Redirect method="POST">/twilio/cod/name-addr</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlNoSpeech);
  }

  // 発話内容を注文情報に保存（名前 or 住所）
  if (stage === "name") {
    order.nameSpeech = speech;
  } else if (stage === "address") {
    order.addressSpeech = speech;
  }
  DTMF_ORDERS[callSid] = order;

  // OpenAI で丁寧な応答文を生成
  const aiReply = await askOpenAIForNameAddress(stage, speech, order);

  let twiml;
  if (stage === "name") {
    // 次は住所フェーズに進める
    order = DTMF_ORDERS[callSid] || order;
    order.nameStage = "address";
    DTMF_ORDERS[callSid] = order;

    twiml = `<?xml version="1.0" encoding="UTF-8"?>
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
      それでは、ご住所を、 都道府県から番地、建物名、お部屋番号まで、 ゆっくりお話しください。 話し終わりましたら、 そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、 通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  } else {
    // 住所フェーズが終わったので合計金額案内へ
    order = DTMF_ORDERS[callSid] || order;
    order.nameStage = "done";
    DTMF_ORDERS[callSid] = order;

    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Redirect method="POST">/twilio/cod/summary</Redirect>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 6) 合計金額の読み上げ → 終了 /twilio/cod/summary
// ======================================================================

app.post("/twilio/cod/summary", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  const nameSpeech = order.nameSpeech || "";
  const addressSpeech = order.addressSpeech || "";

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

  const nameAddrText =
    nameSpeech || addressSpeech
      ? ` お名前とご住所は、「${[nameSpeech, addressSpeech]
          .filter(Boolean)
          .join("、")}」とお伺いしました。`
      : "";

  const summaryText =
    itemsText +
    nameAddrText +
    ` 商品代金の合計は税込みで${itemsTotal}円です。 ` +
    `${shippingText} 代引き手数料は${codFee}円です。 ` +
    `商品代金、送料、代引き手数料を合わせたお支払い合計金額は、${finalTotal}円になります。`;

  // ログに残す
  try {
    fs.appendFileSync(
      COD_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        callSid,
        items: order.items,
        zip: order.zip || null,
        addr: order.addr || null,
        nameSpeech: nameSpeech || null,
        addressSpeech: addressSpeech || null,
        itemsTotal,
        shipping,
        codFee,
        finalTotal,
      }) + "\n",
      "utf8"
    );
  } catch (e) {
    console.error("cod log write error:", e);
  }

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
    },
  });
});

// ======================================================================
// 起動
// ======================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`📦 COD phone hybrid server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/cod");
});
