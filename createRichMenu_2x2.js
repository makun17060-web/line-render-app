// createRichMenu_2x2.js — 磯屋 2段2列リッチメニュー（2500x1686）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const sharp = require("sharp");
const { Readable } = require("stream");

// ========= 必要環境変数 (.env) =========
// LINE_CHANNEL_ACCESS_TOKEN=your_token
// MEMBER_URL=https://example.com/login
// ======================================

// ★ オンライン注文（ミニアプリ）の遷移先を固定
const LIFF_URL = "https://line-render-app-1.onrender.com/public/products.html";

// ★ 会員ログインの遷移先（使うなら変更）
const MEMBER_URL = process.env.MEMBER_URL || "";

// ★ あなたの画像を使う
const IMAGE_PATH = "/mnt/data/A_digital_graphic_design_menu_banner_in.png";

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const RICHMENU_NAME = "Isoya-2x2";
const CHAT_BAR_TEXT = "メニューを開く";

// === サイズ ===
const WIDTH = 2500;
const HEIGHT = 1686;
const CELL_W = 1250;
const CELL_H = 843;

const richmenu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: RICHMENU_NAME,
  chatBarText: CHAT_BAR_TEXT,
  areas: [
    { bounds: { x: 0, y: 0, width: CELL_W, height: CELL_H }, action: { type: "message", text: "アンケート" }},
    { bounds: { x: CELL_W, y: 0, width: CELL_W, height: CELL_H }, action: { type: "message", text: "直接注文" }},
    { bounds: { x: 0, y: CELL_H, width: CELL_W, height: CELL_H }, action: { type: "uri", uri: LIFF_URL }},
    { bounds: { x: CELL_W, y: CELL_H, width: CELL_W, height: CELL_H }, action: { type: "uri", uri: MEMBER_URL }},
  ],
};

const client = new line.Client({ channelAccessToken: ACCESS_TOKEN });

// === JPEG圧縮してアップロード ===
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

  console.log(`Upload image: quality=${quality}, size=${buffer.length}`);

  const stream = new Readable({
    read() { this.push(buffer); this.push(null); }
  });

  await client.setRichMenuImage(richMenuId, stream, "image/jpeg");
}

(async () => {
  try {
    console.log("▶ Creating RichMenu...");
    const richMenuId = await client.createRichMenu(richmenu);
    console.log("✔ RichMenu created:", richMenuId);

    console.log("▶ Uploading image...");
    await uploadRichMenuImage(richMenuId, IMAGE_PATH);
    console.log("✔ Image uploaded");

    console.log("▶ Setting as default...");
    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 完了！LINE を再起動すると新しいリッチメニューが表示されます！");
  } catch (err) {
    console.error("❌ Error detail:", err.response?.data || err.message || err);
  }
})();
