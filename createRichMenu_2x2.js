// createRichMenu_2x2.js — 磯屋 2段2列リッチメニュー（2500x1686）
// 左上=アンケート（いまは「アンケート」というメッセージ送信）
// 右上=直接注文（メッセージ）
// 左下=オンライン注文（ミニアプリ miniapp-delivery.html）
// 右下=会員登録（https://isoya-shop.com）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { Readable } = require("stream");

// ========= 環境変数 =========
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
if (!CHANNEL_ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN がありません");
  process.exit(1);
}

// LIFF_URL は今は使いませんが、後でLIFFアンケートを作るとき用に残しておきます
const LIFF_URL =
  (process.env.LIFF_URL || "").trim() || "https://liff.line.me/xxxxxxxx";

// オンライン注文 → ミニアプリ（配送付き）のトップページ
const ONLINE_ORDER_URL =　"https://line-render-app-1.onrender.com/public/miniapp-delivery.html";

// 会員登録 → isoya-shop.com
const MEMBER_URL = "https://isoya-shop.com";

// public 内に置いた画像を読む
const INPUT_FILE = path.join(__dirname, "public", "richmenu_2x2_2500x1686.png");

// ========= LINE クライアント =========
const client = new line.Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ========= メイン処理 =========
async function main() {
  try {
    // 1. リッチメニュー本体
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_2x2_メニュー",
      chatBarText: "メニューを開く",
      areas: [
        // 左上：アンケート（今はメッセージ送信にしてエラー回避）
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: {
            type: "message",
            label: "アンケート",
            text: "アンケート",
          },
        },
        // 右上：直接注文（テキスト送信）
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: {
            type: "message",
            label: "直接注文",
            text: "直接注文",
          },
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

    // 2. 画像の読み込み確認
    if (!fs.existsSync(INPUT_FILE)) {
      console.error("❌ ERROR: 画像が見つかりません:", INPUT_FILE);
      console.error("public フォルダ内に richmenu_2x2_2500x1686.png を置いてください");
      process.exit(1);
    }

    console.log("画像を処理中:", INPUT_FILE);

    // 413対策：JPEG化 + quality指定で容量を落とす
    const buf = await sharp(INPUT_FILE)
      .resize(2500, 1686)
      .jpeg({ quality: 80 }) // 必要なら 70 や 60 に下げる
      .toBuffer();

    console.log("変換後のバイト数:", buf.length);

    const stream = Readable.from(buf);

    await client.setRichMenuImage(richMenuId, stream, "image/jpeg");
    console.log("✔ 画像アップロード完了");

    // 3. デフォルトリッチメニューに設定
    await client.setDefaultRichMenu(richMenuId);
    console.log("🎉 完了！リッチメニューが適用されました！");
  } catch (err) {
    console.error("❌ エラー:", err.response?.data || err.message || err);
  }
}

main();
