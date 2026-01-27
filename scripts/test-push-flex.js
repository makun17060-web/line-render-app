require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("@line/bot-sdk");

// ===== 環境変数チェック =====
if (!process.env.TEST_USER_ID) {
  console.error("❌ TEST_USER_ID が未設定です");
  process.exit(1);
}

if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  process.exit(1);
}

// ===== Flex JSON 読み込み =====
const flexPath = path.join(__dirname, "../messages/flex.json");

if (!fs.existsSync(flexPath)) {
  console.error("❌ messages/flex.json が見つかりません");
  process.exit(1);
}

let message;
try {
  message = JSON.parse(fs.readFileSync(flexPath, "utf8"));
} catch (e) {
  console.error("❌ flex.json の JSON が壊れています");
  console.error(e.message);
  process.exit(1);
}

// ===== LINE client =====
const client = new Client({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// ===== 送信 =====
client
  .pushMessage(process.env.TEST_USER_ID, message)
  .then(() => {
    console.log("✅ Flex test push sent");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Flex push failed");
    console.error(err?.message || err);
    process.exit(1);
  });
