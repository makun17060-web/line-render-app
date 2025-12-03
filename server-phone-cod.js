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
          "必ず丁寧な敬語で、日本語で、1回の返答は短く簡潔に話してください。" +
          "以下の情報を、なるべく一つずつ順番に聞き取ってください。" +
          "1) ご希望の商品名と個数。" +
          "2) お名前。" +
          "3) お電話番号。" +
          "4) 郵便番号。" +
          "5) 都道府県からのご住所（番地・建物名など）。" +
          "6) 希望のお届け日時があれば、そのご希望。" +
          "途中で足りない情報があれば、やさしく確認しながら質問してください。" +
          "最後に、聞き取った内容を短く復唱し、「この内容で代金引換にて承ってもよろしいでしょうか？」と確認してください。" +
          "代金引換では、商品代金に【送料】と【代引き手数料330円】が加算されることを、必ずお客様にお伝えしてください。" +
          "電話なので、文章を読み上げるように、ゆっくり分かりやすく話してください。",
      },
      {
        role: "system",
        content:
          "現在取り扱い中の商品一覧は次の通りです。\n" +
          productListText +
          "\n\nお客様の発話に出てくる商品名がこの一覧に近い場合は、その商品として扱い、できる範囲で合計金額を計算して案内してください。",
      },
    ];
  }

  const history = PHONE_CONVERSATIONS[callSid];

  // 郵便番号から住所が引けた場合は、送料情報も含めてシステムメモとして AI に伝える
  if (zipInfo && zipInfo.prefecture) {
    const addrText = `${zipInfo.prefecture}${zipInfo.city || ""}${zipInfo.town || ""}`;

    let region = zipInfo.region || "";
    let shipping = typeof zipInfo.shipping === "number" ? zipInfo.shipping : 0;

    try {
      if (!region) {
        region = detectRegionFromAddress({
          prefecture: zipInfo.prefecture,
          address1: `${zipInfo.city || ""}${zipInfo.town || ""}`,
        });
      }
      if (region && !shipping) {
        shipping = SHIPPING_BY_REGION[region] || 0;
      }
    } catch (e) {
      console.error("detectRegionFromAddress error inside askOpenAIForCOD:", e);
    }

    let memo =
      `システムメモ：お客様の郵便番号「${zipInfo.zip}」から、「${addrText}」と判定されました。`;

    if (region && shipping) {
      memo +=
        ` 配送地域は「${region}」で、この地域の送料は ${shipping}円、代引き手数料は一律 ${COD_FEE}円です。` +
        "合計金額を案内するときは、商品代金の合計に送料と代引き手数料を加えた金額をお客様にお伝えしてください。";
    } else {
      memo += " 必要に応じて住所を復唱し、「こちらのご住所でよろしいでしょうか？」と優しく確認してください。";
    }

    history.push({
      role: "system",
      content: memo,
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
      それでは、ご注文の内容をお話しください。 話し終わったら、そのままお待ちください。
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
