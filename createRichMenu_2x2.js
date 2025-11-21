// createRichMenu_2x2.js
// 磯屋 2段2列リッチメニュー（2500x1686）
// 左上=アンケート（テキスト送信）
// 右上=直接注文（テキスト送信）
// 左下=オンライン注文（LIFFミニアプリ）
// 右下=会員ログイン（https://isoya-shop.com）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

// ===== 必要な .env =====
// LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxx
// LIFF_ID=配送付きミニアプリ用の LIFF ID（例 1657xxxxxx-abc123）

const CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const LIFF_ID = (process.env.LIFF_ID || "").trim(); // ★ ミニアプリ用 LIFF ID

if (!CHANNEL_ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN が .env に設定されていません。");
  process.exit(1);
}
if (!LIFF_ID) {
  console.error("ERROR: LIFF_ID が .env に設定されていません。配送ミニアプリ用の LIFF ID を入れてください。");
  process.exit(1);
}

const client = new line.Client({
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
});

// ★ リッチメニュー画像ファイル（2500x1686 PNG）
//   同じフォルダに richmenu_2x2_2500x1686.png を置いてください。
const IMAGE_PATH = path.join(__dirname, "richmenu_2x2_2500x1686.png");

async function main() {
  try {
    if (!fs.existsSync(IMAGE_PATH)) {
      console.error("ERROR: リッチメニュー画像が見つかりません:", IMAGE_PATH);
      console.error("ファイル名や場所を確認してください。");
      process.exit(1);
    }

    // ===== リッチメニュー本体の定義 =====
    const richMenu = {
      size: {
        width: 2500,
        height: 1686, // 2段（843 x 2）
      },
      selected: true,
      name: "Isoya_2x2_menu",
      chatBarText: "メニューを開く",
      areas: [
        // 1段目 左上：アンケート
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: {
            type: "message",
            text: "アンケート", // ← Bot側で「アンケート」テキストをトリガーにしているのでそのまま
          },
        },
        // 1段目 右上：直接注文
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: {
            type: "message",
            text: "直接注文", // ← Bot側で「直接注文」テキストをトリガーにしている
          },
        },
        // 2段目 左下：オンライン注文（ミニアプリ）
        {
          bounds: { x: 0, y: 843, width: 1250, height: 843 },
          action: {
            type: "uri",
            label: "オンライン注文",
            // ★ LIFFミニアプリへ遷移（配送付きミニアプリ用の LIFF）
            uri: `https://liff.line.me/${LIFF_ID}`,
          },
        },
        // 2段目 右下：会員ログイン（isoya-shop.com）
        {
          bounds: { x: 1250, y: 843, width: 1250, height: 843 },
          action: {
            type: "uri",
            label: "会員ログイン",
            uri: "https://isoya-shop.com",
          },
        },
      ],
    };

    console.log("=== リッチメニュー作成 ===");
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("作成された richMenuId:", richMenuId);

    console.log("=== リッチメニュー画像アップロード ===");
    const stream = fs.createReadStream(IMAGE_PATH);
    await client.setRichMenuImage(richMenuId, stream);
    console.log("画像アップロード完了");

    console.log("=== デフォルトリッチメニューに設定 ===");
    await client.setDefaultRichMenu(richMenuId);
    console.log("デフォルトリッチメニューに設定しました:", richMenuId);

    console.log("✅ 完了しました！");
    console.log(" - 左上：アンケート（テキスト「アンケート」送信）");
    console.log(" - 右上：直接注文（テキスト「直接注文」送信）");
    console.log(` - 左下：オンライン注文（https://liff.line.me/${LIFF_ID}）`);
    console.log(" - 右下：会員ログイン（https://isoya-shop.com）");
  } catch (e) {
    console.error("リッチメニュー作成中にエラーが発生しました:", e?.response?.data || e);
    process.exit(1);
  }
}

main();
