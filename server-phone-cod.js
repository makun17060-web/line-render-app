// server-phone-cod.js
// Twilio 代引き専用 AI 自動受付サーバー（LINE 機能なし）

"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

// ==== 環境変数 =========================================================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PORT = process.env.PORT || 3000;

// ==== ログ保存用 =======================================================
// data フォルダがなければ作成
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const COD_LOG = path.join(DATA_DIR, "cod-phone-orders.log");

// ==== 会話メモリ（CallSid ごと） ======================================
const PHONE_CONVERSATIONS = {};

/**
 * 代引き専用 AI に質問して、返答をもらう
 * @param {string} callSid Twilio の CallSid
 * @param {string} userText お客さんの発話（SpeechResult）
 * @returns {Promise<string>} 電話で読み上げる日本語テキスト
 */
async function askOpenAIForCOD(callSid, userText) {
  if (!OPENAI_API_KEY) {
    console.warn("⚠ OPENAI_API_KEY が設定されていません。");
    return "申し訳ありません。現在AIによる自動受付が利用できません。時間をおいてお掛け直しいただくか、LINEからご注文ください。";
  }

  // 通話ごとの会話履歴を初期化
  if (!PHONE_CONVERSATIONS[callSid]) {
    PHONE_CONVERSATIONS[callSid] = [
      {
        role: "system",
        content:
          "あなたは「手造りえびせんべい磯屋」の【代金引換専用】電話自動受付スタッフです。" +
          "この電話では、代引き注文の受付だけを行います。" +
          "必ず丁寧な敬語で、日本語で、1回の返答は短く簡潔に話してください。" +
          "以下の情報を、なるべく1つずつ順番に聞き取ってください：" +
          "1) ご希望の商品名（例：久助、四角のりせん、プレミアムえびせんなど）と個数、" +
          "2) お名前、" +
          "3) お電話番号、" +
          "4) 郵便番号、" +
          "5) 都道府県からのご住所、" +
          "6) 希望のお届け日時があればその希望。" +
          "途中で足りない情報があれば、やさしく聞き返してください。" +
          "最後に、聞き取った内容を短く復唱して「この内容で代引きにて承ってもよろしいでしょうか？」と確認してください。" +
          "営業時間や場所など、それ以外の質問をされた場合は、簡単にお答えしたあと、必ず代引き注文の受付に話を戻してください。" +
          "電話なので、文章を読み上げるように、ゆっくり分かりやすく話してください。"
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
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // 安くて速いモデル
        messages: history,
        max_tokens: 220,
        temperature: 0.5
      })
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
// 1) 着信時：代引き専用の案内 → AI への最初の質問へ
// ======================================================================
app.all("/twilio/cod", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  // 新しい通話なので履歴をリセット
  delete PHONE_CONVERSATIONS[callSid];

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。 手造りえびせんべい、磯屋です。 こちらは、代金引換でのご注文専用の自動受付です。
  </Say>
  <Say language="ja-JP" voice="alice">
    ご希望の商品名と個数、 お名前、 お電話番号、 郵便番号とご住所を、 ゆっくりお話しください。 途中でこちらから確認の質問をさせていただきます。
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
// 2) お客さんの発話を受け取って AI に投げる
// ======================================================================
app.post("/twilio/cod/handle", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  const speechText = (req.body.SpeechResult || "").trim();
  console.log("【Twilio COD SpeechResult】", speechText);

  let aiReply;

  if (!speechText) {
    aiReply =
      "すみません、音声がうまく聞き取れませんでした。 商品名と個数、そしてお名前とご住所を、もう一度ゆっくりお話しいただけますか。";
  } else {
    aiReply = await askOpenAIForCOD(callSid, speechText);
  }

  // 終了キーワード（「以上です」「これでお願いします」なども追加）
  const endKeywords = [
    "大丈夫",
    "ありがとう",
    "結構です",
    "失礼します",
    "切ります",
    "以上です",
    "これでお願いします",
    "これで大丈夫です"
  ];
  const shouldEnd =
    !speechText || endKeywords.some((kw) => speechText.includes(kw));

  // ログに残す（任意）
  try {
    fs.appendFileSync(
      COD_LOG,
      JSON.stringify({
        ts: new Date().toISOString(),
        callSid,
        speechText,
        aiReply
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
      続けて、必要な情報をお話しください。 終了する場合は、「以上です」や「これでお願いします」などとおっしゃってください。
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
      OPENAI_API_KEY: !!OPENAI_API_KEY
    }
  });
});

// ======================================================================
// 起動
// ======================================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`📦 COD phone server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/cod");
});
