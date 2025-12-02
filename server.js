// server.js — フル機能版（Stripe + ミニアプリ + 画像管理)
// + Flex配信
// + 「その他＝価格入力なし」
// + 久助専用テキスト購入フロー
// + 予約者連絡API/コマンド（テキスト＆管理API）
// + 店頭受取 Fix（店頭=現金のみ）
// + 銀行振込案内（コメント対応）
// + 画像アップロード/一覧/削除 + 商品へ画像URL紐付け
// + ミニアプリ用 /api/products（久助除外）
// + ミニアプリ用 /api/shipping（住所から地域判定して送料）
// + LIFF 住所保存/取得 API（/api/liff/address, /api/liff/address/me, /api/liff/config）
// + Stripe決済 /api/pay-stripe（Checkout Session）
// + 決済完了通知 /api/order/complete（★ 管理者 & 注文者 両方へ通知）
// + 汎用 Health チェック

"use strict";

require("dotenv").config();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
// ★ 電話会話用の簡易メモリ（CallSidごとに会話履歴を保持）
const PHONE_CONVERSATIONS = {};

/**
 * 電話用に OpenAI へ問い合わせて、丁寧な日本語で返答してもらう
 * @param {string} callSid TwilioのCallSid
 * @param {string} userText ユーザーが話した内容（TwilioのSpeechResult）
 * @returns {Promise<string>} 電話で読み上げる日本語テキスト
 */
async function askOpenAIForPhone(callSid, userText) {
  if (!OPENAI_API_KEY) {
    console.warn("⚠ OPENAI_API_KEY が設定されていません。");
    return "申し訳ありません。現在AIによる自動応答が利用できません。LINEやメッセージからお問い合わせください。";
  }

  // 会話履歴がなければ初期化
  if (!PHONE_CONVERSATIONS[callSid]) {
    PHONE_CONVERSATIONS[callSid] = [
  {
    role: "system",
    content: `
あなたは「手造りえびせんべい磯屋」の電話自動応答AIです。

【基本方針】
・電話はすべて「丁寧な敬語」で話します。
・返答は長くなりすぎないよう「2〜3文以内」にします。
・分かりやすく、ゆっくり話すことを意識した文章にします。
・店舗の正確な情報をもとに案内し、嘘の情報は絶対に作らないでください。
・不明点がある場合は「LINE公式アカウントからお問い合わせください」と案内します。

【役割】
・営業時間、店舗場所、駐車場、商品、価格、久助、オンライン注文、送料など、
  よくある質問にやさしく答えます。
・在庫の問い合わせ（特に久助）は、日によって変動するため、
  必ず「在庫はLINEでご案内しています」と誘導します。
・クレーム、特殊な問い合わせ、大量注文は LINE へ誘導します。

【営業時間】
・営業時間：　〇〇時〜〇〇時（必要なら更新します）
・店休日：　　不定休
・営業状況は変動する可能性があるため、
  「最新の営業状況は LINE でご案内しています」と添えても構いません。

【店舗場所】
・愛知県美浜町です。
・詳しい場所は LINE の地図リンクでご案内しています。
・必要に応じて「LINE のトークで地図をお送りします」と返答します。

【商品と価格】
・久助：250円
・四角のりせん：300円
・プレミアムえびせん：400円
・その他の商品について聞かれた場合は、無理に作らず LINE に誘導します。

【在庫について】
・久助や各商品の在庫は日によって変わります。
・必ず以下のように案内してください。
「在庫は日によって変わりますので、LINE のトークからお問い合わせいただくと確実です。」

【送料（ざっくり版）】
以下の文章をベースに、自然に案内してください。
「発送の送料は、お届け先の地域によって異なります。
 関東・中部・近畿は九百六十円、
 東北と中国が千七十円、
 四国が千百八十円、
 九州が千百九十円です。
 北海道は千五百六十円、沖縄は千八百四十円となっております。
 正確な金額は、LINE のオンライン注文画面で自動計算されますので、そちらでご確認いただけます。」

【オンライン注文】
・LINEミニアプリで購入できます。
・住所を入力すると送料が自動計算されます。
・代引き手数料は330円です。
・不明点は LINE へ誘導します。

【店頭受取】
・店頭受取は送料がかかりません。
・お支払いは現金のみです。

【終了判定】
・お客さまが「もう大丈夫です」「ありがとう」「失礼します」などと言ったら、
  下記のように返して通話を終了してください。
「ご利用ありがとうございました。それでは失礼いたします。」

【禁止事項】
・営業時間や住所、商品を勝手に創作しない。
・在庫や当日の情報を推測で答えない。
・金額や送料を不正確に言わない。
・長文になりすぎないようにする。

以上のルールに基づき、
電話に出たオペレーターとして、丁寧で簡潔に日本語で返答してください。
`
  }
];

  }

  const history = PHONE_CONVERSATIONS[callSid];
  history.push({ role: "user", content: userText });

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // 安くて速いモデル
        messages: history,
        max_tokens: 200,
        temperature: 0.7
      })
    });

    const data = await resp.json();
    const aiText =
      data?.choices?.[0]?.message?.content ||
      "すみません。うまくお答えできませんでした。";

    history.push({ role: "assistant", content: aiText });

    // Twilio の TTS が読みやすいように、改行をスペースに
    return aiText.replace(/\s+/g, " ");
  } catch (e) {
    console.error("OpenAI phone error:", e);
    return "申し訳ありません。システムエラーのため、今はAI応答ができません。LINEのトークからお問い合わせください。";
  }
}

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const multer = require("multer");
const stripeLib = require("stripe");
const twilio = require("twilio"); // ★ Twilio を追加

// ★ STRIPE_SECRET_KEY があれば優先、なければ STRIPE_SECRET を使う
const stripeSecretKey = (
  process.env.STRIPE_SECRET_KEY ||
  process.env.STRIPE_SECRET ||
  ""
).trim();

const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;

if (!stripe) {
  console.warn(
    "⚠️ STRIPE_SECRET_KEY / STRIPE_SECRET が設定されていません。/api/pay-stripe はエラーになります。"
  );
}

const app = express();

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "2008406620-G5j1gjzM").trim();
// ★ 直接注文の住所入力専用 LIFF（未設定なら LIFF_ID を流用）
const LIFF_ID_DIRECT_ADDRESS = (process.env.LIFF_ID_DIRECT_ADDRESS || LIFF_ID).trim();

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim(); // 互換（クエリ ?code= でも可）

// ★ 銀行振込案内（任意）
const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();

// ★ 公開URL（Renderのhttpsドメインを .env で指定推奨）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

// LINE config
const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (
  !config.channelAccessToken ||
  !config.channelSecret ||
  !LIFF_ID ||
  (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)
) {
  console.error(
    `ERROR: .env の必須値が不足しています。
  - LINE_CHANNEL_ACCESS_TOKEN
  - LINE_CHANNEL_SECRET
  - LIFF_ID
  - （ADMIN_API_TOKEN または ADMIN_CODE のどちらか）`
  );
  process.exit(1);
}

// ====== パス定義 ======
const DATA_DIR = path.join(__dirname, "data");

// ログ/JSON
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DATA_DIR, "reservations.log");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");
const SURVEYS_LOG = path.join(DATA_DIR, "surveys.log");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DATA_DIR, "stock.log");

// 公開静的/アップロード
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

// ====== ディレクトリ自動作成 ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`📁 Created: ${UPLOAD_DIR}`);
}

// ====== ミドルウェア ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(PUBLIC_DIR));

// 決済完了/失敗ページ
app.all("/public/confirm-card-success.html", (req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, "confirm-card-success.html"));
});
app.all("/public/confirm-fail.html", (req, res) => {
  return res.sendFile(path.join(PUBLIC_DIR, "confirm-fail.html"));
});

// ルート
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== データ初期化 ======
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    {
      id: "kusuke-250",
      name: "久助（えびせん）",
      price: 250,
      stock: 20,
      desc: "お得な割れせん。",
      image: "",
    },
    {
      id: "nori-square-300",
      name: "四角のりせん",
      price: 300,
      stock: 10,
      desc: "のり香る角せん。",
      image: "",
    },
    {
      id: "premium-ebi-400",
      name: "プレミアムえびせん",
      price: 400,
      stock: 5,
      desc: "贅沢な旨み。",
      image: "",
    },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}
if (!fs.existsSync(ADDRESSES_PATH))
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(SESSIONS_PATH))
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify({}, null, 2), "utf8");
if (!fs.existsSync(NOTIFY_STATE_PATH))
  fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify({}, null, 2), "utf8");

// ====== ユーティリティ ======
const safeReadJSON = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};
const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (data) =>
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(data, null, 2), "utf8");
const readAddresses = () => safeReadJSON(ADDRESSES_PATH, {});
const writeAddresses = (data) =>
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(data, null, 2), "utf8");
const readSessions = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions = (s) =>
  fs.writeFileSync(SESSIONS_PATH, JSON.stringify(s, null, 2), "utf8");
