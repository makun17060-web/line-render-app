// createRichMenu_6areas.js
// 3列×2段リッチメニュー(2500x1686 / 6分割)
//
// 左上：問い合わせ（メッセージ）
// 左下：オンライン注文（LIFFミニアプリ products.html）
// 中央上：電話注文（電話発信：+1 747-946-7151）
// 中央下：住所登録（住所登録用 LIFF または cod-register.html）
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
  LIFF_ID_MINIAPP,
  SURVEY_URL,           // いまは未使用（残しておいてOK）
  MEMBER_URL,           // いまは未使用（残しておいてOK）
  RICHMENU_IMAGE,
  PUBLIC_BASE_URL,
  ADDRESS_REGISTER_URL, // 住所登録ページ用（任意・フォールバック）
  EC_SHOP_URL,          // ★ ECショップ本番URL（MakeShop 等）
  LIFF_ID_ADDRESS,      // ★ 住所登録用 LIFF ID（任意）
  ADDRESS_LIFF_URL,
    } = process.env;

// ===== 必須チェック =====
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET がありません");
  process.exit(1);
}
if (!LIFF_ID_MINIAPP) {
  console.error("❌ LIFF_ID_MINIAPP（ミニアプリ用LIFF ID）がありません");
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

// products.html（①商品選択）の実URL（ログ用）
const PRODUCTS_URL = `${baseUrl}/public/products.html`;

// ✅ LIFFで products.html を開く（redirect + キャッシュ無視 v=）
const CACHE_BUSTER = "20251123_1"; 
// ↑ 反映が怪しい時は数字を変えて再実行してください

const MINIAPP_LIFF_URL =
  `https://liff.line.me/${LIFF_ID_MINIAPP}?redirect=${encodeURIComponent(
    `/public/products.html?v=${CACHE_BUSTER}`
  )}`;

// ★ 住所登録ページURL（フォールバック）
//   - 通常は baseUrl/public/cod-register.html にしておく
//   - もし電話専用サーバーが別ドメインなら ADDRESS_REGISTER_URL にフルURLを入れて上書き
const addressRegisterUrl = (ADDRESS_REGISTER_URL || `${baseUrl}/public/cod-register.html`).trim();

// ★ 住所登録用 LIFF URL
//   - LIFF_ID_ADDRESS が設定されていれば、LIFF で開く
//   - 未設定なら、従来どおり addressRegisterUrl へ直接飛ぶ
const ADDRESS_LIFF_URL = LIFF_ID_ADDRESS
  ? `https://liff.line.me/${LIFF_ID_ADDRESS}`
  : addressRegisterUrl;

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
            uri: PHONE_ORDER_TEL, // ← 電話アプリを起動
          },
        },
        // 右上：ECショップ（URI）
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: {
            type: "uri",
            label: "ECショップ",
            uri: ecShopUrl,
          },
        },

        // --- 2行目 ---
        // 左下：オンライン注文（LIFFミニアプリ）
        {
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: {
            type: "uri",
            label: "オンライン注文",
            uri: MINIAPP_LIFF_URL,
          },
        },
        // 中央下：住所登録（住所登録用 LIFF or cod-register.html）
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: {
            type: "uri",
            label: "住所登録",
            uri: ADDRESS_LIFF_URL ||
               `https://liff.line.me/${LIFF_ID_MINIAPP}?redirect=${encodeURIComponent(
        "/public/cod-register.html"
             )}`,   
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
    console.log("PRODUCTS_URL:", PRODUCTS_URL);
    console.log("ONLINE→LIFF:", MINIAPP_LIFF_URL);
    console.log("ADDRESS_REGISTER_URL:", addressRegisterUrl);
    console.log("ADDRESS_LIFF_URL:", ADDRESS_LIFF_URL);
    console.log("EC_SHOP_URL:", ecShopUrl);
    console.log("PHONE_ORDER_TEL:", PHONE_ORDER_TEL);

    // 1) リッチメニュー作成
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ richMenuId:", richMenuId);

    // 2) 画像アップロード（publicから読む）
    //    6分割用の画像ファイル名に変更してください
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
    console.log("   左上：問い合わせ / 左下：オンライン注文（LIFF） / 中央上：電話注文（+1 747-946-7151）");
    console.log("   中央下：住所登録（LIFF or cod-register） / 右上：ECショップ / 右下：直接注文");

  } catch (e) {
    console.error("❌ Error:", e?.message);
    console.error("STATUS:", e.statusCode || e.response?.status);
    console.error("DATA:", e.response?.data);
    process.exit(1);
  }
})();
