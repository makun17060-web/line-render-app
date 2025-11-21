cat > createRichMenu_2x2.js <<'JS'
// createRichMenu_2x2.js
// 2段2列リッチメニュー(2500x1686)
// 左上=アンケート / 右上=直接注文 / 左下=オンライン注文(ミニアプリLIFFへ) / 右下=会員ログイン

"use strict";

require("dotenv").config();
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");

const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  LIFF_ID_MINIAPP,
  SURVEY_URL,
  DIRECT_ORDER_URL,
  MEMBER_URL,
  RICHMENU_IMAGE,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("❌ LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が .env にありません");
  process.exit(1);
}
if (!LIFF_ID_MINIAPP) {
  console.error("❌ LIFF_ID_MINIAPP（ミニアプリ用 LIFF ID）が .env にありません");
  process.exit(1);
}

const client = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
});

// オンライン注文 → ミニアプリLIFF URL
const MINIAPP_LIFF_URL = `https://liff.line.me/${LIFF_ID_MINIAPP}?page=delivery`;

// URL（未設定なら仮）
const surveyUrl = (SURVEY_URL || "https://example.com/survey").trim();
const directOrderUrl = (DIRECT_ORDER_URL || "https://example.com/order").trim();
const memberUrl = (MEMBER_URL || "https://example.com/member").trim();

(async () => {
  try {
    const richMenu = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "磯屋_2x2",
      chatBarText: "メニュー",
      areas: [
        // 左上：アンケート
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: "uri", label: "アンケート", uri: surveyUrl },
        },
        // 右上：直接注文
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: "uri", label: "直接注文", uri: directOrderUrl },
        },
        // 左下：オンライン注文（ミニアプリへ）
        {
          bounds: { x: 0, y: 843, width: 1250, height: 843 },
          action: { type: "uri", label: "オンライン注文", uri: MINIAPP_LIFF_URL },
        },
        // 右下：会員ログイン
        {
          bounds: { x: 1250, y: 843, width: 1250, height: 843 },
          action: { type: "uri", label: "会員ログイン", uri: memberUrl },
        },
      ],
    };

    console.log("=== createRichMenu start ===");
    console.log("ONLINE→LIFF:", MINIAPP_LIFF_URL);

    // 1) リッチメニュー作成
    const richMenuId = await client.createRichMenu(richMenu);
    console.log("✅ richMenuId:", richMenuId);

    // 2) 画像アップロード（publicから読む）
    const imageFile = (RICHMENU_IMAGE || "richmenu_2x2_2500x1686.png").trim();
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
      console.error("❌ 画像が1MB超えです。JPEG圧縮(q60など)して再実行してください。");
      process.exit(1);
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const ext = path.extname(imageFile).toLowerCase();
    const contentType =
      ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
      ext === ".png" ? "image/png" :
      "image/png";

    await client.setRichMenuImage(richMenuId, imageBuffer, contentType);
    console.log("✅ setRichMenuImage OK");

    // 3) デフォルト設定
    await client.setDefaultRichMenu(richMenuId);
    console.log("✅ setDefaultRichMenu OK");

    console.log("🎉 完了！オンライン注文→ミニアプリが開きます。");

  } catch (e) {
    console.error("❌ Error:", e?.message);
    console.error("STATUS:", e.statusCode || e.response?.status);
    console.error("DATA:", e.response?.data);
    process.exit(1);
  }
})();
JS