const readNotifyState = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (s) =>
  fs.writeFileSync(NOTIFY_STATE_PATH, JSON.stringify(s, null, 2), "utf8");

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;
const qstr = (obj) =>
  Object.entries(obj)
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(
          v === undefined || v === null ? "" : v
        )}`
    )
    .join("&");

const parse = (data) => {
  const s = data && data.includes("=") ? data : "";
  const o = {};
  s.split("&").forEach((kv) => {
    const [k, v] = kv.split("=");
    if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  return o;
};
const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

// ====== 在庫ユーティリティ ======
const LOW_STOCK_THRESHOLD = 5; // しきい値
const PRODUCT_ALIASES = {
  久助: "kusuke-250",
  くすけ: "kusuke-250",
  kusuke: "kusuke-250",
  "kusuke-250": "kusuke-250",
};
// 直接注文の一覧から隠す商品（久助だけ非表示）
const HIDE_PRODUCT_IDS = new Set(["kusuke-250"]);

function findProductById(pid) {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === pid);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}
function resolveProductId(token) {
  return PRODUCT_ALIASES[token] || token;
}
function writeStockLog(entry) {
  try {
    fs.appendFileSync(
      STOCK_LOG,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8"
    );
  } catch {}
}
function setStock(productId, qty, actor = "system") {
  const q = Math.max(0, Number(qty) || 0);
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  products[idx].stock = q;
  writeProducts(products);
  writeStockLog({ action: "set", productId, before, after: q, delta: q - before, actor });
  return { before, after: q };
}
function addStock(productId, delta, actor = "system") {
  const d = Number(delta) || 0;
  const { products, idx, product } = findProductById(productId);
  if (idx < 0) throw new Error("product_not_found");
  const before = Number(product.stock || 0);
  const after = Math.max(0, before + d);
  products[idx].stock = after;
  writeProducts(products);
  writeStockLog({ action: "add", productId, before, after, delta: d, actor });
  return { before, after };
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  const client = new line.Client(config);
  if (stockNow < LOW_STOCK_THRESHOLD && ADMIN_USER_ID) {
    const msg = `⚠️ 在庫僅少アラート\n商品：${productName}（${productId}）\n残り：${stockNow}個\nしきい値：${LOW_STOCK_THRESHOLD}個`;
    try {
      await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
    } catch {}
  }
}

// ====== 認可 ======
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
function requireAdmin(req, res) {
  const headerTok = bearerToken(req);
  const queryTok = (req.query?.token || req.query?.code || "").trim();
  const tok = headerTok || queryTok;
  if (ADMIN_API_TOKEN_ENV && tok === ADMIN_API_TOKEN_ENV) return true;
  if (ADMIN_CODE_ENV && tok === ADMIN_CODE_ENV) return true;
  res.status(401).json({
    ok: false,
    error: "unauthorized",
    hint: {
      need: {
        bearer_header: !!ADMIN_API_TOKEN_ENV,
        token_query: !!ADMIN_API_TOKEN_ENV,
        code_query: !!ADMIN_CODE_ENV,
      },
      got: {
        header: headerTok ? "present" : "missing",
        query: queryTok ? "present" : "missing",
      },
    },
  });
  return false;
}

// ====== ログ読み込みユーティリティ ======
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit) || 100, lines.length));
  return tail
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function jstRangeFromYmd(ymd) {
  const s = String(ymd || "");
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6)) - 1;
  const d = Number(s.slice(6, 8));
  const startJST = new Date(Date.UTC(y, m, d, -9, 0, 0));
  const endJST = new Date(Date.UTC(y, m, d + 1, -9, 0, 0));
  return { from: startJST.toISOString(), to: endJST.toISOString() };
}
function filterByIsoRange(items, getTs, fromIso, toIso) {
  if (!fromIso && !toIso) return items;
  const from = fromIso ? new Date(fromIso).getTime() : -Infinity;
  const to = toIso ? new Date(toIso).getTime() : Infinity;
  return items.filter((it) => {
    const t = new Date(getTs(it)).getTime();
    return t >= from && t < to;
  });
}

// ====== 配送料 & 代引き ======
const SHIPPING_BY_REGION = {
  北海道: 1560,
  東北: 1070,
  関東: 960,
  中部: 960,
  近畿: 960,
  中国: 1070,
  四国: 1180,
  九州: 1190,
  沖縄: 1840,
};
const COD_FEE = 330;

// ====== LINE client ======
const client = new line.Client(config);

// ====== Flex送信ユーティリティ ======
function ensureAltText(altText) {
  const s = String(altText || "").trim();
  if (!s) throw new Error("altText is required");
  if (s.length > 400) throw new Error("altText too long (<=400)");
  return s;
}
function validateFlexContents(contents) {
  if (!contents || typeof contents !== "object")
    throw new Error("contents must be object");
  const t = contents.type;
  if (t !== "bubble" && t !== "carousel")
    throw new Error('contents.type must be "bubble" or "carousel"');
  return contents;
}

// ===== 画像URL整形（Flex用） =====
function toPublicImageUrl(raw) {
  if (!raw) return "";
  let s = String(raw).trim();
  if (!s) return "";

  s = s.replace(".onrender.com./", ".onrender.com/");

  if (/^https?:\/\//i.test(s)) {
    return s;
  }

  let fname = s;
  const lastSlash = s.lastIndexOf("/");
  if (lastSlash >= 0) {
    fname = s.slice(lastSlash + 1);
  }
  const pathPart = `/public/uploads/${fname}`;

  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");

  if (hostFromRender) {
    return `https://${hostFromRender}${pathPart}`;
  }

  return pathPart;
}

// ===== 商品UI（Flex） ======
function productsFlex(allProducts) {
  const products = (allProducts || []).filter(
    (p) => !HIDE_PRODUCT_IDS.has(p.id)
  );

  const bubbles = products.map((p) => {
    const imgUrl = toPublicImageUrl(p.image);

    return {
      type: "bubble",
      hero: imgUrl
        ? {
            type: "image",
            url: imgUrl,
            size: "full",
            aspectRatio: "1:1",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "text",
            text: p.name,
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "text",
            text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`,
            size: "sm",
            wrap: true,
          },

          // ★ 内容量（volume）があれば表示
          p.volume
            ? {
                type: "text",
                text: `内容量：${p.volume}`,
                size: "sm",
                wrap: true,
              }
            : null,

          // 説明文
          p.desc
            ? {
                type: "text",
                text: p.desc,
                size: "sm",
                wrap: true,
              }
            : null,
        ].filter(Boolean),
      },

      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "数量を選ぶ",
              data: `order_qty?${qstr({ id: p.id, qty: 1 })}`,
            },
          },
        ],
      },
    };
  });

  // その他（自由入力）バブル
  bubbles.push({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: "その他（自由入力）",
          weight: "bold",
          size: "md",
        },
        {
          type: "text",
          text: "商品名と個数だけ入力します。価格入力は不要です。",
          size: "sm",
          wrap: true,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [
        {
          type: "button",
          style: "primary",
          action: {
            type: "postback",
            label: "商品名を入力する",
            data: "other_start",
          },
        },
        {
          type: "button",
          style: "secondary",
          action: {
            type: "postback",
            label: "← 戻る",
            data: "order_back",
          },
        },
      ],
    },
  });

  return {
    type: "flex",
    altText: "商品一覧",
    contents:
      bubbles.length === 1
        ? bubbles[0]
        : {
            type: "carousel",
            contents: bubbles,
          },
  };
}

function qtyFlex(id, qty = 1) {
  const q = Math.max(1, Math.min(99, Number(qty) || 1));
  return {
    type: "flex",
    altText: "数量を選択してください",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "数量選択",
            weight: "bold",
            size: "lg",
          },
          {
            type: "text",
            text: `現在の数量：${q} 個`,
            size: "md",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "postback",
                  label: "-1",
                  data: `order_qty?${qstr({
                    id,
                    qty: Math.max(1, q - 1),
                  })}`,
                },
              },
              {
                type: "button",
                style: "secondary",
                action: {
                  type: "postback",
                  label: "+1",
                  data: `order_qty?${qstr({
                    id,
                    qty: Math.min(99, q + 1),
                  })}`,
                },
              },
            ],
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [1, 2, 3, 5].map((n) => ({
              type: "button",
              style: n === q ? "primary" : "secondary",
              action: {
                type: "postback",
                label: `${n}個`,
                data: `order_qty?${qstr({ id, qty: n })}`,
              },
            })),
          },
          // ★ 店頭受取用：先に名前を聞くステップへ
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "店頭での受取名前を入力",
              data: `order_pickup_name?${qstr({
                id,
                qty: q,
              })}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "← 商品一覧",
              data: "order_back",
            },
          },
        ],
      },
    },
  };
}

