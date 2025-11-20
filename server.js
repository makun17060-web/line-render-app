// server.js — LINE Bot + ミニアプリ + /api/products + イプシロン入金通知付き 丸ごと版
//
// 必須 .env：
//   LINE_CHANNEL_ACCESS_TOKEN
//   LINE_CHANNEL_SECRET
//   PORT               （任意。なければ 3000）
//   DATA_DIR           （任意。なければ ./data）
//
// 例）Render の Environment に設定：
//   LINE_CHANNEL_ACCESS_TOKEN=xxxxxxxx
//   LINE_CHANNEL_SECRET=yyyyyyyy
//   DATA_DIR=/opt/render/project/src/data
//
// ------------------------------------------------------------

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");

// ==============================
// 環境変数・基本設定
// ==============================
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

// data ディレクトリを確保
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ログ用ディレクトリ
const LOG_DIR = path.join(DATA_DIR, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ==============================
// LINE SDK 設定
// ==============================
const CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();

if (!CHANNEL_ACCESS_TOKEN || !CHANNEL_SECRET) {
  console.warn("⚠ LINE_CHANNEL_ACCESS_TOKEN または LINE_CHANNEL_SECRET が .env に設定されていません。");
}

const lineConfig = {
  channelAccessToken: CHANNEL_ACCESS_TOKEN,
  channelSecret: CHANNEL_SECRET,
};

const client = new line.Client(lineConfig);

// ==============================
// Express 初期化
// ==============================
const app = express();

// JSON と x-www-form-urlencoded を両方受け取れるようにする
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// public 配下を静的公開（main.html / products.html / confirm.html など）
app.use(express.static(path.join(__dirname, "public")));

// ==============================
// /healthz — 動作確認用
// ==============================
app.get("/healthz", (req, res) => {
  res.json({ ok: true, message: "server is running" });
});

// ==============================
// /api/products — 商品一覧 API
//   フロントの products.js から参照
// ==============================
const PRODUCTS_JSON_PATH = path.join(DATA_DIR, "products.json");

/**
 * 初期サンプル商品（まだファイルがない場合に使用）
 * あなたが見せてくれた /api/products の JSON と同じ構造
 */
const DEFAULT_PRODUCTS = [
  {
    id: "nori-akasha-340",
    name: "のりあかしゃ",
    price: 340,
    stock: 20,
    desc: "海苔の風味豊かなえびせんべい",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763630066677_noriakasya90.png",
  },
  {
    id: "uzu-akasha-340",
    name: "うずあかしゃ",
    price: 340,
    stock: 10,
    desc: "渦を巻いたえびせんべい",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763630098826__.jpg",
  },
  {
    id: "shio-akasha-340",
    name: "潮あかしゃ",
    price: 340,
    stock: 5,
    desc: "えびせんべいにあおさをトッピング",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763629890812_1201_IMG_0076.jpg",
  },
  {
    id: "matsu-akasha-340",
    name: "松あかしゃ",
    price: 340,
    stock: 30,
    desc: "海老をたっぷり使用した高級えびせんべい",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763629852939_2_000000000002.png",
  },
  {
    id: "iso-akasha-340",
    name: "磯あかしゃ",
    price: 340,
    stock: 30,
    desc: "海老せんべいに高級海苔をトッピング",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763630126240__.jpg",
  },
  {
    id: "goma-akasha-340",
    name: "ごまあかしゃ",
    price: 340,
    stock: 30,
    desc: "海老せんべいに風味豊かなごまをトッピング",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763630167633__.jpg",
  },
  {
    id: "original-set-2000",
    name: "磯屋オリジナルセット",
    price: 2000,
    stock: 30,
    desc: "6袋をセットにしたオリジナル",
    image: "https://line-render-app-1.onrender.com/public/uploads/1763630037931_akashi_item.jpg",
  },
];

/**
 * 商品一覧を読み込む（ファイルがなければ DEFAULT_PRODUCTS を返す）
 */
function loadProducts() {
  try {
    if (fs.existsSync(PRODUCTS_JSON_PATH)) {
      const text = fs.readFileSync(PRODUCTS_JSON_PATH, "utf8");
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        // 古い形式（配列だけ）にも対応
        return json;
      }
      if (json && Array.isArray(json.products)) {
        return json.products;
      }
    }
  } catch (e) {
    console.error("商品ファイル読み込みエラー:", e);
  }
  return DEFAULT_PRODUCTS;
}

