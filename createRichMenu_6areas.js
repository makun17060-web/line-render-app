"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  PUBLIC_BASE_URL,
  RICHMENU_IMAGE,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN がありません");
  process.exit(1);
}

const client = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const sanitizeBase = (u) =>
  String(u || "")
    .trim()
    .replace(/[\/\.\s]+$/, "");

const baseUrl = sanitizeBase(PUBLIC_BASE_URL || "https://line-render-app-1.onrender.com");

(async () => {
  try {
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_3x2_6areas",
      chatBarText: "メニュー",
      areas: [
        // 1行目
        {
          // 左上：ご注文はこちら（※URIで注文LIFFを開く運用）
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご注文はこちら", uri: "https://liff.line.me/2008406620-8CWfgEKh" },
        },
        {
          // 中央上：ECショップ
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: "uri", label: "ECショップ", uri: "https://isoya-shop.com" },
        },
        {
          // 右上：ご利用方法
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご利用方法", uri: "https://liff.line.me/2008406620-QQFfWP1w" },
        },

        // 2行目
        {
          // 左下：店頭受取（postback）
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: { type: "postback", data: "action=pickup_start", displayText: "店頭受取" },
        },
        {
          // 中央下：配送・送料
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: "uri", label: "配送・送料", uri: `${baseUrl}/public/shipping-calc.html` },
        },
        {
          // 右下：お問い合わせ
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: "uri", label: "お問い合わせ", uri: "https://liff.line.me/2008406620-LUJ3dURd" },
        },

        // --- もし「左上をURIではなくポストバックで bot を動かしたい」なら、
        // 上の左上エリアを下に差し替え（uri→postback）してください：
        // {
        //   bounds: { x: 0, y: 0, width: 833, height: 843 },
        //   action: { type: "postback", data: "action=direct_order", displayText: "直接注文" },
        // },
      ],
    };

    console.log("=== createRichMenu start ===");
    console.log("BASE:", baseUrl);

    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ richMenuId:", richMenuId);

    const imageFile = (RICHMENU_IMAGE || "createRichMenu_6areas.jpg").trim();
    const imagePath = path.join(__dirname, "public", imageFile);

    if (!fs.existsSync(imagePath)) {
      console.error("❌ 画像ファイルが見つかりません:", imagePath);
      process.exit(1);
    }

    const stat = fs.statSync(imagePath);
    if (stat.size > 1024 * 1024) {
      console.error("❌ 画像が1MB超えです。PNG最適化 or JPEG圧縮して下さい。");
      process.exit(1);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imageFile).toLowerCase();
    const contentType = (ext === ".jpg" || ext === ".jpeg") ? "image/jpeg" : "image/png";

    await client.setRichMenuImage(richMenuId, imageBuffer, contentType);
    console.log("✅ setRichMenuImage OK");

    await client.setDefaultRichMenu(richMenuId);
    console.log("✅ setDefaultRichMenu OK");
    console.log("🎉 完了！");
  } catch (e) {
    console.error("❌ Error:", e?.message);
    console.error("STATUS:", e.statusCode || e.response?.status);
    console.error("DATA:", e.response?.data);
    process.exit(1);
  }
})();