function methodFlex(id, qty) {
  return {
    type: "flex",
    altText: "受取方法を選択してください",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "受取方法",
            weight: "bold",
            size: "lg",
          },
          {
            type: "text",
            text: "宅配 または 店頭受取 を選択してください。",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: "宅配（送料あり）",
              data: `order_region?${qstr({
                id,
                qty,
                method: "delivery",
              })}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "店頭受取（送料0円）",
              data: `order_payment?${qstr({
                id,
                qty,
                method: "pickup",
                region: "-",
              })}`,
            },
          },
        ],
      },
    },
  };
}

function regionFlex(id, qty) {
  const regions = Object.keys(SHIPPING_BY_REGION);
  const rows = [];
  for (let i = 0; i < regions.length; i += 2) {
    rows.push({
      type: "box",
      layout: "horizontal",
      spacing: "md",
      contents: regions.slice(i, i + 2).map((r) => ({
        type: "button",
        style: "secondary",
        action: {
          type: "postback",
          label: `${r}（${yen(SHIPPING_BY_REGION[r])}）`,
          data: `order_payment?${qstr({
            id,
            qty,
            method: "delivery",
            region: r,
          })}`,
        },
      })),
    });
  }
  return {
    type: "flex",
    altText: "地域選択",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "地域選択",
            weight: "bold",
            size: "lg",
          },
          {
            type: "text",
            text: "地域により送料が異なります。",
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: rows,
      },
    },
  };
}

// ★ 店頭受取＝現金のみ
function paymentFlex(id, qty, method, region) {
  if (method === "pickup") {
    return {
      type: "flex",
      altText: "お支払い（店頭）",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              type: "text",
              text: "お支払い方法",
              weight: "bold",
              size: "lg",
            },
            {
              type: "text",
              text: "店頭受取は現金のみです。",
              wrap: true,
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            {
              type: "button",
              style: "primary",
              action: {
                type: "postback",
                label: "現金で支払う（店頭）",
                data: `order_confirm_view?${qstr({
                  id,
                  qty,
                  method: "pickup",
                  region: "",
                  payment: "cash",
                })}`,
              },
            },
            {
              type: "button",
              style: "secondary",
              action: {
                type: "postback",
                label: "← 受取方法へ戻る",
                data: `order_method?${qstr({ id, qty })}`,
              },
            },
          ],
        },
      },
    };
  }

  const regionText =
    method === "delivery" ? `（配送地域：${region}）` : "";
  return {
    type: "flex",
    altText: "お支払い方法を選択してください",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: "お支払い方法",
            weight: "bold",
            size: "lg",
          },
          {
            type: "text",
            text: `代引きは +${yen(COD_FEE)}${regionText}`,
            wrap: true,
          },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "postback",
              label: `代金引換（+${yen(COD_FEE)}）`,
              data: `order_confirm_view?${qstr({
                id,
                qty,
                method,
                region,
                payment: "cod",
              })}`,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "postback",
              label: "銀行振込",
              data: `order_confirm_view?${qstr({
                id,
                qty,
                method,
                region,
                payment: "bank",
              })}`,
            },
          },
        ],
      },
    },
  };
}

function confirmFlex(product, qty, method, region, payment, liffIdForBtn, options = {}) {
  // options.pickupName を追加で受け取る
  const pickupName = (options.pickupName || "").trim();

  if (typeof product?.id === "string" && product.id.startsWith("other:")) {
    const parts = product.id.split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    product = {
      ...product,
      name: decodeURIComponent(encName || "その他"),
      price: Number(priceStr || 0),
    };
  }

  const regionFee =
    method === "delivery" ? SHIPPING_BY_REGION[region] || 0 : 0;
  const codFee = payment === "cod" ? COD_FEE : 0;
  const subtotal = Number(product.price) * Number(qty);
  const total = subtotal + regionFee + codFee;

  const payText =
    payment === "cod"
      ? `代金引換（+${yen(COD_FEE)})`
      : payment === "bank"
      ? "銀行振込"
      : "現金（店頭）";

  const lines = [
    `受取方法：${
      method === "pickup"
        ? "店頭受取（送料0円）"
        : `宅配（${region}：${yen(regionFee)}）`
    }`,
    `支払い：${payText}`,
    `商品：${product.name}`,
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
    `送料：${yen(regionFee)}`,
    `代引き手数料：${yen(codFee)}`,
    `合計：${yen(total)}`,
  ];

  // ★ 店頭受取の場合、入力されたお名前も表示
  if (method === "pickup" && pickupName) {
    lines.push(`お名前：${pickupName}`);
  }

  const bodyContents = [
    { type: "text", text: "最終確認", weight: "bold", size: "lg" },
    ...lines.map((t) => ({ type: "text", text: t, wrap: true })),
  ];

  if (method === "delivery") {
    bodyContents.push({
      type: "text",
      text: "住所が未登録の方は「住所を入力（LIFF）」を押してください。",
      size: "sm",
      wrap: true,
    });
  }

  const footerButtons = [
    {
      type: "button",
      style: "secondary",
      action: {
        type: "postback",
        label: "← 商品一覧へ",
        data: "order_back",
      },
    },
    {
      type: "button",
      style: "primary",
      action: {
        type: "postback",
        label: "この内容で確定",
        // ★ 名前も postback に載せる
        data: `order_confirm?${qstr({
          id: product.id,
          qty,
          method,
          region,
          payment,
          pickupName,
        })}`,
      },
    },
  ];

  if (method === "delivery") {
    footerButtons.unshift({
      type: "button",
      style: "secondary",
      action: {
        type: "uri",
        label: "住所を入力（LIFF）",
        uri: `https://liff.line.me/${liffIdForBtn}?${qstr({
          from: "address",
          need: "shipping",
        })}`,
      },
    });
  }

  const imgUrl = toPublicImageUrl(product.image);

  return {
    type: "flex",
    altText: "注文内容の最終確認",
    contents: {
      type: "bubble",
      hero: imgUrl
        ? {
            type: "image",
            url: imgUrl,
            size: "full",
            aspectRatio: "1:1",
            aspectMode: "cover",
          }
        : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: footerButtons,
      },
    },
  };
}

function reserveOffer(product, needQty, stock) {
  return [
    {
      type: "text",
      text: [
        "申し訳ありません。在庫が不足しています。",
        `商品：${product.name}`,
        `希望数量：${needQty}個 / 現在在庫：${stock}個`,
        "",
        "予約しますか？ 入荷次第ご案内します。",
      ].join("\n"),
    },
    {
      type: "template",
      altText: "在庫不足：予約しますか？",
      template: {
        type: "confirm",
        text: "予約しますか？",
        actions: [
          {
            type: "postback",
            label: "予約する",
            data: `order_reserve?${qstr({ id: product.id, qty: needQty })}`,
          },
          { type: "postback", label: "やめる", data: "order_cancel" },
        ],
      },
    },
  ];
}

// ====== アンケート簡易スタブ ======
const SURVEY_VERSION = 2;
const SURVEY_SCHEMA = { q1: { options: [] }, q2: { options: [] }, q3: { options: [] } };
function labelOf(q, code) {
  return code;
}

// ====== LIFF API ======
// 住所保存（LIFF）
app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {}; // ★ address を受け取る

    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId required" });
    }

    const book = readAddresses();
    book[userId] = {
      name:        String(addr.name || "").trim(),
      phone:       String(addr.phone || "").trim(),
      postal:      String(addr.postal || "").trim(),
      prefecture:  String(addr.prefecture || "").trim(),
      city:        String(addr.city || "").trim(),
      address1:    String(addr.address1 || "").trim(),
      address2:    String(addr.address2 || "").trim(),
      ts: new Date().toISOString(),
    };

    writeAddresses(book);
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 自分の住所取得（confirm.js / pay.js 用）
app.get("/api/liff/address/me", (req, res) => {
  try {
    const userId = String(
      req.query.userId || req.headers["x-line-userid"] || ""
    ).trim();
    const book = readAddresses();

    if (userId && book[userId]) {
      return res.json({ ok: true, address: book[userId] });
    }

    const vals = Object.values(book || {});
    let last = null;
    if (vals.length > 0) {
      vals.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
      last = vals[0];
    }
    return res.json({ ok: true, address: last });
  } catch (e) {
    res.json({ ok: false, address: null });
  }
});

// LIFF 設定（★ 住所入力用 LIFF ID を返す）
app.get("/api/liff/config", (_req, res) =>
  res.json({ liffId: LIFF_ID_DIRECT_ADDRESS })
);

// ====== Stripe 決済（Checkout Session） ======
app.post("/api/pay-stripe", async (req, res) => {
  try {
    // 先頭で初期化した stripe を使う想定
    if (!stripe) {
      console.error("STRIPE_SECRET_KEY が設定されていません");
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    }

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];

    if (!items.length) {
      return res.status(400).json({ ok: false, error: "no_items" });
    }

    // フロントから送られてきた合計（confirm.js/pay.js 側）
    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping   = Number(order.shipping   || 0);
    const codFee     = Number(order.codFee     || 0); // 今は 0 想定
    const finalTotal = Number(
      order.finalTotal || (itemsTotal + shipping + codFee)
    );

    console.log("[pay-stripe] items:", items);
    console.log(
      "[pay-stripe] itemsTotal:", itemsTotal,
      "shipping:", shipping,
      "codFee:", codFee,
      "finalTotal:", finalTotal
    );

    // ===== Stripe に渡す line_items を作成 =====
    const line_items = [];

    // 商品行
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty  = Number(it.qty)   || 0;
      if (!qty || unit < 0) continue;

      line_items.push({
        price_data: {
          currency: "jpy",
          product_data: {
            name: String(it.name || it.id || "商品"),
          },
          unit_amount: unit, // 例: 300 → 300円
        },
        quantity: qty,
      });
    }

    // 送料行（あれば）
    if (shipping > 0) {
      line_items.push({
        price_data: {
          currency: "jpy",
          product_data: { name: "送料" },
          unit_amount: shipping,
        },
        quantity: 1,
      });
    }

    // 代引き手数料行（将来使う場合）
    if (codFee > 0) {
      line_items.push({
        price_data: {
          currency: "jpy",
          product_data: { name: "代引き手数料" },
          unit_amount: codFee,
        },
        quantity: 1,
      });
    }

    if (!line_items.length) {
      return res
        .status(400)
        .json({ ok: false, error: "no_valid_line_items" });
    }

    // ベースURL (PUBLIC_BASE_URL優先)
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host  = req.headers.host;
    const base =
      (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "") ||
      `${proto}://${host}`;

    const successUrl = `${base}/public/confirm-card-success.html`;
    const cancelUrl  = `${base}/public/confirm-fail.html`;

    console.log("[pay-stripe] success_url:", successUrl);
    console.log("[pay-stripe] cancel_url :", cancelUrl);

    // ⬇⬇ ここがポイント：automatic_payment_methods は一切渡さない ⬇⬇
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        lineUserId:   order.lineUserId   || "",
        lineUserName: order.lineUserName || "",
      },
    });

    console.log("[pay-stripe] session.id:", session.id);
    return res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("[pay-stripe] error:", e?.raw || e);
    return res
      .status(500)
      .json({ ok: false, error: "stripe_error" });
  }
});

