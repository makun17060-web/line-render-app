// createRichMenu_2x2.js — 磯屋 2段2列リッチメニュー（2500x1686）
// 左上=アンケート / 右上=直接注文 / 左下=オンライン注文（ミニアプリ） / 右下=会員登録（isoya-shop.com）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { Readable } = require("stream");

// ========= 環境変数 =========
// LINE_CHANNEL_ACCESS_TOKEN=xxxxx
// LIFF_URL=アンケート用LIFF URL

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
if (!CHANNEL_ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN が .env にありません。");
  process.exit(1);
}

const LIFF_URL =
  (process.env.LIFF_URL || "").trim() || "https://liff.line.me/xxxxxxxx";

// ★★重要：ここを要望どおりに修正★★

// オンライン注文 → ミニアプリのトップページ
const ONLINE_ORDER_URL =
  "https://line-render-app-1.onrender.com/public/main.html";

// 会員登録 → isoya-shop.com
const MEMBER_URL = "https://isoya-shop.com";

// ★画像名を統一
const INPUT_FILE = path.join(__dirname, "richmenu_2x2_2500x1686.png");

// ========= LINE クライアント =========
const client = new line.Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ========= メイン =========
async function main() {
  try {
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_2x2_メニュー",
      chatBarText: "メニューを開く",
      areas: [
        // 左上：アンケート
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: "uri", label: "アンケート", uri: LIFF_URL },
        },
        // 右上：直接注文
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: "message", label: "直接注文", text: "直接注文" },
        },
        // 左下：オンライン注文（ミニアプリ）
        {
          bounds: { x: 0, y: 843, width: 1250, height: 843 },
          action: {
            type: "uri",
            label: "オンライン注文",
            uri: ONLINE_ORDER_URL,
          },
        },
        // 右下：会員登録（isoya-shop）
        {
          bounds: { x: 1250, y: 843, width: 1250, height: 843 },
          action: {
            type: "uri",
            label: "会員登録",
            uri: MEMBER_URL,
          },
        },
      ],
    };

    console.log("リッチメニューを作成中…");
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✔ richMenuId:", richMenuId);

    // 画像読み込み
    if (!fs.existsSync(INPUT_FILE)) {
      console.error("ERROR: 画像が見つかりません:", INPUT_FILE);
      process.exit(1);
    }
    console.log("画像を処理中…");

    const buf = await sharp(INPUT_FILE).resize(2500, 1686).png().toBuffer();
    const stream = Readable.from(buf);

    await client.setRichMenuImage(richMenuId, stream, "image/png");
    console.log("✔ 画像アップロード完了");

    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 完了しました！ LINE側を確認してください。");
  } catch (err) {
    console.error("❌ エラー:", err.response?.data || err);
  }
}

main();
