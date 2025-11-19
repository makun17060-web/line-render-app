// createRichMenu_2x2.js — 磯屋 2段2列リッチメニュー（2500x1686）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const sharp = require("sharp");
const { Readable } = require("stream");

// ========= 必要環境変数 (.env) =========
// LINE_CHANNEL_ACCESS_TOKEN=your_token
// ======================================

// ★ オンライン注文 → ミニアプリのトップページ
const LIFF_URL = "https://line-render-app-1.onrender.com/public/main.html";

// ★ 会員ログイン → isoya-shop.com
const MEMBER_URL = "https://isoya-shop.com";

// ★ 使用するリッチメニュー画像
const IMAGE_PATH = "/mnt/data/A_digital_graphic_design_menu_banner_in.png";

// ★ LINE TOKEN
const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// === 基本設定 ===
const RICHMENU_NAME = "Isoya-2x2";
const CHAT_BAR_TEXT = "メニューを開く";

// === リッチメニューのサイズ設定 ===
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
      action: { type: "uri", uri: LIFF_URL },
    },
    // 右下：会員ログイン（外部サイト）
    {
      bounds: { x: CELL_W, y: CELL_H, width: CELL_W, height: CELL_H },
      action: { type: "uri", uri: MEMBER_URL },
    },
  ],
};

// ===== LINE クライアント =====
const client = new line.Client({ channelAccessToken: ACCESS_TOKEN });

// === JPEG圧縮して画像アップロード ===
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

    console.log("🎉 完了！ LINE を再起動して新しいメニューをご確認ください！");
  } catch (err) {
    console.error("❌ Error detail:", err.response?.data || err.message || err);
  }
})();