app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};

    const items = Array.isArray(order.items) ? order.items : [];
    if (items.length === 0) {
      // 二度目以降など、注文データが無いときはエラーにせずスキップ
      console.log("[order-complete] no_items – skip notify");
      return res.json({ ok: false, error: "no_items" });
    }

    const itemsText = items
      .map(
        (it) =>
          `・${it.name} x ${it.qty} = ${yen(
            (it.price || 0) * (it.qty || 0)
          )}`
      )
      .join("\n");

    const itemsTotal = Number(order.itemsTotal ?? order.total ?? 0);
    const shipping = Number(order.shipping ?? 0);
    const codFee = Number(order.codFee ?? 0);
    const finalTotal = Number(order.finalTotal ?? order.total ?? 0);

    let addrText = "住所：未登録";
    if (order.address) {
      const a = order.address;
      addrText =
        `住所：${a.zip || a.postal || ""} ` +
        `${a.prefecture || a.pref || ""}${a.city || ""}${
          a.addr1 || a.address1 || ""
        }` +
        `${
          a.addr2 || a.address2 ? " " + (a.addr2 || a.address2) : ""
        }\n` +
        `氏名：${(a.lastName || "")}${
          (a.firstName || "") || a.name || ""
        }\n` +
        `TEL：${a.tel || a.phone || ""}`;
    }

    try {
      const log = {
        ts: new Date().toISOString(),
        ...order,
        source: "liff-stripe",
      };
      fs.appendFileSync(ORDERS_LOG, JSON.stringify(log) + "\n", "utf8");
      console.log("[order-complete] orders.log append OK");
    } catch (e) {
      console.error("orders.log write error:", e);
    }

    console.log("[order-complete] ADMIN_USER_ID:", ADMIN_USER_ID);
    console.log("[order-complete] MULTICAST_USER_IDS:", MULTICAST_USER_IDS);

    const adminMsg =
      `🧾【Stripe決済 新規注文】\n` +
      (order.lineUserId ? `ユーザーID：${order.lineUserId}\n` : "") +
      (order.orderNumber ? `注文番号：${order.orderNumber}\n` : "") +
      `\n【内容】\n${itemsText}\n` +
      `\n商品合計：${yen(itemsTotal)}\n` +
      `送料：${yen(shipping)}\n` +
      (codFee ? `代引き手数料：${yen(codFee)}\n` : "") +
      `合計：${yen(finalTotal)}\n` +
      `\n${addrText}`;

    try {
      if (ADMIN_USER_ID) {
        await client.pushMessage(ADMIN_USER_ID, {
          type: "text",
          text: adminMsg,
        });
        console.log("[order-complete] admin push OK");
      }
      if (MULTICAST_USER_IDS.length > 0) {
        await client.multicast(MULTICAST_USER_IDS, {
          type: "text",
          text: adminMsg,
        });
      }
    } catch (e) {
      console.error("admin push error:", e?.response?.data || e);
    }

    try {
      if (order.lineUserId) {
        const userMsg =
          "ご注文ありがとうございます！\n\n" +
          "【ご注文内容】\n" +
          itemsText +
          "\n\n" +
          `商品合計：${yen(itemsTotal)}\n` +
          `送料：${yen(shipping)}\n` +
          (codFee ? `代引き手数料：${yen(codFee)}\n` : "") +
          `合計：${yen(finalTotal)}\n\n` +
          addrText;

        await client.pushMessage(order.lineUserId, {
          type: "text",
          text: userMsg,
        });
        console.log("user receipt push OK:", order.lineUserId);
      }
    } catch (e) {
      console.error("user receipt push error:", e?.response?.data || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// ====== 管理API（要トークン） ======
app.get("/api/admin/ping", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, ping: "pong" });
});

// 注文・予約・住所・アンケート一覧 & 集計
app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(ORDERS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to)
    range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to)
    items = filterByIsoRange(items, (x) => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});

app.get("/api/admin/reservations", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  let items = readLogLines(RESERVATIONS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to)
    range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to)
    items = filterByIsoRange(items, (x) => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});

app.get("/api/admin/addresses", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, items: readAddresses() });
});

app.get("/api/admin/surveys", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 2000));
  let items = readLogLines(SURVEYS_LOG, limit);
  let range = {};
  if (req.query.date) range = jstRangeFromYmd(String(req.query.date));
  if (req.query.from || req.query.to)
    range = { from: req.query.from, to: req.query.to };
  if (range.from || range.to)
    items = filterByIsoRange(items, (x) => x.ts, range.from, range.to);
  res.json({ ok: true, items });
});

app.get("/api/admin/surveys/summary", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    version: SURVEY_VERSION,
    total: 0,
    summary: { q1: [], q2: [], q3: [] },
  });
});

// ====== 順次通知（予約者）API ======
function buildReservationQueue(productId) {
  const all = readLogLines(RESERVATIONS_LOG, 200000)
    .filter(
      (r) => r && r.productId === productId && r.userId && r.ts
    )
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const seen = new Set();
  const ids = [];
  for (const r of all) {
    if (!seen.has(r.userId)) {
      seen.add(r.userId);
      ids.push(r.userId);
    }
  }
  return ids;
}

app.post("/api/admin/reservations/notify-start", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(
      String(req.body?.productId || "").trim()
    );
    const message = String(req.body?.message || "").trim();
    if (!pid)
      return res
        .status(400)
        .json({ ok: false, error: "productId required" });
    if (!message)
      return res
        .status(400)
        .json({ ok: false, error: "message required" });

    const userIds = buildReservationQueue(pid);
    const state = readNotifyState();
    state[pid] = {
      idx: 0,
      userIds,
      message,
      updatedAt: new Date().toISOString(),
    };
    state.__lastPid = pid;
    writeNotifyState(state);

    if (userIds.length === 0)
      return res.json({
        ok: true,
        info: "no_reservers",
        sent: false,
      });

    try {
      await client.pushMessage(userIds[0], {
        type: "text",
        text: message,
      });
      state[pid].idx = 1;
      state[pid].updatedAt = new Date().toISOString();
      writeNotifyState(state);
      return res.json({
        ok: true,
        productId: pid,
        sentTo: userIds[0],
        index: 1,
        total: userIds.length,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: "push_failed",
        detail: e?.response?.data || String(e),
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/admin/reservations/notify-next", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pidRaw = (req.body?.productId ??
      readNotifyState().__lastPid ??
      "").toString();
    const pid = resolveProductId(pidRaw.trim());
    const n = Math.max(1, Math.min(100, Number(req.body?.count || 1)));
    const state = readNotifyState();
    const st = state[pid];
    if (!pid || !st)
      return res
        .status(400)
        .json({ ok: false, error: "not_started" });

    const { userIds, message } = st;
    let { idx } = st;
    const total = userIds.length;
    if (idx >= total)
      return res.json({ ok: true, done: true, index: idx, total });

    const sentTo = [];
    for (let i = 0; i < n && idx < total; i++, idx++) {
      const uid = userIds[idx];
      try {
        await client.pushMessage(uid, {
          type: "text",
          text: message,
        });
        sentTo.push(uid);
      } catch (e) {
        console.error(
          "notify-next push error:",
          e?.response?.data || e
        );
      }
    }
    state[pid].idx = idx;
    state[pid].updatedAt = new Date().toISOString();
    writeNotifyState(state);

    return res.json({
      ok: true,
      productId: pid,
      sent: sentTo.length,
      sentTo,
      index: idx,
      total,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/api/admin/reservations/notify-stop", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pid = resolveProductId(
    String(req.body?.productId || "").trim()
  );
  const state = readNotifyState();
  if (pid && state[pid]) {
    delete state[pid];
  }
  if (state.__lastPid === pid) delete state.__lastPid;
  writeNotifyState(state);
  res.json({ ok: true, stopped: pid || true });
});

// ====== 在庫管理 API ======
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock ?? 0,
    desc: p.desc || "",
    image: p.image || "",
  }));
  res.json({ ok: true, items });
});

// 商品情報更新
app.post("/api/admin/products/update", (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const pid = String(req.body?.productId || "").trim();
    if (!pid)
      return res
        .status(400)
        .json({ ok: false, error: "productId required" });

    const products = readProducts();
    const idx = products.findIndex((p) => p.id === pid);
    if (idx < 0)
      return res
        .status(404)
        .json({ ok: false, error: "product_not_found" });

    const p = products[idx];
    const beforeStock = Number(p.stock || 0);

    if (typeof req.body.name === "string") {
      p.name = req.body.name.trim().slice(0, 50);
    }

    if (req.body.price !== undefined) {
      const v = Number(req.body.price);
      if (!Number.isNaN(v) && v >= 0) p.price = v;
    }

    if (req.body.stock !== undefined) {
      const v = Number(req.body.stock);
      if (!Number.isNaN(v) && v >= 0) {
        p.stock = v;
        writeStockLog({
          action: "set",
          productId: pid,
          before: beforeStock,
          after: v,
          delta: v - beforeStock,
          actor: "api-update",
        });
      }
    }

    if (typeof req.body.desc === "string") {
      p.desc = req.body.desc.trim().slice(0, 200);
    }

    if (typeof req.body.image === "string") {
      p.image = req.body.image.trim();
    }

    writeProducts(products);
    return res.json({ ok: true, product: p });
  } catch (e) {
    console.error("products/update error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "update_error" });
  }
});

// 在庫ログ一覧
app.get("/api/admin/stock/logs", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(10000, Number(req.query.limit || 200));
  const items = readLogLines(STOCK_LOG, limit);
  res.json({ ok: true, items });
});

app.post("/api/admin/stock/set", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(
      (req.body?.productId || "").trim()
    );
    const qty = Number(req.body?.qty);
    const r = setStock(pid, qty, "api");
    res.json({ ok: true, productId: pid, ...r });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/admin/stock/add", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(
      (req.body?.productId || "").trim()
    );
    const delta = Number(req.body?.delta);
    const r = addStock(pid, delta, "api");
    res.json({ ok: true, productId: pid, ...r });
  } catch (e) {
    res
      .status(400)
      .json({ ok: false, error: String(e.message || e) });
  }
});

// ====== ミニアプリ用：商品一覧 API（久助除外） ======
app.get("/api/products", (req, res) => {
  try {
    const items = readProducts()
      .filter((p) => p.id !== "kusuke-250") // ★ 久助を除外
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        volume: p.volume || "",                     // ★ 内容量（volume）
        image: toPublicImageUrl(p.image || ""),     // ★ 画像URL
      }));

    res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== ミニアプリ用：送料計算 API ======
// 受け取り例:
// {
//   items: [{ id, price, qty }],
//   address: { zip, prefecture, addr1 }
// }
// 返す例: { ok:true, itemsTotal, shipping, finalTotal }

function detectRegionFromAddress(address = {}) {
  const pref = String(
    address.prefecture || address.pref || ""
  ).trim();
  const addr1 = String(
    address.addr1 || address.address1 || ""
  ).trim();
  const hay = pref || addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (
    /(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(
      hay
    )
  )
    return "関東";
  if (
    /(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(
      hay
    )
  )
    return "中部";
  if (
    /(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿)/.test(
      hay
    )
  )
    return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (
    /(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(
      hay
    )
  )
    return "九州";
  if (/(沖縄)/.test(hay)) return "沖縄";

  return "";
}

app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce(
      (sum, it) =>
        sum +
        (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    const region = detectRegionFromAddress(address);
    const shipping = region ? SHIPPING_BY_REGION[region] || 0 : 0;
    const finalTotal = itemsTotal + shipping;

    res.json({
      ok: true,
      itemsTotal,
      region,
      shipping,
      finalTotal,
    });
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: e.message || "shipping_error",
    });
  }
});

