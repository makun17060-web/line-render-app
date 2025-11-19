// createRichMenu_4col.js — 磯屋4分割（横長 2500×843 版）
// 左=アンケート / 中左=直接注文 / 中右=オンライン注文 / 右=会員ログイン
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
LIFF_URL=https://liff.line.me/2008406620-G5j1gjzM

# 会員ログインURL（なければ公式サイトでも可）
MEMBER_URL=https://example.com/login

# 画像パス（正方形でもOK。自動で 2500x843 にリサイズ）
IMAGE_PATH=./public/richmenu_4col_square.png
======================================= */

const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_URL = process.env.LIFF_URL || "https://example.com/miniapp";
const MEMBER_URL = process.env.MEMBER_URL || "https://example.com/member";
const IMAGE_PATH =
  process.env.IMAGE_PATH ||
  path.join(__dirname, "public", "richmenu_4col_square.png");

const RICHMENU_NAME = "Isoya-4col";
const CHAT_BAR_TEXT = "メニューを開く";

if (!ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  process.exit(1);
}
if (!fs.existsSync(IMAGE_PATH)) {
  console.error("ERROR: 画像が見つかりません:", IMAGE_PATH);
  process.exit(1);
}

// === 正しいリッチメニューサイズ（2500x843） ===
const WIDTH = 2500;
const HEIGHT = 843;
const CELL = WIDTH / 4; // 625px 幅 × 4カラム

const richmenu = {
  size: { width: WIDTH, height: HEIGHT },
  selected: true,
  name: RICHMENU_NAME,
  chatBarText: CHAT_BAR_TEXT,
  areas: [
    // 左：アンケート
    {
      bounds: { x: 0, y: 0, width: CELL, height: HEIGHT },
      action: { type: "message", text: "アンケート" },
    },
    // 中左：直接注文
    {
      bounds: { x: CELL, y: 0, width: CELL, height: HEIGHT },
      action: { type: "message", text: "直接注文" },
    },
    // 中右：オンライン注文（ミニアプリ）
    {
      bounds: { x: CELL * 2, y: 0, width: CELL, height: HEIGHT },
      action: { type: "uri", uri: LIFF_URL },
    },
    // 右：会員ログイン
    {
      bounds: { x: CELL * 3, y: 0, width: CELL, height: HEIGHT },
      action: { type: "uri", uri: MEMBER_URL },
    },
  ],
};

const client = new line.Client({ channelAccessToken: ACCESS_TOKEN });

// === 圧縮してアップロード ===
async function uploadRichMenuImage(richMenuId, imgPath) {
  let quality = 80;

  let buffer = await sharp(imgPath)
    .resize(WIDTH, HEIGHT)          // ★ ここで 2500x843 に変形
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
    console.log("🎉 完了！LINEを再起動すると反映されます");
  } catch (err) {
    console.error("❌ Error detail:", err.response?.data || err.message || err);
  }
})();
