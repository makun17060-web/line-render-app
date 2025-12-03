// server_phone.js
// Twilio 電話専用サーバー（AI応答 + 代引き注文）

"use strict";
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

// ------------------------------
// OpenAI（電話AI用）
// ------------------------------
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PHONE_CONVERSATIONS = {};

/**
 * 電話用に OpenAI へ問い合わせて、丁寧な日本語で返答してもらう
 */
async function askOpenAIForPhone(callSid, userText) {
  if (!OPENAI_API_KEY) {
    console.warn("⚠ OPENAI_API_KEY が設定されていません。");
    return "申し訳ありません。現在AIによる自動応答が利用できません。LINEやメッセージからお問い合わせください。";
  }

  if (!PHONE_CONVERSATIONS[callSid]) {
    PHONE_CONVERSATIONS[callSid] = [
      {
        role: "system",
        content:
          "あなたは「手造りえびせんべい磯屋」の電話自動応答AIです。" +
          "必ず丁寧な敬語で、日本語で、簡潔に答えてください。" +
          "営業時間・場所・商品・久助・オンライン注文・LINE公式アカウントなどの質問に答えます。" +
          "わからないことは、無理に作らず「LINE のトークからお問い合わせください」と案内してください。" +
          "電話は音声のみなので、1 回の返答は 2〜3 文以内に短くしてください。"
      }
    ];
  }

  const history = PHONE_CONVERSATIONS[callSid];
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
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    const data = await resp.json();
    const aiText =
      data?.choices?.[0]?.message?.content ||
      "すみません。うまくお答えできませんでした。";

    history.push({ role: "assistant", content: aiText });
    return aiText.replace(/\s+/g, " ");
  } catch (e) {
    console.error("OpenAI phone error:", e);
    return "申し訳ありません。システムエラーのため、今はAI応答ができません。LINEのトークからお問い合わせください。";
  }
}

// ------------------------------
// 代引き商品一覧（Twilio用）
// 1=久助 2=四角のりせん 3=プレミアムえびせん
// ------------------------------
const COD_PRODUCTS = {
  "1": { id: "kusuke-250",      name: "久助（えびせん）",   price: 250 },
  "2": { id: "nori-square-300", name: "四角のりせん",       price: 300 },
  "3": { id: "premium-ebi-400", name: "プレミアムえびせん", price: 400 },
};

// CallSid ごとのセッション
const COD_SESSIONS = {};

// 注文を保存するファイル
const COD_ORDERS_FILE = path.join(__dirname, "data", "cod_orders.json");