// ====== 予約者一括連絡（旧スタイル） ======
app.post("/api/admin/reservations/notify", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = resolveProductId(
      String(req.body?.productId || "").trim()
    );
    const msg = String(req.body?.message || "").trim();
    if (!pid)
      return res
        .status(400)
        .json({ ok: false, error: "productId required" });
    if (!msg)
      return res
        .status(400)
        .json({ ok: false, error: "message required" });

    const items = readLogLines(RESERVATIONS_LOG, 100000).filter(
      (r) => r && r.productId === pid && r.userId
    );
    const userIds = Array.from(
      new Set(items.map((r) => r.userId))
    );
    if (userIds.length === 0)
      return res.json({ ok: true, sent: 0, users: [] });

    const chunkSize = 500;
    let sent = 0;
    for (let i = 0; i < userIds.length; i += chunkSize) {
      const ids = userIds.slice(i, i + chunkSize);
      try {
        await client.multicast(ids, [
          { type: "text", text: msg },
        ]);
        sent += ids.length;
      } catch (e) {
        console.error(
          "notify reservations multicast error:",
          e?.response?.data || e
        );
      }
    }
    return res.json({
      ok: true,
      productId: pid,
      requested: userIds.length,
      sent,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: String(e.message || e),
    });
  }
});

// ====== セグメント配信（テキスト/Flex） ======
app.post("/api/admin/segment/preview", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const t = (req.body?.type || "").trim();

    const uniqIds = (arr) =>
      Array.from(new Set(arr.filter(Boolean)));

    if (t === "activeChatters" || t === "textSenders") {
      const limit = Math.min(
        200000,
        Number(req.body?.limit || 50000)
      );
      let items = readLogLines(MESSAGES_LOG, limit);
      if (req.body?.date) {
        const r = jstRangeFromYmd(String(req.body.date));
        items = filterByIsoRange(items, (x) => x.ts, r.from, r.to);
      }
      const ids = uniqIds(
        items
          .filter((x) => x && x.type === "text" && x.userId)
          .map((x) => x.userId)
      );
      return res.json({
        ok: true,
        type: t,
        total: ids.length,
        userIds: ids,
      });
    }

    if (t === "survey") {
      const limit = Math.min(
        200000,
        Number(req.body?.limit || 50000)
      );
      let items = readLogLines(SURVEYS_LOG, limit);
      if (req.body?.date) {
        const r = jstRangeFromYmd(String(req.body.date));
        items = filterByIsoRange(items, (x) => x.ts, r.from, r.to);
      }
      const q1 = Array.isArray(req.body?.q1codes)
        ? req.body.q1codes
        : null;
      const q2 = Array.isArray(req.body?.q2codes)
        ? req.body.q2codes
        : null;
      const q3 = Array.isArray(req.body?.q3codes)
        ? req.body.q3codes
        : null;
      const ids = uniqIds(
        items
          .filter((it) => {
            const a = it?.answers || {};
            return (
              (!q1 || q1.includes(a?.q1?.code || "")) &&
              (!q2 || q2.includes(a?.q2?.code || "")) &&
              (!q3 || q3.includes(a?.q3?.code || ""))
            );
          })
          .map((it) => it.userId)
      );
      return res.json({
        ok: true,
        type: t,
        total: ids.length,
        userIds: ids,
      });
    }

    if (t === "orders") {
      const limit = Math.min(
        200000,
        Number(req.body?.limit || 50000)
      );
      let items = readLogLines(ORDERS_LOG, limit);
      if (req.body?.date) {
        const r = jstRangeFromYmd(String(req.body.date));
        items = filterByIsoRange(items, (x) => x.ts, r.from, r.to);
      }
      const pids = Array.isArray(req.body?.productIds)
        ? req.body.productIds
        : null;
      const method = (req.body?.method || "").trim();
      const payment = (req.body?.payment || "").trim();
      const ids = uniqIds(
        items
          .filter((o) => {
            if (pids && pids.length > 0 && !pids.includes(o.productId))
              return false;
            if (method && o.method !== method) return false;
            if (payment && o.payment !== payment) return false;
            return !!o.userId;
          })
          .map((o) => o.userId)
      );
      return res.json({
        ok: true,
        type: t,
        total: ids.length,
        userIds: ids,
      });
    }

    if (t === "addresses") {
      const book = readAddresses();
      const ids = uniqIds(Object.keys(book || {}));
      return res.json({
        ok: true,
        type: t,
        total: ids.length,
        userIds: ids,
      });
    }

    return res
      .status(400)
      .json({ ok: false, error: "unknown_type" });
  } catch (e) {
    console.error("segment preview error:", e);
    return res
      .status(500)
      .json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const userIds = Array.isArray(req.body?.userIds)
    ? uniq(req.body.userIds)
    : [];
  const message = (req.body?.message || "").trim();
  if (userIds.length === 0)
    return res
      .status(400)
      .json({ ok: false, error: "no_users" });
  if (!message)
    return res
      .status(400)
      .json({ ok: false, error: "no_message" });

  const chunkSize = 500;
  const results = [];
  let okCount = 0,
    ngCount = 0,
    batches = 0;

  for (let i = 0; i < userIds.length; i += chunkSize) {
    const ids = userIds.slice(i, i + chunkSize);
    try {
      await client.multicast(ids, [
        { type: "text", text: message },
      ]);
      results.push({ size: ids.length, ok: true });
      okCount += ids.length;
      batches++;
    } catch (e) {
      console.error("multicast error:", e?.response?.data || e);
      results.push({
        size: ids.length,
        ok: false,
        error: e?.response?.data || String(e),
      });
      ngCount += ids.length;
      batches++;
    }
  }
  return res.json({
    ok: true,
    requested: userIds.length,
    sent: okCount,
    failed: ngCount,
    batches,
    results,
  });
});

app.post("/api/admin/segment/send-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds)
      ? Array.from(
          new Set(req.body.userIds.filter(Boolean))
        )
      : [];
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    if (userIds.length === 0)
      return res
        .status(400)
        .json({ ok: false, error: "no_users" });

    const msg = [{ type: "flex", altText, contents }];
    const chunkSize = 500;
    let sent = 0,
      failed = 0,
      batches = 0,
      results = [];

    for (let i = 0; i < userIds.length; i += chunkSize) {
      const ids = userIds.slice(i, i + chunkSize);
      try {
        await client.multicast(ids, msg);
        results.push({ ok: true, size: ids.length });
        sent += ids.length;
        batches++;
      } catch (e) {
        const detail = e?.response?.data || String(e);
        console.error("send-flex multicast error:", detail);
        results.push({
          ok: false,
          size: ids.length,
          error: detail,
        });
        failed += ids.length;
        batches++;
      }
    }
    return res.json({
      ok: true,
      requested: userIds.length,
      sent,
      failed,
      batches,
      results,
    });
  } catch (err) {
    return res
      .status(400)
      .json({ ok: false, error: err.message || "bad_request" });
  }
});

app.post("/api/admin/broadcast-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const altText = ensureAltText(req.body?.altText);
    const contents = validateFlexContents(req.body?.contents);
    await client.broadcast([{ type: "flex", altText, contents }]);
    return res.json({ ok: true });
  } catch (e) {
    const detail =
      e?.response?.data || e.message || String(e);
    console.error("broadcast-flex error:", detail);
    return res
      .status(400)
      .json({ ok: false, error: detail });
  }
});

// ====== 画像アップロード & 管理 API（管理者のみ） ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || "image").replace(
      /[^\w.\-]+/g,
      "_"
    );
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)/i.test(
      file.mimetype
    );
    cb(ok ? null : new Error("invalid_file_type"), ok);
  },
});

// 接続テスト
app.get("/api/admin/connection-test", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    uploads: true,
    uploadDir: "/public/uploads",
  });
});

// アップロード
app.post("/api/admin/upload-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  upload.single("image")(req, res, (err) => {
    if (err) {
      const msg =
        err?.message === "File too large"
          ? "file_too_large"
          : err?.message || "upload_error";
      return res
        .status(400)
        .json({ ok: false, error: msg });
    }
    if (!req.file)
      return res
        .status(400)
        .json({ ok: false, error: "no_file" });

    const filename = req.file.filename;
    const relPath = `/public/uploads/${filename}`;

    let base = PUBLIC_BASE_URL;
    if (!base) {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers.host;
      base = `${proto}://${host}`;
    }
    const url = `${base}${relPath}`;

    res.json({
      ok: true,
      file: filename,
      url,
      path: relPath,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });
  });
});

// 一覧
app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map((name) => {
        const p = path.join(UPLOAD_DIR, name);
        const st = fs.statSync(p);
        return {
          name,
          url: `/public/uploads/${name}`,
          path: `/public/uploads/${name}`,
          bytes: st.size,
          mtime: st.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    res.json({ ok: true, items: files });
  } catch (e) {
    console.error("images list error:", e);
    res
      .status(500)
      .json({ ok: false, error: "list_error" });
  }
});

// 削除
app.delete("/api/admin/images/:name", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const base = (req.params?.name || "")
    .replace(/\.\./g, "")
    .replace(/[\/\\]/g, "");
  const p = path.join(UPLOAD_DIR, base);
  try {
    if (!fs.existsSync(p))
      return res
        .status(404)
        .json({ ok: false, error: "not_found" });
    fs.unlinkSync(p);
    res.json({ ok: true, deleted: base });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "delete_error" });
  }
});

