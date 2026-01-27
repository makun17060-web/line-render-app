const { Client } = require("@line/bot-sdk");

if (!process.env.TEST_USER_ID) {
  console.error("❌ TEST_USER_ID が未設定です");
  process.exit(1);
}

if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  process.exit(1);
}

const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

client.pushMessage(process.env.TEST_USER_ID, {
  type: "text",
  text: "【テスト】自分宛て一発送信"
}).then(() => {
  console.log("✅ test push sent");
  process.exit(0);
}).catch(err => {
  console.error("❌ push failed", err?.message || err);
  process.exit(1);
});