function readCodOrders() {
  try {
    if (!fs.existsSync(COD_ORDERS_FILE)) return [];
    const txt = fs.readFileSync(COD_ORDERS_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch (e) {
    console.error("[readCodOrders] error", e);
    return [];
  }
}

function writeCodOrders(list) {
  try {
    fs.mkdirSync(path.dirname(COD_ORDERS_FILE), { recursive: true });
    fs.writeFileSync(COD_ORDERS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {
    console.error("[writeCodOrders] error", e);
  }
}

// URLエンコードボディ（Twilio用）
app.use(express.urlencoded({ extended: false }));

// ------------------------------
// ルート & ヘルスチェック
// ------------------------------
app.get("/", (_req, res) => res.status(200).send("PHONE OK"));
app.get("/health", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);

// ------------------------------
// Twilio AI 会話
// ------------------------------

// 1回目の着信：挨拶＋案内
app.all("/twilio/voice", async (req, res) => {
  const callSid = req.body.CallSid || "";
  delete PHONE_CONVERSATIONS[callSid];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。
  </Say>
  <Say language="ja-JP" voice="alice">
    こちらは、AIによる自動応答です。 営業時間、場所、商品、久助のことなど、 ご質問をゆっくりお話しください。
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/voice/handle"
          method="POST">
    <Say language="ja-JP" voice="alice">
      それでは、ご用件をどうぞ。 話し終わったら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// 2回目以降：AI応答
app.post("/twilio/voice/handle", async (req, res) => {
  const callSid = req.body.CallSid || "";
  const speechText = (req.body.SpeechResult || "").trim();
  console.log("【Twilio SpeechResult】", speechText);

  let aiReply;
  if (!speechText) {
    aiReply =
      "すみません、音声がうまく聞き取れませんでした。 もう一度、ゆっくりお話しいただけますか。";
  } else {
    aiReply = await askOpenAIForPhone(callSid, speechText);
  }

  const endKeywords = ["大丈夫", "ありがとう", "結構です", "失礼します", "切ります"];
  const shouldEnd =
    !speechText || endKeywords.some((kw) => speechText.includes(kw));

  let twiml;
  if (shouldEnd) {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Say language="ja-JP" voice="alice">
    ご利用ありがとうございました。 それでは、失礼いたします。
  </Say>
</Response>`;
    delete PHONE_CONVERSATIONS[callSid];
  } else {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Gather input="speech"
          language="ja-JP"
          speechTimeout="auto"
          action="/twilio/voice/handle"
          method="POST">
    <Say language="ja-JP" voice="alice">
      ほかにもご質問があれば、そのままお話しください。 終了する場合は、「もう大丈夫です」などとおっしゃってください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できなかったため、通話を終了いたします。 ありがとうございました。
  </Say>
</Response>`;
  }

  res.type("text/xml").send(twiml);
});

// ------------------------------
// 代引き注文フロー（COD）
// ------------------------------

// ① 最初の案内 & 商品選択
app.post("/twilio/cod/start", (req, res) => {
  console.log("[/twilio/cod/start]");
  const twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。
    こちらは、代引きご希望のお客さま専用の自動受付です。
  </Say>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/product" method="POST">
    <Say language="ja-JP" voice="alice">
      ご希望の商品をお選びください。
      久助は 1 を、 四角のりせんは 2 を、 プレミアムえびせんは 3 を押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
  </Say>
  <Hangup/>
</Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// ② 商品番号 → 商品決定
app.post("/twilio/cod/product", (req, res) => {
  const digits = req.body.Digits;
  const callSid = req.body.CallSid || "";
  console.log("[/twilio/cod/product] Digits =", digits, "CallSid =", callSid);

  const prod = COD_PRODUCTS[digits];
  if (!prod) {
    const twiml = `
<Response>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 もう一度お試しください。
  </Say>
  <Redirect method="POST">/twilio/cod/start</Redirect>
</Response>
    `.trim();
    return res.type("text/xml").send(twiml);
  }

  COD_SESSIONS[callSid] = {
    productKey: digits,
    productId: prod.id,
    productName: prod.name,
    price: prod.price,
  };

  const twiml = `
<Response>
  <Gather input="speech" action="/twilio/cod/name" method="POST">
    <Say language="ja-JP" voice="alice">
      ${prod.name}ですね。
      ご注文者のお名前を、フルネームでゆっくりとお話しください。
      話し終えましたら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    音声が確認できませんでした。 お手数ですが、最初からやり直してください。
  </Say>
  <Redirect method="POST">/twilio/cod/start</Redirect>
</Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// ③ 名前 → 電話番号
app.post("/twilio/cod/name", (req, res) => {
  const callSid = req.body.CallSid || "";
  const speech = (req.body.SpeechResult || "").trim();
  console.log("[/twilio/cod/name] CallSid =", callSid, "SpeechResult =", speech);

  const sess = COD_SESSIONS[callSid];
  if (!sess) {
    const twimlLost = `
<Response>
  <Say language="ja-JP" voice="alice">
    セッションが切れました。 お手数ですが、最初からおかけ直しください。
  </Say>
  <Hangup/>
</Response>
    `.trim();
    return res.type("text/xml").send(twimlLost);
  }

  sess.customerName = speech || "お名前不明";

  const twiml = `
<Response>
  <Gather input="dtmf" timeout="20" finishOnKey="#" action="/twilio/cod/phone" method="POST">
    <Say language="ja-JP" voice="alice">
      ${sess.customerName}様ですね。
      続いて、ご連絡先のお電話番号を市外局番から数字で入力してください。
      入力が終わったら、シャープを押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、最初からやり直してください。
  </Say>
</Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// ④ 電話番号 → 住所
app.post("/twilio/cod/phone", (req, res) => {
  const callSid = req.body.CallSid || "";
  const digitsRaw = req.body.Digits || "";
  const digits = digitsRaw.replace(/#/g, "");
  console.log("[/twilio/cod/phone] CallSid =", callSid, "DigitsRaw =", digitsRaw);

  const sess = COD_SESSIONS[callSid];
  if (!sess) {
    const twimlLost = `
<Response>
  <Say language="ja-JP" voice="alice">
    セッションが切れました。 お手数ですが、最初からおかけ直しください。
  </Say>
  <Hangup/>
</Response>
    `.trim();
    return res.type("text/xml").send(twimlLost);
  }

  sess.phone = digits;

  const twiml = `
<Response>
  <Gather input="speech" timeout="10" action="/twilio/cod/address" method="POST">
    <Say language="ja-JP" voice="alice">
      ありがとうございます。
      最後に、お届け先のご住所を、郵便番号から建物名までまとめて、ゆっくりとお話しください。
      話し終えましたら、そのままお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、最初からやり直してください。
  </Say>
</Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// ⑤ 住所 → 確認
app.post("/twilio/cod/address", (req, res) => {
  const callSid = req.body.CallSid || "";
  const speech = (req.body.SpeechResult || "").trim();
  console.log("[/twilio/cod/address] CallSid =", callSid, "SpeechResult =", speech);

  const sess = COD_SESSIONS[callSid];
  if (!sess) {
    const twimlLost = `
<Response>
  <Say language="ja-JP" voice="alice">
    セッションが切れました。 お手数ですが、最初からおかけ直しください。
  </Say>
  <Hangup/>
</Response>
    `.trim();
    return res.type("text/xml").send(twimlLost);
  }

  sess.address = speech || "住所不明";
  const priceYen = Number(sess.price || 0).toLocaleString("ja-JP");

  const twiml = `
<Response>
  <Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/confirm" method="POST">
    <Say language="ja-JP" voice="alice">
      ご注文内容の確認です。
      商品は、${sess.productName}、税込み ${priceYen} 円。
      お名前は、${sess.customerName} 様。
      お電話番号は、${sess.phone}。
      お届け先のご住所は、${sess.address}。
      以上の内容でよろしければ 1 を、
      訂正する場合は 2 を押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。 お手数ですが、最初からやり直してください。
  </Say>
  <Redirect method="POST">/twilio/cod/start</Redirect>
</Response>
  `.trim();
  res.type("text/xml").send(twiml);
});

// ⑥ 確定 → 保存
app.post("/twilio/cod/confirm", (req, res) => {
  const callSid = req.body.CallSid || "";
  const digit = (req.body.Digits || "").trim();
  console.log("[/twilio/cod/confirm] CallSid =", callSid, "Digits =", digit);

  const sess = COD_SESSIONS[callSid];
  if (!sess) {
    const twimlLost = `
<Response>
  <Say language="ja-JP" voice="alice">
    セッションが切れました。 お手数ですが、最初からおかけ直しください。
  </Say>
  <Hangup/>
</Response>
    `.trim();
    return res.type("text/xml").send(twimlLost);
  }

  if (digit !== "1") {
    const twimlRetry = `
<Response>
  <Say language="ja-JP" voice="alice">
    ご注文内容の訂正をご希望のため、恐れ入りますが、最初からおかけ直しください。
  </Say>
  <Hangup/>
</Response>
    `.trim();
    delete COD_SESSIONS[callSid];
    return res.type("text/xml").send(twimlRetry);
  }

  const orders = readCodOrders();
  const newOrder = {
    id: orders.length + 1,
    createdAt: new Date().toISOString(),
    callSid,
    from: req.body.From || "",
    to: req.body.To || "",
    productId: sess.productId,
    productName: sess.productName,
    price: sess.price,
    customerName: sess.customerName,
    phone: sess.phone,
    address: sess.address,
  };
  orders.push(newOrder);
  writeCodOrders(orders);
  console.log("【COD 注文保存】", newOrder);

  delete COD_SESSIONS[callSid];

  const twimlDone = `
<Response>
  <Say language="ja-JP" voice="alice">
    ご注文を承りました。 ありがとうございます。
    商品のご用意が整い次第、発送させていただきます。
    このまま電話をお切りください。
  </Say>
  <Hangup/>
</Response>
  `.trim();
  res.type("text/xml").send(twimlDone);
});

// ------------------------------
// 起動
// ------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`📞 Phone server started on port ${PORT}`);
});