/**
 * 商品一覧を保存する（管理画面などから更新したい場合）
 */
function saveProducts(products) {
  const data = { products };
  fs.writeFileSync(PRODUCTS_JSON_PATH, JSON.stringify(data, null, 2), "utf8");
}

app.get("/api/products", (req, res) => {
  const products = loadProducts();
  res.json({ ok: true, products });
});

// 必要であれば管理画面向けの更新 API もここで定義可能
// app.post("/api/admin/products", (req, res) => { ... });

// ==============================
// LINE Webhook — 最低限のオウム返し
// （あなたの既存のロジックに差し替え可能）
// ==============================
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    const results = await Promise.all(
      events.map(async (event) => {
        // メッセージイベントだけ簡単にオウム返し
        if (event.type === "message" && event.message.type === "text") {
          const userMessage = event.message.text;
          return client.replyMessage(event.replyToken, {
            type: "text",
            text: `「${userMessage}」を受け取りました。`,
          });
        }
        // それ以外はスキップ
        return Promise.resolve(null);
      })
    );
    res.json({ ok: true, results });
  } catch (err) {
    console.error("Webhook エラー:", err?.response?.data || err);
    res.status(500).end();
  }
});

// ==============================
// イプシロン：コンビニ・ペイジー入金通知 受信API
// ==============================
app.post("/api/epsilon/notify", async (req, res) => {
  try {
    const data = req.body || {};

    // Epsilon が期待している「OK」をすぐ返す（重要）
    res.send("OK");

    // ==== ログとして保存 ====
    const logLine = `[${new Date().toISOString()}] EpsilonNotify ${JSON.stringify(
      data
    )}\n`;
    fs.appendFile(
      path.join(LOG_DIR, "epsilon_notify.log"),
      logLine,
      (err) => {
        if (err) console.error("epsilon_notify.log 書き込みエラー:", err);
      }
    );

    // ==== 必要な項目を取り出す（項目名はイプシロン仕様書に合わせて調整してください）====
    const orderNumber = data.order_number || data.order_no || "";
    const payMethod = data.pay_method || ""; // コンビニ / ペイジー など
    const state = data.state || data.pay_status || ""; // 入金状態（値は仕様書で要確認）
    // ★ memo1 に LINEの userId を送っている前提
    const userId = data.memo1 || data.user_id || "";

    console.log("=== Epsilon 入金通知受信 ===");
    console.log("orderNumber:", orderNumber);
    console.log("payMethod  :", payMethod);
    console.log("state      :", state);
    console.log("userId     :", userId);

    // 例）state が「入金完了」を意味する値のときにだけ処理する
    // ※ 実際の値（'paid', '2' など）はイプシロンの仕様書を確認して調整してください
    const isPaid = state === "2" || state === "paid";

    if (isPaid && userId) {
      // ===== LINE に「ご入金ありがとうございます」メッセージを送る例 =====
      const message = {
        type: "text",
        text:
          "コンビニ・ペイジーでのご入金を確認しました。\n" +
          (orderNumber ? `ご注文番号：${orderNumber}\n` : "") +
          "\n商品の発送準備に入らせていただきます。\n今しばらくお待ちください。",
      };

      try {
        await client.pushMessage(userId, message);
        console.log("入金確認メッセージ送信OK →", userId);
      } catch (e) {
        console.error(
          "入金確認メッセージ送信エラー:",
          e?.response?.data || e
        );
      }
    } else {
      console.log(
        "入金完了状態ではないか、userId が不明のため LINE送信はスキップ"
      );
    }
  } catch (err) {
    console.error("Epsilon notify ハンドラでエラー:", err);
    // res はすでに send 済みなので何もしなくてOK
  }
});

// ==============================
// サーバー起動
// ==============================
app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`   DATA_DIR = ${DATA_DIR}`);
});
