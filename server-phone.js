// server-phone.js
// Twilio 音声通話専用サーバー（LINE 機能は一切なし）

"use strict";

require("dotenv").config();

const express = require("express");

// ==== OpenAI (電話用) =================================================
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// CallSid ごとに会話履歴を保持
const PHONE_CONVERSATIONS = {};

/**
 * 電話用に OpenAI へ問い合わせて、丁寧な日本語で返答してもらう
 * @param {string} callSid TwilioのCallSid
 * @param {string} userText ユーザーが話した内容（TwilioのSpeechResult）
 * @returns {Promise<string>} 電話で読み上げる日本語テキスト
 */
async function askOpenAIForPhone(callSid, userText) {
  if (!OPENAI_API_KEY) {
    console.warn("⚠ OPENAI_API_KEY が設定されていません。");
    return "申し訳ありません。現在AIによる自動応答が利用できません。LINEやメッセージからお問い合わせください。";
  }

  // 会話履歴がなければ初期化
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
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // 安くて速いモデル
        messages: history,
        max_tokens: 200,
        temperature: 0.7
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
    console.error("OpenAI phone error:", e);
    return "申し訳ありません。システムエラーのため、今はAI応答ができません。LINEのトークからお問い合わせください。";
  }
}

// ==== Express アプリ ===================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Twilio からの POST 受信用
const urlencoded = express.urlencoded({ extended: false });

// ======================================================================
// 1) 着信時の最初の応答
// ======================================================================
app.all("/twilio/voice", urlencoded, async (req, res) => {
  const callSid = req.body.CallSid || "";
  // 新しい通話なので履歴を初期化
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

// ======================================================================
// 2) お客さんの音声を受け取って AI に投げる
// ======================================================================
app.post("/twilio/voice/handle", urlencoded, async (req, res) => {
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

  // 「もう大丈夫」「ありがとう」「失礼します」などを含んだら終了とみなす
  const endKeywords = ["大丈夫", "ありがとう", "結構です", "失礼します", "切ります"];
  const shouldEnd =
    !speechText || endKeywords.some((kw) => speechText.includes(kw));

  let twiml;

  if (shouldEnd) {
    // 最後の一言だけ言って終了
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ${aiReply}
  </Say>
  <Say language="ja-JP" voice="alice">
    ご利用ありがとうございました。 それでは、失礼いたします。
  </Say>
</Response>`;
    // 会話履歴を掃除
    delete PHONE_CONVERSATIONS[callSid];
  } else {
    // 返答を読み上げて、さらに続けて質問を受け付ける
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

// ======================================================================
// Health check
// ======================================================================
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    env: {
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    },
  });
});

// ======================================================================
// 起動
// ======================================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`📞 Phone server started on port ${PORT}`);
  console.log("   Twilio inbound URL: POST /twilio/voice");
});
