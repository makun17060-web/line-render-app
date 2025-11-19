// createRichMenu_2x2.js — 磯屋 2段2列リッチメニュー（2500x1686）
// 左上=アンケート / 右上=直接注文 / 左下=オンライン注文 / 右下=会員ログイン

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { Readable } = require("stream");

/* ========= 必要環境変数 (.env) =========
LINE_CHANNEL_ACCESS_TOKEN=your_token
LIFF_URL=https://liff.line.me/xxxxxxxxxxxx
MEMBER_URL=https://example.com/login
IMAGE_PATH=./public/richmenu_2x2_2500x1686.png
======================================= */

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_URL = process.env.LIFF_URL || "https://example.com/miniapp";
const MEMBER_URL = process.env.MEMBER_URL || "https://example.com/member";
const IMAGE_PATH =
  process.env.IMAGE_PATH ||
  path.join(__dirname, "public", "richmenu_2x2_2500x1686.png");

const RICHMENU_NAME = "Isoya-2x2";
const CHAT_BAR_TEXT = "メニューを開く";

if (!ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  process.exit(1);
}
if (!fs.existsSync(IMAGE_PATH)) {
  console.error("ERROR: 画像が見つかりません:", IMAGE_PATH);
  process.exit(1);
}

// === リッチメニューサイズ（2段）：2500x1686 ===
const WIDTH = 2500;
const HEIGHT = 1686;
const CELL_W = WIDTH / 2;  // 1250
const CELL_H = HEIGHT / 2; // 843

const richmenu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: RICHMENU_NAME,
  chatBarText: CHAT_BAR_TEXT,
  areas: [
    // 左上：アンケート
    {
      bounds: { x: 0, y: 0, width: CELL_W, height: CELL_H },
      action: { type: "message", text: "アンケート" },
    },
    // 右上：直接注文
    {
      bounds: { x: CELL_W, y: 0, width: CELL_W, height: CELL_H },
      action: { type: "message", text: "直接注文" },
    },
    // 左下：オンライン注文（ミニアプリ）
    {
      bounds: { x: 0, y: CELL_H, width: CELL_W, height: CELL_H },
      action: { type: "uri", https://liff.line.me/2008406620-G5j1gjzM },
    },
    // 右下：会員ログイン
    {
      bounds: { x: CELL_W, y: CELL_H, width: CELL_W, height: CELL_H },
      action: { type: "uri", uri: MEMBER_URL },
    },
  ],
};

const client = new line.Client({ channelAccessToken: ACCESS_TOKEN });

// === 圧縮してアップロード ===
async function uploadRichMenuImage(richMenuId, imgPath) {
  let quality = 80;

  let buffer = await sharp(imgPath)
    .resize(WIDTH, HEIGHT)          // 念のためサイズを合わせる
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
    console.log("🎉 完了！LINEを再起動すると新しい2段リッチメニューが表示されます");
  } catch (err) {
    console.error("❌ Error detail:", err.response?.data || err.message || err);
  }
})();
