/**
 * scripts/test-push-flex.js
 * Flexメッセージをテスト送信する（丸ごと版）
 *
 * 使い方（PowerShell）:
 *   $env:FLEX_FILE="omise_3d.json"
 *   npm run testpush:flex
 *
 * 使い方（互換: MESSAGE_FILEでもOK）:
 *   $env:MESSAGE_FILE="./messages/omise_3d.json"
 *   npm run testpush:flex
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("@line/bot-sdk");

// ===== 環境変数チェック =====
function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(`❌ ${name} が未設定です`);
    process.exit(1);
  }
  return v;
}

const TEST_USER_ID = mustEnv("TEST_USER_ID");
const LINE_CHANNEL_ACCESS_TOKEN = mustEnv("LINE_CHANNEL_ACCESS_TOKEN");

// ===== Flex JSON 読み込み =====
// 優先順位：
// 1) FLEX_FILE (例: omise_3d.json)  ※messages配下のファイル名として解釈
// 2) MESSAGE_FILE (例: ./messages/omise_3d.json) ※相対/絶対パスどちらでもOK
// 3) デフォルト: messages/flex.json
function resolveFlexPath() {
  const flexFile = (process.env.FLEX_FILE || "").trim();
  const messageFile = (process.env.MESSAGE_FILE || "").trim();

  if (flexFile) {
    return path.resolve(__dirname, "../messages", flexFile);
  }

  if (messageFile) {
    return path.isAbsolute(messageFile)
      ? messageFile
      : path.resolve(process.cwd(), messageFile);
  }

  return path.resolve(__dirname, "../messages", "flex.json");
}

const flexPath = resolveFlexPath();

if (!fs.existsSync(flexPath)) {
  console.error(`❌ Flex JSON が見つかりません: ${flexPath}`);
  console.error(
    `   ヒント: $env:FLEX_FILE="omise_3d.json" もしくは $env:MESSAGE_FILE="./messages/omise_3d.json"`
  );
  process.exit(1);
}

let message;
try {
  const raw = fs.readFileSync(flexPath, "utf8");
  message = JSON.parse(raw);
} catch (e) {
  console.error(`❌ Flex JSON の読み込み/パースに失敗しました: ${flexPath}`);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

// ===== 簡易バリデーション（事故防止）=====
function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function validateMessage(msg) {
  // LINE pushMessage は「message object」または「array of message objects」
  const arr = Array.isArray(msg) ? msg : [msg];

  if (arr.length === 0) throw new Error("message が空です");

  for (const m of arr) {
    if (!isObject(m)) throw new Error("message がオブジェクトではありません");

    // Flexは altText 必須
    if (m.type === "flex") {
      if (!m.altText || typeof m.altText !== "string") {
        throw new Error("flex message に altText がありません（必須）");
      }
      if (!m.contents) {
        throw new Error("flex message に contents がありません");
      }
    }

    // よくある間違い：pushMessage用なのに {to, messages} 形式を渡してる
    if (m.to && m.messages) {
      throw new Error(
        "このJSONは pushMessage 用ではなく、API payload（to/messages）形式っぽいです。message本体（flexオブジェクト or 配列）だけにしてください。"
      );
    }
  }
}

try {
  validateMessage(message);
} catch (e) {
  console.error(`❌ Flex JSON の形式チェックで失敗しました: ${flexPath}`);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}

// ===== LINE client =====
const client = new Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// ===== 送信 =====
(async () => {
  try {
    await client.pushMessage(TEST_USER_ID, message);
    console.log("✅ Flex test push sent");
    console.log(`   to: ${TEST_USER_ID}`);
    console.log(`   file: ${flexPath}`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Flex push failed");
    console.error("message:", err && err.message ? err.message : err);

    // LINEから返る詳細（400の原因がここに出る）
    const data =
      (err &&
        err.originalError &&
        err.originalError.response &&
        err.originalError.response.data) ||
      (err && err.response && err.response.data) ||
      null;

    if (data) {
      console.error("LINE response data:");
      console.error(JSON.stringify(data, null, 2));
    } else {
      console.error("LINE response data: (none)");
    }

    process.exit(1);
  }
})();
