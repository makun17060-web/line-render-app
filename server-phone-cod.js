"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

// ================== 基本設定 ==================
const app = express();
const PORT = process.env.PORT || 3000;

// Twilio からは x-www-form-urlencoded で飛んでくる
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// データファイル
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");

// ============ OpenAI（任意） ============
let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const OpenAI = require("openai");
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ OpenAI 有効化");
  } catch (e) {
    console.warn("⚠️ OpenAI SDK 読み込みに失敗しました:", e.message || e);
    openai = null;
  }
}

// ============ ユーティリティ ============

function safeReadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("safeReadJSON error:", p, e.message || e);
    return fallback;
  }
}

function readProducts() {
  return safeReadJSON(PRODUCTS_PATH, []);
}

function readAddresses() {
  return safeReadJSON(ADDRESSES_PATH, {});
}

function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}

// XML エスケープ（& < >）
function escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlWrap(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

// ============ 送料関連 ============

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

const COD_FEE = 330;

function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.address1 || address.addr1 || "").trim();
  const hay = pref || addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if (/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿)/.test(hay)) return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if (/沖縄/.test(hay)) return "沖縄";
  return "";
}

/**
 * 電話で入力された 6桁 (例: 123456) から addresses.json を逆引きして住所を返す
 * LINE 側で memberCode: "IS123456" になっている想定
 */
function findAddressByMemberDigits(digits) {
  const numeric = String(digits || "").replace(/\D/g, "");
  if (!numeric) return null;

  const codeCandidate1 = "IS" + numeric;
  const codeCandidate2 = numeric; // 念のためそのままも見る

  const book = readAddresses();
  for (const v of Object.values(book || {})) {
    if (!v) continue;
    if (v.memberCode === codeCandidate1 || v.memberCode === codeCandidate2) {
      return v;
    }
  }
  return null;
}

// ============ OpenAI で読み上げ文を作る（任意） ============
async function buildSummaryWithAI(params) {
  if (!openai || !process.env.OPENAI_API_KEY) return null;

  const {
    productName,
    qty,
    unitPrice,
    subtotal,
    shipping,
    codFee,
    total,
    region,
    addressLabel,
  } = params;

  const userText = [
    `商品名: ${productName}`,
    `数量: ${qty}個`,
    `単価: ${unitPrice}円`,
    `商品合計: ${subtotal}円`,
    `送料: ${shipping}円`,
    `地域: ${region || "不明"}`,
    `代引き手数料: ${codFee}円`,
    `合計: ${total}円`,
    `お届け先: ${addressLabel}`,
  ].join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "あなたは電話注文の自動音声です。日本語で、60〜90文字くらいの聞き取りやすい一文にまとめてください。金額は『◯◯円』とそのまま読み上げやすく表現してください。",
        },
        {
          role: "user",
          content: userText,
        },
      ],
      max_tokens: 120,
    });

    const text = completion.choices[0]?.message?.content || "";
    return text.trim();
  } catch (e) {
    console.error("OpenAI error:", e.message || e);
    return null;
  }
}

// ============ Health チェック ============

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("OK");
});

// ============ Twilio フロー本体 ============

/**
 * 入口:
 * Twilio の電話番号設定「A CALL COMES IN」 → POST https://○○.onrender.com/twilio/cod/start
 */
app.post("/twilio/cod/start", (req, res) => {
  const products = readProducts();

  // 先頭 9件だけ対象（1〜9）
  const target = products.slice(0, 9);

  let menuSpeech;
  if (!target.length) {
    menuSpeech =
      "ただいま、電話でご注文いただける商品がありません。恐れ入りますが、後ほどおかけ直しください。";
  } else {
    const lines = target.map((p, idx) => {
      const no = idx + 1;
      return `${p.name} は ${no} 番。`;
    });
    menuSpeech =
      "お電話ありがとうございます。 手造りえびせんべい磯屋です。 こちらは代引きご希望のお客様専用の自動受付です。" +
      "ご希望の商品番号を押してください。" +
      lines.join(" ");
  }

  const xml = xmlWrap(
    `
<Say language="ja-JP" voice="alice">
  ${escXml(menuSpeech)}
</Say>
<Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/product" method="POST">
</Gather>
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
</Say>
<Hangup/>
`.trim()
  );

  res.type("text/xml").send(xml);
});

/**
 * 商品番号を受け取る → 個数を聞く
 */
app.post("/twilio/cod/product", (req, res) => {
  const digit = (req.body.Digits || "").trim();
  console.log("[/twilio/cod/product] Digits =", digit);

  const products = readProducts();
  const idx = Number(digit || 0) - 1;
  const product = products[idx];

  if (!product) {
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  入力された番号の商品が見つかりませんでした。 最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    return res.type("text/xml").send(xml);
  }

  const askQtySpeech = `${product.name} ですね。 個数を押して、最後にシャープを押してください。 例えば 2個 の場合は、 2、シャープ のように押してください。`;

  const xml = xmlWrap(
    `
<Gather input="dtmf" timeout="10" finishOnKey="#" action="/twilio/cod/qty?pid=${encodeURIComponent(
      product.id
    )}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(askQtySpeech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  個数が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
  );

  res.type("text/xml").send(xml);
});

/**
 * 個数を受け取る → 「この内容でよいか？」確認
 app.post("/twilio/cod/qty", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();

    // Twilio から来る Digits（例: "2", "12", "2#", "#2" など）
    const digitsRaw = (req.body.Digits || "").toString();
    console.log("[/twilio/cod/qty] Digits raw =", digitsRaw);

    // ★ 数字以外（# など）は全部削る
    const digits = digitsRaw.replace(/[^0-9]/g, "");
    const qty = Math.max(1, Math.min(99, Number(digits) || 0));

    console.log("[/twilio/cod/qty] pid =", pid, "digits =", digits, "qty =", qty);

    // 入力エラー時は「かけ直してください」などを案内して終了
    if (!pid || !digits || !qty) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  個数の入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    // ここから：qty確認のステップへ進む
    const confirmSpeech =
      `${qty}個でよろしいですか。 よろしければ 1 を、やり直す場合は 2 を押してください。`;

    const xml = xmlWrap(
      `
<Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/qty-confirm?pid=${encodeURIComponent(
        pid
      )}&qty=${qty}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(confirmSpeech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );

    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/qty error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

// ============ 起動 ============

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 server-phone-cod started on port ${PORT}`);
  console.log("   Twilio Voice Webhook → POST /twilio/cod/start");
});
