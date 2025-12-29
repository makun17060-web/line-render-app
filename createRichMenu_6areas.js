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
  CONTACT_URL,
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

// 左上：ご注文はこちら（LIFFを開く）
const ORDER_LIFF_URL = `https://liff.line.me/${LIFF_ID_MINIAPP}`;

// 中央上：商品一覧
const productsUrl = String(PRODUCTS_URL || `${baseUrl}/public/shop.html`).trim();

// 右上：ご利用方法
const howtoUrl = String(HOWTO_URL || `${baseUrl}/public/howto.html`).trim();

// 中央下：配送・送料
const shippingUrl = String(SHIPPING_URL || `${baseUrl}/public/shipping-calc.html`).trim();

// 右下：お問い合わせ
const contactUrl = String(CONTACT_URL || `${baseUrl}/public/contact.html`).trim();

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
          bounds: { x: 0, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご注文はこちら", uri: ORDER_LIFF_URL },
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 843 },
          action: { type: "uri", label: "商品一覧", uri: productsUrl },
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 843 },
          action: { type: "uri", label: "ご利用方法", uri: howtoUrl },
        },

        // 2行目
        {
          // ✅ 左下：直接注文（ポストバックで開始）
          bounds: { x: 0, y: 843, width: 833, height: 843 },
          action: {
            type: "postback",
            label: "直接注文",
            data: "start_order",
            displayText: "直接注文",
          },
        },
        {
          bounds: { x: 833, y: 843, width: 834, height: 843 },
          action: { type: "uri", label: "配送・送料", uri: shippingUrl },
        },
        {
          bounds: { x: 1667, y: 843, width: 833, height: 843 },
          action: { type: "uri", label: "お問い合わせ", uri: contactUrl },
        },
      ],
    };

    console.log("=== createRichMenu start ===");
    console.log("BASE:", baseUrl);
    console.log("ORDER(LIFF):", ORDER_LIFF_URL);
    console.log("PRODUCTS:", productsUrl);
    console.log("HOWTO:", howtoUrl);
    console.log("SHIPPING:", shippingUrl);
    console.log("CONTACT:", contactUrl);

    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ richMenuId:", richMenuId);

    const imageFile = String(RICHMENU_IMAGE || "createRichMenu_6areas.jpg").trim();
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
    const contentType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

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
