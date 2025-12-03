// server-phone-cod.js
// Twilio 代引き専用 AI 自動受付サーバー（郵便番号→住所 自動確認 + 送料 & 代引き手数料案内付き）

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
  // DTMF用 商品オプション（番号 → products.json の id）
const DTMF_PRODUCT_OPTIONS = [
  { digit: "1", id: "kusuke",         label: "久助" },
  { digit: "2", id: "square-norisen", label: "四角のりせん" },
  { digit: "3", id: "premium-ebisen", label: "プレミアムえびせん" },
];

  return safeReadJSON(PRODUCTS_PATH, []);
}

// ==== 送料 & 代引き手数料（ミニアプリと共通） ==========================

// server.js 側と同じテーブル
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
 * server.js の detectRegionFromAddress と同じロジック
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

// ==== 環境変数 =========================================================

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PORT = process.env.PORT || 3000;

// ==== 通話ごとのメモリ ==================================================

// 会話履歴
const PHONE_CONVERSATIONS = {};
// 郵便番号から推定された住所（通話単位）
const PHONE_ADDRESS_CACHE = {};

// ==== 郵便番号 → 住所 変換 =============================================

/**
 * 発話テキストから郵便番号らしき数字を抜き出す
 * 例:
 *   "郵便番号は 4780001 です"    → "4780001"
 *   "４７８ー０１２３ です"      → "4780123"
 */
function extractZipFromText(text) {
  if (!text) return null;
  const s = String(text).replace(/[^\d\-ー－]/g, "");
  // パターン1: 3桁-4桁
  const m1 = /(\d{3})[-ー－]?(\d{4})/.exec(s);
  if (m1) return m1[1] + m1[2];

  // パターン2: 7桁連続
  const m2 = /(\d{7})/.exec(s);
  if (m2) return m2[1];

  return null;
}

/**
 * zipcloud API で 郵便番号→住所 を取得
 * @param {string} zip 例: "4780001"
 * @returns {Promise<{zip:string, prefecture:string, city:string, town:string}|null>}
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

// ==== OpenAI に問い合わせる関数 =======================================

/**
 * 代引き専用 AI に質問して、返答をもらう
 * @param {string} callSid Twilio の CallSid
 * @param {string} userText お客さんの発話（SpeechResult）
 * @param {object|null} zipInfo {zip, prefecture, city, town, region?, shipping?} など
 * @returns {Promise<string>} 電話で読み上げる日本語テキスト
 */