// 商品に画像URLを紐付け
app.post("/api/admin/products/set-image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const pid = String(req.body?.productId || "").trim();
    const imageUrl = String(req.body?.imageUrl || "").trim();
    if (!pid)
      return res
        .status(400)
        .json({ ok: false, error: "productId required" });
    const { products, idx } = findProductById(pid);
    if (idx < 0)
      return res
        .status(404)
        .json({ ok: false, error: "product_not_found" });
    products[idx].image = imageUrl;
    writeProducts(products);
    res.json({ ok: true, product: products[idx] });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: "save_error" });
  }
});
// ====== 郵便番号 → 住所（ZipCloud API） ======
async function lookupAddressByZip(zip) {
  const z = String(zip || "").trim();
  if (!/^\d{7}$/.test(z)) {
    throw new Error("invalid_zip");
  }

  const url = `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${z}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("zipcloud_http_error");

  const data = await res.json();
  if (data.status !== 200 || !Array.isArray(data.results) || data.results.length === 0) {
    throw new Error("zip_not_found");
  }

  const r = data.results[0];

  // r.address1: 都道府県, address2: 市区町村, address3: 町域
  return {
    zip: z,
    prefecture: r.address1 || "",
    city: r.address2 || "",
    town: r.address3 || "",
  };
}
// ★ 郵便番号からざっくり住所情報を返すダミー関数
async function lookupAddressByZip(zip) {
  const digits = (zip || "").replace(/\D/g, "");
  if (!digits || digits.length < 7) {
    return null;
  }

  // ここで本当はAPIに問い合わせたり、CSVを引いたりする。
  // いったんは「○○-○○○○付近です」と言うだけの簡易版。
  return {
    postal: digits.replace(/(\d{3})(\d{4})/, "$1-$2"),
    prefecture: "",
    city: "",
    address1: "",
  };
}

// ====== Twilio Voice (電話自動応答：郵便番号テスト版) ======
app.post(
  "/twilio/voice",
  express.urlencoded({ extended: false }),
  (req, res) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="7" timeout="10" action="/twilio/voice/postal" method="POST">
    <Say language="ja-JP" voice="alice">
お電話ありがとうございます。手造りえびせんべい磯屋です。
郵便番号によるご案内テスト中です。
これから、郵便番号7桁を、ハイフンなしで押してください。
  </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;

    res.type("text/xml").send(twiml);
  }
);
// ====== Twilio Voice: 郵便番号入力後のハンドラ ======
app.post(
  "/twilio/voice/postal",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const digits = (req.body.Digits || "").replace(/\D/g, "");

    let message = "";

    if (!digits) {
      message =
        "入力が確認できませんでした。恐れ入りますが、もう一度おかけ直しください。";
    } else if (digits.length < 7) {
      message =
        "郵便番号は7桁でお願いします。お手数ですが、もう一度おかけ直しください。";
    } else {
      // ★ ここで await が使えるのは、関数を async にしたから
      const addr = await lookupAddressByZip(digits);
      const jpZip = digits.replace(/(\d{3})(\d{4})/, "$1-$2");

      if (addr) {
        message =
          `ありがとうございます。郵便番号、${jpZip} 付近ですね。` +
          "詳しいご住所とお名前は、ラインアプリのトーク画面でお伺いさせていただきます。";
      } else {
        message =
          `ありがとうございます。郵便番号、${jpZip} を承りました。` +
          "詳しいご住所とお名前は、ラインアプリのトーク画面でお伺いさせていただきます。";
      }
    }

    const twiml =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Response>' +
      '<Say language="ja-JP" voice="alice">' +
      message +
      '</Say>' +
      '</Response>';

    res.type("text/xml").send(twiml);
  }
);


    // ① 最初の案内：郵便番号7桁を押してもらう
    if (step === "start") {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="7" action="/twilio/voice?step=zip" method="POST">
    <Say language="ja-JP" voice="alice">
      お電話ありがとうございます。手造りえびせんべい、磯屋です。
      お届け用の送料をご案内いたします。
      はじめに、お届け先の郵便番号7桁を、ハイフンなしで入力してください。
      入力が終わりましたら、そのまましばらくお待ちください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;
      return sendTwiml(twiml);
    }

    // ② 郵便番号を受け取って、住所→地域→送料を算出
    if (step === "zip") {
      // 郵便番号のバリデーション
      if (!/^\d{7}$/.test(digits)) {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    郵便番号は、7桁の数字で入力してください。
    例として、四四三、ゼロゼロゼロ一、のように続けて押してください。
  </Say>
  <Redirect method="POST">/twilio/voice?step=start</Redirect>
</Response>`;
        return sendTwiml(twiml);
      }

      try {
        const addr = await lookupAddressByZip(digits);

        // 既存の detectRegionFromAddress / SHIPPING_BY_REGION を流用
        const region = detectRegionFromAddress({
          prefecture: addr.prefecture,
          address1: addr.town,
        });

        const shipping = region ? (SHIPPING_BY_REGION[region] || 0) : 0;

        // 読み上げ用テキスト
        const addrText = `${addr.prefecture}、${addr.city}、${addr.town}`;
        const regionText = region ? region : "地域不明";
        const shippingText =
          shipping > 0 ? `${shipping}円` : "送料が自動判定できませんでした。";

        // 確認用の Gather（1: OK, 2: 入力やり直し）
        const q = qstr({
          step: "confirm",
          zip: addr.zip,
          pref: addr.prefecture,
          city: addr.city,
          town: addr.town,
          region: region || "",
          shipping: shipping,
        });

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="1" action="/twilio/voice?${q}" method="POST">
    <Say language="ja-JP" voice="alice">
      郵便番号、${digits} に対応するご住所は、
      ${addrText} です。
      お届け先の地域は、${regionText}。
      送料は、およそ、${shippingText} となります。
      内容にお間違いがなければ、1 を押してください。
      修正する場合は、2 を押してください。
    </Say>
  </Gather>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度おかけ直しください。
  </Say>
</Response>`;
        return sendTwiml(twiml);
      } catch (e) {
        console.error("lookupAddressByZip error:", e);
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    申し訳ありません。郵便番号から住所を取得できませんでした。
    お手数ですが、時間をおいて、もう一度おかけ直しください。
  </Say>
</Response>`;
        return sendTwiml(twiml);
      }
    }

    // ③ 1:OK / 2:やり直し の結果を受け取る
    if (step === "confirm") {
      const key = digits; // 1 or 2 など
      const zip = String(req.query.zip || "");
      const pref = String(req.query.pref || "");
      const city = String(req.query.city || "");
      const town = String(req.query.town || "");
      const region = String(req.query.region || "");
      const shipping = Number(req.query.shipping || 0);

      if (key === "1") {
        // ここから先で「代引き注文受付」などに繋げてもOK
        const addrText = `${pref}、${city}、${town}`;
        const shippingText =
          shipping > 0 ? `${shipping}円` : "送料が自動判定できませんでした。";

        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    ありがとうございます。
    ご住所は、${addrText}。
    送料は、${shippingText} で承ります。
    この内容でのご案内は、LINE公式アカウントから、あらためてご連絡いたします。
    お電話、ありがとうございました。
  </Say>
</Response>`;
        return sendTwiml(twiml);
      }

      if (key === "2") {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    郵便番号の入力をやり直します。
  </Say>
  <Redirect method="POST">/twilio/voice?step=start</Redirect>
</Response>`;
        return sendTwiml(twiml);
      }

      // 1,2 以外 → やり直し
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    入力が確認できませんでした。お手数ですが、もう一度、郵便番号の入力からお願いいたします。
  </Say>
  <Redirect method="POST">/twilio/voice?step=start</Redirect>
</Response>`;
      return sendTwiml(twiml);
    }

    // 万が一 step が変な値だったときのフォールバック
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Redirect method="POST">/twilio/voice?step=start</Redirect>
</Response>`;
    return sendTwiml(twiml);
  }
);


// ====== Webhook ======
app.post(
  "/webhook",
  line.middleware(config),
  async (req, res) => {
    try {
      const events = req.body.events || [];
      await Promise.all(events.map(handleEvent));
      res.status(200).end();
    } catch (err) {
      const detail =
        err?.originalError?.response?.data ||
        err?.response?.data ||
        err?.stack ||
        err;
      console.error(
        "Webhook Error detail:",
        JSON.stringify(detail, null, 2)
      );
      res.status(500).end();
    }
  }
);

