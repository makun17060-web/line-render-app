"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LIFF_ID_MINIAPP,
  RICHMENU_IMAGE,
  PUBLIC_BASE_URL,

  PRODUCTS_URL,
  HOWTO_URL,
  SHIPPING_URL,

  ADDRESS_LIFF_ID,
  ADDRESS_LIFF_URL,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN がありません");
  process.exit(1);
}
if (!LIFF_ID_MINIAPP) {
  console.error("❌ LIFF_ID_MINIAPP（注文LIFF ID）がありません");
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

// 画像 左上：ご注文はこちら（注文LIFF）
const ORDER_LIFF_URL = `https://liff.line.me/${LIFF_ID_MINIAPP}`;

// 画像 左下：住所登録（住所登録LIFF）
let addressLiffUrl = (ADDRESS_LIFF_URL || "").trim();
if (!addressLiffUrl) {
  if (ADDRESS_LIFF_ID) addressLiffUrl = `https://liff.line.me/${LIFF_ID}`;
  else addressLiffUrl = `${baseUrl}/public/cod-register.html`; // 最終手段
}

// 画像 中央上：商品一覧
const productsUrl = (PRODUCTS_URL || `${baseUrl}/public/shop.html`).trim();

// 画像 右上：ご利用方法
const howtoUrl = (HOWTO_URL || `${baseUrl}/public/howto.html`).trim();

// 画像 中央下：配送・送料
const shippingUrl = (SHIPPING_URL || `${baseUrl}/public/shipping.html`).trim();

(async () => {
  try {
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_3x2_6areas",
      chatBarText: "メニュー",
      areas: [
        // 1行目
        { // 左上：ご注文はこちら
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご注文はこちら", uri: ORDER_LIFF_URL },
        },
       { // 中央上：商品一覧
  bounds: { x: 833, y: 0, width: 834, height: 843 },
  action: { type: "uri", label: "商品一覧", uri: "https://isoya-shop.com"},
},

        { // 右上：ご利用方法
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご利用方法", uri: "https://liff.line.me/2008406620-QQFfWP1w"},
        },

        // 2行目
        { // 左下：住所登録
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: { type: "message", label: "住所登録", text:  "直接注文"},
        },
        { // 中央下：配送・送料
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: "uri", label: "配送・送料", uri: "https://line-render-app-1.onrender.com/public/shipping-calc.html"},
        },
        { // 右下：お問い合わせ（LINEで質問）
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: "message", label: "お問い合わせ", text: "問い合わせ" },
        },
      ],
    };

    console.log("=== createRichMenu start ===");
    console.log("BASE:", baseUrl);
    console.log("ORDER(LIFF):", ORDER_LIFF_URL);
    console.log("PRODUCTS:", productsUrl);
    console.log("HOWTO:", howtoUrl);
    console.log("ADDRESS:", addressLiffUrl);
    console.log("SHIPPING:", shippingUrl);

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