async function askOpenAIForCOD(callSid, userText, zipInfo) {
  if (!OPENAI_API_KEY) {
    console.warn("⚠ OPENAI_API_KEY が設定されていません。");
    return "申し訳ありません。現在AIによる自動受付が利用できません。時間をおいてお掛け直しいただくか、LINEからご注文ください。";
  }

  // 通話ごとの会話履歴を初期化
  if (!PHONE_CONVERSATIONS[callSid]) {
    // ★ LINE側と共通の products.json から現在の商品一覧を取得
    const products = readProducts();
    const productListText =
      products.length > 0
        ? products
            .map(
              (p) =>
                `・${p.name}（ID：${p.id} / 価格：${p.price}円 / 在庫：${p.stock ?? 0}個）`
            )
            .join("\n")
        : "現在の商品情報は空です。";

    PHONE_CONVERSATIONS[callSid] = [
      {
        role: "system",
        content:
          "あなたは「手造りえびせんべい磯屋」の【代金引換専用】電話自動受付スタッフです。" +
          "この電話では、代引き注文の受付だけを行います。" +
          "必ず丁寧な敬語で、日本語で話し、1回の返答は短く簡潔にしてください。" +
          "以下の情報を、なるべく一つずつ順番に聞き取ってください。" +
          "1) ご希望の商品名と個数。" +
          "2) お名前。" +
          "3) お電話番号。" +
          "4) 郵便番号。" +
          "5) 郵便番号から分かる都道府県・市区町村・町名を音声で復唱し、その【続きの番地・建物名・部屋番号】を必ず質問すること。" +
          "6) 希望のお届け日時があれば、そのご希望。" +
          "お客様のお名前を呼ぶときや復唱するときは、必ず「様」を付けてお呼びしてください（例：木村太郎様）。" +
          "お名前を確認するときの言い方は、「木村太郎様でよろしいでしょうか？」「木村太郎様のお名前でお間違いないでしょうか？」など、自然な敬語にしてください。" +
          "「〜様かろ」「〜様かろう」など、日本語として不自然な表現は絶対に使わないでください。" +
          "商品名と個数が分かっている場合は、商品一覧に記載された税込価格と個数から商品代金の小計を計算してください。" +
          "代金引換ですので、商品代金の小計に、送料と代引き手数料を加えた【お支払い合計金額】を、できるだけ最後に必ずお伝えしてください。" +
          "「商品代金の小計」「送料」「代引き手数料」の内訳を口頭で説明し、その合計金額を『合計で○○円になります』のように、必ず確定した金額として案内してください。" +
          "「およそ」「概算」「前後」「見込み」などの曖昧な金額表現は一切使わないでください。" +
          "送料や金額が分からない場合は、金額を作らず、『送料の金額がまだ確定していないため、合計金額は後ほどご案内いたします』などと正直にお伝えしてください。" +
          "途中で足りない情報があれば、やさしく確認しながら質問してください。" +
          "最後に、聞き取った内容（商品・個数・お名前・電話番号・住所）を短く復唱し、「この内容で代金引換にて承ってもよろしいでしょうか？」と確認してください。" +
          "電話なので、文章を読み上げるように、ゆっくり分かりやすく話してください。"
      },
      {
        role: "system",
        content:
          "現在取り扱い中の商品一覧は次の通りです。\n" +
          productListText +
          "\n\nお客様の発話に出てくる商品名がこの一覧に近い場合は、その商品として扱ってください。"
      }
    ];
  }
// ==== 通話ごとのメモリ ==================================================

// 会話履歴（会話式AI用）
const PHONE_CONVERSATIONS = {};
// 郵便番号から推定された住所（通話単位）
const PHONE_ADDRESS_CACHE = {};

// プッシュ式（DTMF）用の注文情報
// 例: DTMF_ORDERS[callSid] = { items: [ { productId, name, price, qty }, ... ] }
const DTMF_ORDERS = {};

  const history = PHONE_CONVERSATIONS[callSid];

  // 郵便番号から住所が引けた場合は、送料情報も含めてシステムメモとして AI に伝える
  if (zipInfo && zipInfo.prefecture) {
    const addrText = `${zipInfo.prefecture}${zipInfo.city}${zipInfo.town}`;
    const shippingText =
      zipInfo.region && zipInfo.shipping
        ? `この地域は「${zipInfo.region}」に該当し、送料は ${zipInfo.shipping} 円、代引き手数料は ${COD_FEE} 円です。会話のどこかで、商品代金の小計にこの送料 ${zipInfo.shipping} 円と代引き手数料 ${COD_FEE} 円を加えた【お支払い合計金額】を、『合計で○○円になります』という形で、確定した金額としてお伝えしてください。`
        : "この住所に対する送料の具体的な金額は、このメモだけでは分かりません。送料が分からない場合は、金額を作らず、『送料が確定していないため、合計金額は後ほどご案内いたします』と答えてください。";

    history.push({
      role: "system",
      content:
        `システムメモ：お客様の郵便番号「${zipInfo.zip}」から、` +
        `「${addrText}」と判定されました。` +
        `必ず会話の中で「郵便番号から、${addrText} とお調べしました。」と音声で復唱し、` +
        `そのあとに「こちらでお間違いないでしょうか？もし合っていれば、この続きの番地や建物名、お部屋番号も教えてください。」と質問してください。` +
        `まだ番地・建物名・部屋番号は分かっていない前提で、丁寧に確認しながら続きを聞いてください。` +
        shippingText
    });
  }

  history.push({ role: "user", content: userText });

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: history,
        max_tokens: 220,
        temperature: 0.5,
      }),
    });

    const data = await resp.json();
    const aiText =
      data?.choices?.[0]?.message?.content ||
      "すみません。うまくお答えできませんでした。";

    history.push({ role: "assistant", content: aiText });

    // Twilio の TTS が読みやすいように、改行をスペースに
    return aiText.replace(/\s+/g, " ");
  } catch (e) {
    console.error("OpenAI COD phone error:", e);
    return "申し訳ありません。システムエラーのため、今は自動受付がご利用いただけません。お手数ですが時間をおいてお掛け直しいただくか、LINEからご注文ください。";
  }
}

// ==== Express アプリ ===================================================

const app = express();
const urlencoded = express.urlencoded({ extended: false });

// ======================================================================
// 1) 着信時：代引き専用の案内 → 最初の発話受付
// ======================================================================