// ====== イベント処理 ======
async function handleEvent(ev) {
  try {
    // ===== message =====
    if (ev.type === "message" && ev.message?.type === "text") {
      try {
        const rec = {
          ts: new Date().toISOString(),
          userId: ev.source?.userId || "",
          type: "text",
          len: (ev.message.text || "").length,
        };
        fs.appendFileSync(
          MESSAGES_LOG,
          JSON.stringify(rec) + "\n",
          "utf8"
        );
      } catch {}

      const sessions = readSessions();
      const uid = ev.source?.userId || "";
      const sess = sessions[uid] || null;
      const text = (ev.message.text || "").trim();
      const t = text.replace(/\s+/g, " ").trim();

      // ★「問い合わせ」最優先
      if (t === "問い合わせ") {
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text:
            "お問い合わせありがとうございます。\n" +
            "このままトークにご質問内容を送ってください。\n" +
            "スタッフが確認して返信します。",
        });
        return;
      }

      // ★ 久助テキスト注文
      const kusukeRe = /^久助(?:\s+(\d+))?$/i;
      const km = kusukeRe.exec(text);
      if (km) {
        const qtyStr = km[1];
        if (!qtyStr) {
          sessions[uid] = { await: "kusukeQty" };
          writeSessions(sessions);
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text:
              "久助の個数を半角数字で入力してください（例：2）",
          });
          return;
        }
        const qty = Math.max(
          1,
          Math.min(99, Number(qtyStr))
        );
        await client.replyMessage(
          ev.replyToken,
          methodFlex("kusuke-250", qty)
        );
        return;
      }

      if (sess?.await === "kusukeQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text:
              "半角数字で入力してください（例：2）",
          });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        delete sessions[uid];
        writeSessions(sessions);
        await client.replyMessage(
          ev.replyToken,
          methodFlex("kusuke-250", qty)
        );
        return;
      }

      // ★ その他フロー
      if (sess?.await === "otherName") {
        const name = (text || "").slice(0, 50).trim();
        if (!name) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "商品名を入力してください。",
          });
          return;
        }
        sessions[uid] = {
          await: "otherQty",
          temp: { name },
        };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: `「${name}」ですね。個数を半角数字で入力してください。例：2`,
        });
        return;
      }

      if (sess?.await === "pickupName") {
        const nameText = (text || "").trim();
        if (!nameText) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "お名前が空です。注文者のお名前を入力してください。",
          });
          return;
        }

        const temp = sess.temp || {};
        const id = temp.id;
        const qty = Math.max(1, Math.min(99, Number(temp.qty) || 1));

        // セッションはここで終了
        delete sessions[uid];
        writeSessions(sessions);

        // 商品取得
        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = {
            id,
            name: decodeURIComponent(encName || "その他"),
            price: Number(priceStr || 0),
          };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
        }

        if (!product) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "商品が見つかりませんでした。もう一度最初からお試しください。",
          });
          return;
        }

        // ★ 店頭受取・現金のみで最終確認画面を表示（お名前付き）
        await client.replyMessage(
          ev.replyToken,
          confirmFlex(product, qty, "pickup", "", "cash", LIFF_ID, {
            pickupName: nameText,
          })
        );
        return;
      }

      if (sess?.await === "otherQty") {
        const n = (text || "").trim();
        if (!/^\d+$/.test(n)) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text:
              "個数は半角数字で入力してください。例：2",
          });
          return;
        }
        const qty = Math.max(1, Math.min(99, Number(n)));
        const name = sess.temp?.name || "その他";
        delete sessions[uid];
        writeSessions(sessions);
        const id = `other:${encodeURIComponent(
          name
        )}:0`;
        await client.replyMessage(
          ev.replyToken,
          methodFlex(id, qty)
        );
        return;
      }

      // ★ 管理者コマンド
      if (
        ev.source?.userId &&
        ADMIN_USER_ID &&
        ev.source.userId === ADMIN_USER_ID
      ) {
        if (t === "在庫一覧") {
          const items = readProducts()
            .map(
              (p) =>
                `・${p.name}（${p.id}）：${Number(p.stock || 0)}個`
            )
            .join("\n");
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: items || "商品がありません。",
          });
          return;
        }

        if (t.startsWith("在庫 ")) {
          const parts = t.split(" ");
          if (parts.length === 2) {
            const pid = resolveProductId(parts[1]);
            const { product } = findProductById(pid);
            if (!product)
              await client.replyMessage(ev.replyToken, {
                type: "text",
                text: "商品が見つかりません。",
              });
            else
              await client.replyMessage(ev.replyToken, {
                type: "text",
                text: `${product.name}：${Number(
                  product.stock || 0
                )}個`,
              });
            return;
          }

          if (parts.length === 4) {
            const op = parts[1];
            const pid = resolveProductId(parts[2]);
            const val = Number(parts[3]);
            try {
              if (op === "設定" || op.toLowerCase() === "set") {
                const r = setStock(
                  pid,
                  val,
                  "admin-text"
                );
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, {
                  type: "text",
                  text: `[設定] ${
                    product?.name || pid
                  }\n${r.before} → ${r.after} 個`,
                });
                await maybeLowStockAlert(
                  pid,
                  product?.name || pid,
                  r.after
                );
                return;
              }
              if (
                op === "追加" ||
                op === "+" ||
                op.toLowerCase() === "add"
              ) {
                const r = addStock(
                  pid,
                  Math.abs(val),
                  "admin-text"
                );
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, {
                  type: "text",
                  text: `[追加] ${
                    product?.name || pid
                  }\n${r.before} → ${r.after} 個（+${Math.abs(
                    val
                  )}）`,
                });
                return;
              }
              if (
                op === "減少" ||
                op === "-" ||
                op.toLowerCase() === "sub"
              ) {
                const r = addStock(
                  pid,
                  -Math.abs(val),
                  "admin-text"
                );
                const { product } = findProductById(pid);
                await client.replyMessage(ev.replyToken, {
                  type: "text",
                  text: `[減少] ${
                    product?.name || pid
                  }\n${r.before} → ${r.after} 個（-${Math.abs(
                    val
                  )}）`,
                });
                await maybeLowStockAlert(
                  pid,
                  product?.name || pid,
                  r.after
                );
                return;
              }
            } catch (e) {
              await client.replyMessage(ev.replyToken, {
                type: "text",
                text: `在庫コマンドエラー：${
                  e.message || e
                }`,
              });
              return;
            }
          }

          if (
            parts.length === 3 &&
            /^[+-]\d+$/.test(parts[2])
          ) {
            const pid = resolveProductId(parts[1]);
            const delta = Number(parts[2]);
            try {
              const r = addStock(
                pid,
                delta,
                "admin-text"
              );
              const { product } = findProductById(pid);
              const sign = delta >= 0 ? "+" : "";
              await client.replyMessage(ev.replyToken, {
                type: "text",
                text: `[調整] ${
                  product?.name || pid
                }\n${r.before} → ${r.after} 個（${sign}${delta}）`,
              });
              await maybeLowStockAlert(
                pid,
                product?.name || pid,
                r.after
              );
            } catch (e) {
              await client.replyMessage(ev.replyToken, {
                type: "text",
                text: `在庫コマンドエラー：${
                  e.message || e
                }`,
              });
            }
            return;
          }

          await client.replyMessage(ev.replyToken, {
            type: "text",
            text:
              "在庫コマンド使い方：\n" +
              "・在庫一覧\n" +
              "・在庫 久助\n" +
              "・在庫 設定 久助 50\n" +
              "・在庫 追加 久助 10\n" +
              "・在庫 減少 久助 3\n" +
              "・在庫 久助 +5 / 在庫 久助 -2",
          });
          return;
        }

        if (t.startsWith("予約連絡 ")) {
          const m =
            /^予約連絡\s+(\S+)\s+([\s\S]+)$/.exec(t);
          if (!m) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text:
                "使い方：予約連絡 {商品名またはID} {本文}",
            });
            return;
          }
          const pid = resolveProductId(m[1]);
          const message = m[2].trim();
          const items = readLogLines(
            RESERVATIONS_LOG,
            100000
          ).filter(
            (r) => r && r.productId === pid && r.userId
          );
          const userIds = Array.from(
            new Set(items.map((r) => r.userId))
          );
          if (userIds.length === 0) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `予約者が見つかりませんでした。（${pid}）`,
            });
            return;
          }
          try {
            const chunk = 500;
            for (
              let i = 0;
              i < userIds.length;
              i += chunk
            ) {
              await client.multicast(
                userIds.slice(i, i + chunk),
                [{ type: "text", text: message }]
              );
            }
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `予約者 ${userIds.length}名に送信しました。`,
            });
          } catch (e) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `送信エラー：${
                e?.response?.data?.message ||
                e.message ||
                e
              }`,
            });
          }
          return;
        }

        if (t.startsWith("予約連絡開始 ")) {
          const m =
            /^予約連絡開始\s+(\S+)\s+([\s\S]+)$/.exec(t);
          if (!m) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text:
                "使い方：予約連絡開始 {商品名/ID} {本文}",
            });
            return;
          }
          const pid = resolveProductId(m[1]);
          const message = m[2].trim();
          const userIds = buildReservationQueue(pid);
          const state = readNotifyState();
          state[pid] = {
            idx: 0,
            userIds,
            message,
            updatedAt: new Date().toISOString(),
          };
          state.__lastPid = pid;
          writeNotifyState(state);

          if (userIds.length === 0) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `予約者がいません。（${pid}）`,
            });
            return;
          }
          try {
            await client.pushMessage(userIds[0], {
              type: "text",
              text: message,
            });
            state[pid].idx = 1;
            state[pid].updatedAt = new Date().toISOString();
            writeNotifyState(state);
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `開始：${pid}\n1/${userIds.length} 件送信しました。次へ進むには「予約連絡次」と送ってください。`,
            });
          } catch (e) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `送信エラー：${
                e?.response?.data?.message ||
                e.message ||
                e
              }`,
            });
          }
          return;
        }

        if (
          t === "予約連絡次" ||
          t.startsWith("予約連絡次 ")
        ) {
          const m =
            /^予約連絡次(?:\s+(\S+))?(?:\s+(\d+))?$/.exec(t);
          const pid = resolveProductId(
            m?.[1] || readNotifyState().__lastPid || ""
          );
          const count = Math.max(
            1,
            Number(m?.[2] || 1)
          );
          const state = readNotifyState();
          const st = state[pid];
          if (!pid || !st) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text:
                "先に「予約連絡開始 {商品} {本文}」を実行してください。",
            });
            return;
          }

          const { userIds, message } = st;
          let { idx } = st;
          const total = userIds.length;
          if (idx >= total) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: `完了済み：${idx}/${total}`,
            });
            return;
          }

          let sent = 0;
          for (
            let i = 0;
            i < count && idx < total;
            i++, idx++
          ) {
            try {
              await client.pushMessage(userIds[idx], {
                type: "text",
                text: message,
              });
              sent++;
            } catch {}
          }
          state[pid].idx = idx;
          state[pid].updatedAt = new Date().toISOString();
          writeNotifyState(state);
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: `${sent}件送信：${idx}/${total}`,
          });
          return;
        }

        if (t.startsWith("予約連絡停止")) {
          const m =
            /^予約連絡停止(?:\s+(\S+))?$/.exec(t);
          const pid = resolveProductId(
            m?.[1] || readNotifyState().__lastPid || ""
          );
          const state = readNotifyState();
          if (pid && state[pid]) delete state[pid];
          if (state.__lastPid === pid) delete state.__lastPid;
          writeNotifyState(state);
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: `停止しました：${pid || "(未指定)"}`,
          });
          return;
        }
      }

      // ★ 一般ユーザー
      if (text === "直接注文") {
        await client.replyMessage(
          ev.replyToken,
          productsFlex(readProducts())
        );
        return;
      }

      // 久助は上で処理済み。それ以外のテキストは返信なし。
      return;
    }

    // ===== postback =====
    if (ev.type === "postback") {
      const d = ev.postback?.data || "";

      if (d === "other_start") {
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = { await: "otherName" };
        writeSessions(sessions);
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "その他の商品名を入力してください。",
        });
        return;
      }

      if (d.startsWith("order_qty?")) {
        const { id, qty } = parse(
          d.replace("order_qty?", "")
        );
        await client.replyMessage(
          ev.replyToken,
          qtyFlex(id, qty)
        );
        return;
      }

      if (d.startsWith("order_pickup_name?")) {
        const { id, qty } = parse(d.replace("order_pickup_name?", ""));
        const sessions = readSessions();
        const uid = ev.source?.userId || "";
        sessions[uid] = {
          await: "pickupName",
          temp: { id, qty },
        };
        writeSessions(sessions);

        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: "注文者の氏名を入力してください。\n例：磯屋 太郎",
        });
        return;
      }

      if (d.startsWith("order_method?")) {
        const { id, qty } = parse(
          d.replace("order_method?", "")
        );
        await client.replyMessage(
          ev.replyToken,
          methodFlex(id, qty)
        );
        return;
      }

      if (d.startsWith("order_region?")) {
        const { id, qty, method } = parse(
          d.replace("order_region?", "")
        );
        if (method === "delivery") {
          await client.replyMessage(
            ev.replyToken,
            regionFlex(id, qty)
          );
        } else {
          await client.replyMessage(
            ev.replyToken,
            paymentFlex(id, qty, "pickup", "")
          );
        }
        return;
      }

      if (d.startsWith("order_payment?")) {
        let { id, qty, method, region } = parse(
          d.replace("order_payment?", "")
        );
        method = (method || "").trim();
        region = (region || "").trim();
        if (region === "-") region = "";

        if (method === "pickup") {
          await client.replyMessage(
            ev.replyToken,
            paymentFlex(id, qty, "pickup", "")
          );
          return;
        }
        if (method === "delivery") {
          if (!region) {
            await client.replyMessage(
              ev.replyToken,
              regionFlex(id, qty)
            );
            return;
          }
          await client.replyMessage(
            ev.replyToken,
            paymentFlex(id, qty, "delivery", region)
          );
          return;
        }
        await client.replyMessage(
          ev.replyToken,
          methodFlex(id, qty)
        );
        return;
      }

      if (d.startsWith("order_confirm_view?")) {
        const { id, qty, method, region, payment } = parse(
          d.replace("order_confirm_view?", "")
        );
        let product;
        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = {
            id,
            name: decodeURIComponent(encName || "その他"),
            price: Number(priceStr || 0),
          };
        } else {
          const products = readProducts();
          product = products.find((p) => p.id === id);
          if (!product) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: "商品が見つかりませんでした。",
            });
            return;
          }
        }

        // ★ 直接注文の住所入力は LIFF_ID_DIRECT_ADDRESS を使用
        await client.replyMessage(
          ev.replyToken,
          confirmFlex(
            product,
            qty,
            method,
            region,
            payment,
            LIFF_ID_DIRECT_ADDRESS
          )
        );
        return;
      }

      if (d === "order_back") {
        await client.replyMessage(
          ev.replyToken,
          productsFlex(readProducts())
        );
        return;
      }

      if (d.startsWith("order_confirm?")) {
        const parsed = parse(d.replace("order_confirm?", ""));
        const id = parsed.id;
        const qty = parsed.qty;
        let method = parsed.method;
        let region = parsed.region;
        const payment = parsed.payment;
        const pickupName = (parsed.pickupName || "").trim(); // ★ 追加

        const need = Math.max(1, Number(qty) || 1);

        let product = null;
        let products = readProducts();
        let idx = products.findIndex((p) => p.id === id);

        if (String(id).startsWith("other:")) {
          const parts = String(id).split(":");
          const encName = parts[1] || "";
          const priceStr = parts[2] || "0";
          product = {
            id,
            name: decodeURIComponent(encName || "その他"),
            price: Number(priceStr || 0),
            stock: Infinity,
          };
          idx = -1;
        } else {
          if (idx === -1) {
            await client.replyMessage(ev.replyToken, {
              type: "text",
              text: "商品が見つかりませんでした。",
            });
            return;
          }
          product = products[idx];
          if (!product.stock || product.stock < need) {
            await client.replyMessage(
              ev.replyToken,
              reserveOffer(product, need, product.stock || 0)
            );
            return;
          }
          products[idx].stock = Number(product.stock) - need;
          writeProducts(products);
          await maybeLowStockAlert(
            product.id,
            product.name,
            products[idx].stock
          );
        }

        const regionFee =
          method === "delivery" ? SHIPPING_BY_REGION[region] || 0 : 0;
        const codFee = payment === "cod" ? COD_FEE : 0;
        const subtotal = Number(product.price) * need;
        const total = subtotal + regionFee + codFee;

        const addrBook = readAddresses();
        const addr = addrBook[ev.source?.userId || ""] || null;

        const order = {
          ts: new Date().toISOString(),
          userId: ev.source?.userId || "",
          productId: product.id,
          productName: product.name,
          qty: need,
          price: Number(product.price),
          subtotal,
          region,
          shipping: regionFee,
          payment,
          codFee,
          total,
          method,
          address: addr,
          image: product.image || "",
          pickupName, // ★ ログにも残す
        };
        fs.appendFileSync(ORDERS_LOG, JSON.stringify(order) + "\n", "utf8");

        const payText =
          payment === "cod"
            ? `代金引換（+${yen(COD_FEE)})`
            : payment === "bank"
            ? "銀行振込"
            : "現金（店頭）";

        const userLines = [
          "ご注文ありがとうございます！",
          `受取方法：${
            method === "pickup"
              ? "店頭受取（送料0円）"
              : `宅配（${region}）`
          }`,
          `支払い：${payText}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)}`,
          `送料：${yen(regionFee)}`,
          `代引き手数料：${yen(codFee)}`,
          `合計：${yen(total)}`,
        ];

        // ★ ユーザー向けメッセージにも名前を表示
        if (method === "pickup" && pickupName) {
          userLines.push("", `お名前：${pickupName}`);
        }

        if (method === "delivery") {
          userLines.push("");
          userLines.push(
            addr
              ? `お届け先：${addr.postal || ""} ${
                  addr.prefecture || ""
                }${addr.city || ""}${addr.address1 || ""}${
                  addr.address2 ? " " + addr.address2 : ""
                }\n氏名：${addr.name || ""}\n電話：${
                  addr.phone || ""
                }`
              : "住所未登録です。メニューの「住所を入力（LIFF）」から登録してください。"
          );
        } else {
          userLines.push(
            "",
            "店頭でのお受け取りをお待ちしています。"
          );
        }

        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: userLines.join("\n"),
        });

        // ★ 管理者向けメッセージにも名前を追加
        const adminMsg = [
          "🧾 新規注文",
          `ユーザーID：${ev.source?.userId || ""}`,
          `商品：${product.name}`,
          `数量：${need}個`,
          `小計：${yen(subtotal)} / 送料：${yen(
            regionFee
          )} / 代引：${yen(codFee)} / 合計：${yen(total)}`,
          `受取：${method}${
            method === "delivery" ? `（${region}）` : ""
          } / 支払：${payment}`,
          pickupName ? `店頭お呼び出し名：${pickupName}` : "",
          addr
            ? `住所：${addr.postal || ""} ${
                addr.prefecture || ""
              }${addr.city || ""}${addr.address1 || ""}${
                addr.address2 ? " " + addr.address2 : ""
              }\n氏名：${addr.name || ""} / TEL：${
                addr.phone || ""
              }`
            : method === "delivery"
            ? "住所：未登録"
            : "",
          product.image ? `画像：${product.image}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        try {
          if (ADMIN_USER_ID)
            await client.pushMessage(ADMIN_USER_ID, {
              type: "text",
              text: adminMsg,
            });
          if (MULTICAST_USER_IDS.length > 0)
            await client.multicast(MULTICAST_USER_IDS, {
              type: "text",
              text: adminMsg,
            });
        } catch {}

        return;
      }

      if (d.startsWith("order_reserve?")) {
        const { id, qty } = parse(
          d.replace("order_reserve?", "")
        );
        const products = readProducts();
        const product = products.find((p) => p.id === id);
        if (!product) {
          await client.replyMessage(ev.replyToken, {
            type: "text",
            text: "商品が見つかりませんでした。",
          });
          return;
        }

        const r = {
          ts: new Date().toISOString(),
          userId: ev.source?.userId || "",
          productId: product.id,
          productName: product.name,
          qty: Math.max(1, Number(qty) || 1),
          status: "reserved",
        };
        fs.appendFileSync(
          RESERVATIONS_LOG,
          JSON.stringify(r) + "\n",
          "utf8"
        );

        await client.replyMessage(ev.replyToken, {
          type: "text",
          text: [
            "予約を受け付けました。入荷次第ご案内します。",
            `商品：${product.name}`,
            `数量：${r.qty}個`,
          ].join("\n"),
        });

        try {
          const adminReserve = [
            "📝 予約受付",
            `ユーザーID：${ev.source?.userId || ""}`,
            `商品：${product.name}`,
            `数量：${r.qty}個`,
          ].join("\n");
          if (ADMIN_USER_ID)
            await client.pushMessage(ADMIN_USER_ID, {
              type: "text",
              text: adminReserve,
            });
          if (MULTICAST_USER_IDS.length > 0)
            await client.multicast(
              MULTICAST_USER_IDS,
              { type: "text", text: adminReserve }
            );
        } catch {}
        return;
      }
    }
  } catch (err) {
    console.error(
      "handleEvent error:",
      err?.response?.data || err?.stack || err
    );
    if (ev.replyToken) {
      try {
        await client.replyMessage(ev.replyToken, {
          type: "text",
          text:
            "エラーが発生しました。もう一度お試しください。",
        });
      } catch {}
    }
  }
}

// ====== Health checks ======
app.get("/health", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);
app.get("/healthz", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);
app.head("/health", (_req, res) => res.status(200).end());
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    env: {
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN:
        !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET:
        !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
      BANK_INFO: !!BANK_INFO,
      BANK_NOTE: !!BANK_NOTE,
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      STRIPE_PUBLISHABLE_KEY: !!process.env.STRIPE_PUBLISHABLE_KEY,
    },
  });
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log("   Webhook: POST /webhook");
  console.log(
    "   LIFF address page: /public/liff-address.html  (open via https://liff.line.me/LIFF_ID_DIRECT_ADDRESS)"
  );
});
