// createRichMenu_4col.js — 磯屋4分割（正方形2500×2500版）
// 左上=アンケート / 右上=直接注文 / 左下=オンライン注文 / 右下=会員ログイン
// sharpによる自動圧縮アップロード対応

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { Readable } = require("stream");

/* ========= 必要環境変数 (.env) =========
LINE_CHANNEL_ACCESS_TOKEN=your_token

# ミニアプリ(LIFF)URL
LIFF_URL=https://liff.line.me/xxxxxxxxxxxx

# 会員ログインURL（なければ公式サイトでも可）
MEMBER_URL=https://example.com/login

# 画像パス
IMAGE_PATH=./public/richmenu_4col_square.png
======================================= */

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_URL = process.env.LIFF_URL || "https://example.com/miniapp";
const MEMBER_URL = process.env.MEMBER_URL || "https://example.com/member";
const IMAGE_PATH =
  process.env.IMAGE_PATH ||
  path.join(__dirname, "public", "richmenu_4col_square.png");

const RICHMENU_NAME = "Isoya-4col-Square";
const CHAT_BAR_TEXT = "メニューを開く";

if (!ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  process.exit(1);
}
if (!fs.existsSync(IMAGE_PATH)) {
  console.error("ERROR: 画像が見つかりません:", IMAGE_PATH);
  process.exit(1);
}

// === 四角形画像（2500×2500） ===
const WIDTH = 2500;
const HEIGHT = 2500;
const CELL = WIDTH / 2; // 1250px

const richmenu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: RICHMENU_NAME,
  chatBarText: CHAT_BAR_TEXT,
  areas: [
    // 左上：アンケート
    {
      bounds: { x: 0, y: 0, width: CELL, height: CELL },
      action: { type: "message", text: "アンケート" },
    },
    // 右上：直接注文
    {
      bounds: { x: CELL, y: 0, width: CELL, height: CELL },
      action: { type: "message", text: "直接注文" },
    },
    // 左下：オンライン注文（ミニアプリ）
    {
      bounds: { x: 0, y: CELL, width: CELL, height: CELL },
      action: { type: "uri", uri: LIFF_URL },
    },
    // 右下：会員ログイン
    {
      bounds: { x: CELL, y: CELL, width: CELL, height: CELL },
      action: { type: "uri", uri: MEMBER_URL },
    },
  ],
};

// === 圧縮してアップロード ===
async function uploadRichMenuImage(richMenuId, imgPath) {
  let quality = 80;

  let buffer = await sharp(imgPath)
    .resize(WIDTH, HEIGHT)
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  while (buffer.length >= 1024 * 1024 && quality > 40) {
    quality -= 5;
    buffer = await sharp(imgPath)
      .resize(WIDTH, HEIGHT)
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }

  console.log(`ℹ️ Upload image: quality=${quality}, size=${buffer.length}`);

  const stream = new Readable({
    read() {
      this.push(buffer);
      this.push(null);
    },
  });

  await client.setRichMenuImage(richMenuId, stream, "image/jpeg");
}

const client = new line.Client({ channelAccessToken: ACCESS_TOKEN });

(async () => {
  try {
    console.log("▶ Creating RichMenu...");
    const richMenuId = await client.createRichMenu(richmenu);
    console.log("✅ RichMenu created:", richMenuId);

    console.log("▶ Uploading image...");
    await uploadRichMenuImage(richMenuId, IMAGE_PATH);
    console.log("✅ Image uploaded");

    console.log("▶ Setting as default...");
    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 完了！LINEを再起動すると反映されます");

  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message || err);
  }
})();