app.all("/twilio/cod", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  // 新しい通話なので履歴・住所キャッシュをリセット
  delete PHONE_CONVERSATIONS[callSid];
  delete PHONE_ADDRESS_CACHE[callSid];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。 こちらは、代金引換でのご注文専用の自動受付です。
  </Say>
  <Say language="ja-JP" voice="alice">
    ご希望の商品名と個数、 お名前、 お電話番号、 そして郵便番号とご住所を、 ゆっくりお話しください。 郵便番号から、こちらで住所を自動でお調べいたします。 代金引換では、商品代金に送料と代引き手数料が加算されます。
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/cod/handle"
          method="POST">
    <Say language="ja-JP" voice="alice">
      それでは、ご注文の内容をお話しください。 話し終わりましたら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ======================================================================
// 2) 発話を受け取り → 郵便番号をチェック → 送料地域判定 → AI に渡す → 再度 Gather
// ======================================================================

app.post("/twilio/cod/handle", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const speechText = (req.body.SpeechResult || "").trim();
  console.log("【Twilio COD SpeechResult】", speechText);

  let zipInfo = null;

  // 発話中から郵便番号を抽出
  const zip = extractZipFromText(speechText);
  if (zip) {
    try {
      const addr = await lookupAddressByZip(zip);
      if (addr && addr.prefecture) {
        // ここで送料地域と送料も判定して詰めておく
        let region = "";
        let shipping = 0;
        try {
          region = detectRegionFromAddress({
            prefecture: addr.prefecture,
            address1: `${addr.city || ""}${addr.town || ""}`,
          });
          if (region) shipping = SHIPPING_BY_REGION[region] || 0;
        } catch (e) {
          console.error("detectRegionFromAddress error in handle:", e);
        }

        zipInfo = {
          ...addr,
          region,
          shipping,
        };
        PHONE_ADDRESS_CACHE[callSid] = zipInfo;
        console.log("ZIP resolved:", zipInfo);
      }
    } catch (e) {
      console.error("ZIP lookup failed:", e);
    }
  } else if (PHONE_ADDRESS_CACHE[callSid]) {
    // すでに以前の発話で取得済みなら、それも AI に渡す
    zipInfo = PHONE_ADDRESS_CACHE[callSid];
  }

  let aiReply;

  if (!speechText) {
    aiReply =
      "すみません、音声がうまく聞き取れませんでした。 商品名と個数、お名前、お電話番号、そして郵便番号とご住所を、もう一度ゆっくりお話しいただけますか。";
  } else {
    aiReply = await askOpenAIForCOD(callSid, speechText, zipInfo);
  }

  // 終了キーワード
  const endKeywords = [
    "大丈夫",
    "ありがとう",
    "結構です",
    "失礼します",
    "切ります",
    "以上です",
    "これでお願いします",
    "これで大丈夫です",
  ];
  const shouldEnd =
    !speechText || endKeywords.some((kw) => speechText.includes(kw));

  // ログに残す
  try {
    fs.appendFileSync(
      COD_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        callSid,
        speechText,
        aiReply,
        zipInfo: zipInfo || null,
      }) + "\n",
      "utf8"
    );
  } catch (e) {
    console.error("cod log write error:", e);
  }

  let twiml;

  if (shouldEnd) {
    // 最後の一言だけ言って終了
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Say language="ja-JP" voice="alice">
    ご注文ありがとうございます。 それでは、失礼いたします。
  </Say>
</Response>`;
    // 会話履歴を掃除
    delete PHONE_CONVERSATIONS[callSid];
    delete PHONE_ADDRESS_CACHE[callSid];
  } else {
    // 返答を読み上げて、さらに続けて受付を続行
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/cod/handle"
          method="POST">
    <Say language="ja-JP" voice="alice">
      お話が終わりましたら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});
// ======================================================================
// プッシュ式（DTMF）注文テストフロー
// エントリーポイント: /twilio/cod-dtmf
// ======================================================================

// 着信 → プッシュ式フロー開始
app.all("/twilio/cod-dtmf", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";

  // この通話の注文情報をリセット
  DTMF_ORDERS[callSid] = { items: [] };

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。 こちらは、ボタン操作によるご注文テスト専用の自動受付です。
  </Say>
  <Redirect method="POST">/twilio/cod-dtmf/product</Redirect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// 商品選択（1=久助, 2=四角のりせん, 3=プレミアムえびせん）
app.post("/twilio/cod-dtmf/product", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod-dtmf/product-handler" method="POST">
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
app.post("/twilio/cod-dtmf/product-handler", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const digit = (req.body.Digits || "").trim();

  const opt = DTMF_PRODUCT_OPTIONS.find(o => o.digit === digit);

  if (!opt) {
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。 久助は1、 四角のりせんは2、 プレミアムえびせんは3を押してください。
  </Say>
  <Redirect method="POST">/twilio/cod-dtmf/product</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlError);
  }

  // 一時的に「今回選ばれた商品ID」を覚えておく
  if (!DTMF_ORDERS[callSid]) {
    DTMF_ORDERS[callSid] = { items: [] };
  }
  DTMF_ORDERS[callSid].currentProductId = opt.id;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod-dtmf/qty" method="POST">
    <Say language="ja-JP" voice="alice">
      ${opt.label}の個数を押してください。 1から9までの数字でご入力いただけます。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>`;

  res.type("text/xml").send(twiml);
});

