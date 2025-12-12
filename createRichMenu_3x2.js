// createRichMenu_6areas.js
// 3列×2段リッチメニュー(2500x1686 / 6分割)
//
// 左上：問い合わせ（メッセージ）
// 左下：オンライン注文（LIFF ミニアプリ：products.html 用 LIFF）
// 中央上：電話注文（電話発信：+1 747-946-7151）
// 中央下：住所登録（住所登録専用 LIFF：cod-register.html）
// 右上：ECショップ（URI：ECショップ本番URL）
// 右下：直接注文（メッセージ）

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  LIFF_ID_MINIAPP,     // オンライン注文用 LIFF ID
  SURVEY_URL,          // いまは未使用（残しておいてOK）
  MEMBER_URL,          // いまは未使用（残しておいてOK）
  RICHMENU_IMAGE,
  PUBLIC_BASE_URL,
  EC_SHOP_URL,         // ★ ECショップ本番URL（MakeShop 等）
  ADDRESS_LIFF_ID,     // ★ 住所登録用 LIFF ID（新規）
  ADDRESS_LIFF_URL,    // ★ 住所登録用 LIFF URL（任意・優先）
} = process.env;

// ===== 必須チェック =====
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET がありません");
  process.exit(1);
}
if (!LIFF_ID_MINIAPP) {
  console.error("❌ LIFF_ID_MINIAPP（オンライン注文用 LIFF ID）がありません");
  process.exit(1);
}

const client = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// ===== URL整形（末尾の / . 空白 を除去）=====
const sanitizeBase = (u) =>
  String(u || "")
    .trim()
    .replace(/[\/\.\s]+$/, "");

// Renderの公開URL（envなければ既定値）
const baseUrl = sanitizeBase(
  PUBLIC_BASE_URL || "https://line-render-app-1.onrender.com"
);

// ★ オンライン注文（ミニアプリ）用 LIFF URL
//   - LIFF の Endpoint URL を products.html にしている前提
//   - 特別な redirect は付けず、シンプルに liff.line.me/LIFF_ID
const MINIAPP_LIFF_URL = `https://liff.line.me/${LIFF_ID_MINIAPP}`;

// ★ 住所登録用 LIFF URL
//   - 優先：ADDRESS_LIFF_URL があればそれを使う
//   - なければ ADDRESS_LIFF_ID から https://liff.line.me/ID を組み立てる
//   - それも無ければ最終手段として /public/cod-register.html に直リンク
let addressLiffUrl = (ADDRESS_LIFF_URL || "").trim();
if (!addressLiffUrl) {
  if (ADDRESS_LIFF_ID) {
    addressLiffUrl = `https://liff.line.me/${ADDRESS_LIFF_ID}`;
  } else {
    addressLiffUrl = `${baseUrl}/public/cod-register.html`;
  }
}

// ★ ECショップURL
//   - MakeShop 等の本番ショップURLを EC_SHOP_URL に入れてください
//   - 未設定の場合はいったん baseUrl を使う（要あとで修正）
const ecShopUrl = (EC_SHOP_URL || baseUrl).trim();

// ★ 電話注文用の発信先（Twilio US番号）
const PHONE_ORDER_TEL = "tel:+17479467151"; // +1 747-946-7151

(async () => {
  try {
    // ==== 6分割用リッチメニュー定義 ====
    // 2500 x 1686 を 3列×2段に分割
    // 幅：833 / 834 / 833，高さ：843 / 843
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_3x2_6areas",
      chatBarText: "メニュー",
      areas: [
        // --- 1行目 ---
        // 左上：問い合わせ（メッセージ）
        {
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: {
            type: "message",
            label: "問い合わせ",
            text: "問い合わせ",
          },
        },
        // 中央上：電話注文（電話発信：+1 747-946-7151）
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: {
            type: "message",
            text: "電話注文",
            uri: PHONE_ORDER_TEL,
          },
        },
        // 右上：ECショップ（URI）
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: {
            type: "uri",
            label: "ECショップ",
            uri: "https://isoya-shop.com",
          },
        },

        // --- 2行目 ---
        // 左下：オンライン注文（オンライン注文 LIFF）
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: {
            type: "uri",
            label: "オンライン注文",
            uri: MINIAPP_LIFF_URL,
          },
        },
        // 中央下：住所登録（住所登録専用 LIFF）
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: {
            type: "message",
            label: "ただいま準備中です",
            text: "ただいま準備中です",
          },
        },
        // 右下：直接注文（メッセージ）
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: {
            type: "message",
            label: "直接注文",
            text: "直接注文",
          },
        },
      ],
    };

    console.log("=== createRichMenu(6 areas) start ===");
    console.log("BASE URL:", baseUrl);
    console.log("ONLINE(LIFF):", MINIAPP_LIFF_URL);
    console.log("ADDRESS(LIFF):", addressLiffUrl);
    console.log("EC_SHOP_URL:", ecShopUrl);
    console.log("PHONE_ORDER_TEL:", PHONE_ORDER_TEL);

    // 1) リッチメニュー作成
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ richMenuId:", richMenuId);

    // 2) 画像アップロード（publicから読む）
    const imageFile = (RICHMENU_IMAGE || "richmenu_6_2500x1686.jpg").trim();
    const imagePath = path.join(__dirname, "public", imageFile);

    if (!fs.existsSync(imagePath)) {
      console.error("❌ 画像ファイルが見つかりません:", imagePath);
      process.exit(1);
    }

    const stat = fs.statSync(imagePath);
    const kb = stat.size / 1024;
    console.log("IMAGE FILE:", imageFile);
    console.log("IMAGE SIZE:", kb.toFixed(1), "KB");
    if (stat.size > 1024 * 1024) {
      console.error("❌ 画像が1MB超えです。JPEG圧縮(q60など)にして下さい。");
      process.exit(1);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imageFile).toLowerCase();
    const contentType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
        ? "image/png"
        : "image/png";

    await client.setRichMenuImage(richMenuId, imageBuffer, contentType);
    console.log("✅ setRichMenuImage OK");

    // 3) デフォルト設定
    await client.setDefaultRichMenu(richMenuId);
    console.log("✅ setDefaultRichMenu OK");

    console.log("🎉 完了！6分割リッチメニューをデフォルトに設定しました。");
    console.log("   左上：問い合わせ / 左下：オンライン注文(LIFF_MINIAPP)");
    console.log("   中央上：電話注文 / 中央下：住所登録(ADDRESS_LIFF)");
    console.log("   右上：ECショップ / 右下：直接注文");

  } catch (e) {
    console.error("❌ Error:", e?.message);
    console.error("STATUS:", e.statusCode || e.response?.status);
    console.error("DATA:", e.response?.data);
    process.exit(1);
  }
})();