// 個数入力 → 注文リストに追加 → 追加注文の有無を確認
app.post("/twilio/cod-dtmf/qty", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const qtyDigit = (req.body.Digits || "").trim();

  const qty = parseInt(qtyDigit, 10);
  if (!qty || qty <= 0) {
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    個数の入力が正しくありません。 1から9までの数字でご入力ください。
  </Say>
  <Redirect method="POST">/twilio/cod-dtmf/product</Redirect>
</Response>`;
    return res.type("text/xml").send(twimlError);
  }

  const order = DTMF_ORDERS[callSid] || { items: [] };
  const productId = order.currentProductId;
  if (!productId) {
    // 商品IDがない場合は最初からやり直し
    const twimlError = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    商品の選択情報が見つかりませんでした。 恐れ入りますが、最初からお試しください。
  </Say>
  <Redirect method="POST">/twilio/cod-dtmf/product</Redirect>
</Response>`;
    DTMF_ORDERS[callSid] = { items: [] };
    return res.type("text/xml").send(twimlError);
  }

  // products.json から商品情報を取得
  const products = readProducts();
  const p = products.find(x => x.id === productId);
  const name = p?.name || "ご指定の商品";
  const price = Number(p?.price || 0);

  // 注文リストに追加
  order.items.push({
    productId,
    name,
    price,
    qty
  });
  delete order.currentProductId;
  DTMF_ORDERS[callSid] = order;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。 ${name}を${qty}個でお預かりしました。
  </Say>
  <Gather numDigits="1" action="/twilio/cod-dtmf/more" method="POST">
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

// 追加注文の有無 → 1: 商品選択へ戻る, 2: 合計確認へ
app.post("/twilio/cod-dtmf/more", urlencoded, (req, res) => {
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
  <Redirect method="POST">/twilio/cod-dtmf/product</Redirect>
</Response>`;
  } else if (digit === "2") {
    // これで注文完了 → 合計金額などの案内へ
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/twilio/cod-dtmf/summary</Redirect>
</Response>`;
  } else {
    // 入力エラー
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が正しくありません。 さらにご注文がある場合は1を、 以上でよろしければ2を押してください。
  </Say>
  <Redirect method="POST">/twilio/cod-dtmf/more-retry</Redirect>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});

// 入力エラー時の再Gather
app.post("/twilio/cod-dtmf/more-retry", urlencoded, (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather numDigits="1" action="/twilio/cod-dtmf/more" method="POST">
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

// 最後の注文内容と商品代金合計を読み上げて終了
app.post("/twilio/cod-dtmf/summary", urlencoded, (req, res) => {
  const callSid = req.body.CallSid || "";
  const order = DTMF_ORDERS[callSid] || { items: [] };

  let summaryText = "";
  let total = 0;

  if (order.items.length === 0) {
    summaryText = "ご注文内容が確認できませんでした。";
  } else {
    const parts = order.items.map(item => {
      const lineTotal = item.price * item.qty;
      total += lineTotal;
      return `${item.name}を${item.qty}個`;
    });

    summaryText =
      parts.join("、") +
      `で承りました。 商品代金の合計は、税込みで${total}円です。 この金額に、別途、送料と代引き手数料が加算されます。`;
  }

  // 使い終わったので削除
  delete DTMF_ORDERS[callSid];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${summaryText}
  </Say>
  <Say language="ja-JP" voice="alice">
    ご利用ありがとうございました。 それでは、失礼いたします。
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
  console.log(`📦 COD phone server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/cod");
});
