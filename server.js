// server.js — Mini app (Stripe + LIFF address + LINE通知)
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const stripeLib = require("stripe");

// ====== 基本設定 ======
const PORT = process.env.PORT || 3000;

// LIFF（住所入力・確認画面 共通）
const LIFF_ID = (process.env.LIFF_ID || "2008406620-G5j1gjzM").trim();

// LINE通知用
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 公開URL（Render の https ドメインを .env で指定推奨）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "")
  .trim()
  .replace(/\/+$/, "");

// LINE config（通知にのみ使用）
const lineConfig = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

const lineClient =
  lineConfig.channelAccessToken && lineConfig.channelSecret
    ? new line.Client(lineConfig)
    : null;

// Stripe 初期化（秘密鍵必須）
const stripeSecret = (process.env.STRIPE_SECRET || "").trim();
const stripe =
  stripeSecret !== "" ? stripeLib(stripeSecret) : null;

if (!stripe) {
  console.warn("⚠️ STRIPE_SECRET が設定されていません。/api/pay-stripe はエラーになります。");
}

// ====== パス定義 ======
const app = express();

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DATA_DIR, "orders.log");

// ====== ユーティリティ ======
const safeReadJSON = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

// 住所から地域判定
const SHIPPING_BY_REGION = {
  北海道: 1100,
  東北: 900,
  関東: 800,
  中部: 800,
  近畿: 900,
  中国: 1000,
  四国: 1000,
  九州: 1100,
  沖縄: 1400,
};

function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.addr1 || address.address1 || "").trim();
  const hay = pref || addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if (/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿)/.test(hay)) return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if (/沖縄/.test(hay)) return "沖縄";
  return "";
}

// ====== 初期データ ======
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    {
      id: "nori-akasha-340",
      name: "のりあかしゃ",
      price: 340,
      stock: 20,
      desc: "磯の香りたっぷりの定番商品です。",
      volume: "1袋",
      image: "",
    },
    {
      id: "square-nori-300",
      name: "四角のりせん",
      price: 300,
      stock: 15,
      desc: "パリッと四角いのりせんべい。",
      volume: "1袋",
      image: "",
    },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
  console.log(`ℹ️ ${PRODUCTS_PATH} を自動作成しました。`);
}

const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");
if (!fs.existsSync(ADDRESSES_PATH)) {
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify({}, null, 2), "utf8");
}

const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeAddresses = (book) =>
  fs.writeFileSync(ADDRESSES_PATH, JSON.stringify(book, null, 2), "utf8");
const readAddresses = () => safeReadJSON(ADDRESSES_PATH, {});

// ====== ミドルウェア ======
app.use("/api", express.json(), express.urlencoded({ extended: true }));
app.use("/public", express.static(PUBLIC_DIR));

// ルート/ヘルスチェック
app.get("/", (_req, res) => res.status(200).send("OK (Stripe mini app)"));
app.get("/health", (_req, res) =>
  res.status(200).type("text/plain").send("OK")
);

// 決済完了/失敗ページ（静的）
app.all("/public/confirm-success.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "confirm-success.html"));
});
app.all("/public/confirm-fail.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "confirm-fail.html"));
});

// ====== API: 商品一覧（ミニアプリ用） ======
app.get("/api/products", (_req, res) => {
  try {
    const items = readProducts().map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      stock: p.stock ?? 0,
      desc: p.desc || "",
      volume: p.volume || "",
      image: p.image || "",
    }));
    res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== LIFF API ======
// 住所保存
app.post("/api/liff/address", (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {};
    if (!userId) {
      return res.status(400).json({ ok: false, error: "userId required" });
    }
    const book = readAddresses();
    book[userId] = {
      name: String(addr.name || "").trim(),
      phone: String(addr.phone || "").trim(),
      postal: String(addr.postal || "").trim(),
      prefecture: String(addr.prefecture || "").trim(),
      city: String(addr.city || "").trim(),
      address1: String(addr.address1 || "").trim(),
      address2: String(addr.address2 || "").trim(),
      ts: new Date().toISOString(),
    };
    writeAddresses(book);
    res.json({ ok: true });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 自分の住所取得
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
    res.json({ ok: true, address: last });
  } catch {
    res.json({ ok: false, address: null });
  }
});

// LIFF 設定
app.get("/api/liff/config", (_req, res) => {
  res.json({ liffId: LIFF_ID });
});

// ====== 送料計算 API ======
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce(
      (sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0),
      0
    );

    const region = detectRegionFromAddress(address);
    const shipping = region ? SHIPPING_BY_REGION[region] || 0 : 0;
    const finalTotal = itemsTotal + shipping;

    res.json({ ok: true, itemsTotal, region, shipping, finalTotal });
  } catch (e) {
    console.error("/api/shipping error:", e);
    res.status(400).json({ ok: false, error: "shipping_error" });
  }
});

// ====== Stripe 決済（Checkout Session） ======
app.post("/api/pay-stripe", async (req, res) => {
  try {
    if (!stripe) {
      console.error("STRIPE_SECRET not set");
      return res.status(500).json({ ok: false, error: "stripe_not_configured" });
    }

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "no_items" });
    }

    const itemsTotal = Number(order.itemsTotal || 0);
    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);
    const finalTotal = Number(
      order.finalTotal || itemsTotal + shipping + codFee
    );

    console.log("[pay-stripe] items:", items);
    console.log(
      "[pay-stripe] itemsTotal:",
      itemsTotal,
      "shipping:",
      shipping,
      "codFee:",
      codFee,
      "finalTotal:",
      finalTotal
    );

    const line_items = [];

    // 商品行
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty = Number(it.qty) || 0;
      if (!qty || unit < 0) continue;
      line_items.push({
        price_data: {
          currency: "jpy",
          product_data: {
            name: String(it.name || it.id || "商品"),
          },
          unit_amount: unit,
        },
        quantity: qty,
      });
    }

    // 送料行
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

    // 将来代引き手数料を入れたい場合
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

    // ベースURL
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers.host;
    const base =
      PUBLIC_BASE_URL ||
      `${proto}://${host}`;

    const successUrl = `${base}/public/confirm-success.html`;
    const cancelUrl = `${base}/public/confirm-fail.html`;

    console.log("[pay-stripe] success_url:", successUrl);
    console.log("[pay-stripe] cancel_url :", cancelUrl);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        lineUserId: order.lineUserId || "",
        lineUserName: order.lineUserName || "",
      },
    });

    console.log("[pay-stripe] session.id:", session.id);
    res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("[pay-stripe] error:", e?.raw || e);
    res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

// ====== 決済完了通知 ======
// confirm-success.html から POST /api/order/complete
app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "no_items" });
    }

    const itemsText = items
      .map(
        (it) =>
          `・${it.name} × ${it.qty} = ${yen(
            (it.price || 0) * (it.qty || 0)
          )}`
      )
      .join("\n");

    const itemsTotal = Number(order.itemsTotal ?? 0);
    const shipping = Number(order.shipping ?? 0);
    const codFee = Number(order.codFee ?? 0);
    const finalTotal = Number(order.finalTotal ?? 0);

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
        `氏名：${a.name || ""}\n` +
        `TEL：${a.tel || a.phone || ""}`;
    }

    // ログ保存
    try {
      const log = {
        ts: new Date().toISOString(),
        ...order,
        source: "liff-stripe",
      };
      fs.appendFileSync(ORDERS_LOG, JSON.stringify(log) + "\n", "utf8");
    } catch (e) {
      console.error("orders.log write error:", e);
    }

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

    // 管理者へ通知
    try {
      if (lineClient && ADMIN_USER_ID) {
        await lineClient.pushMessage(ADMIN_USER_ID, {
          type: "text",
          text: adminMsg,
        });
      }
      if (lineClient && MULTICAST_USER_IDS.length > 0) {
        await lineClient.multicast(MULTICAST_USER_IDS, {
          type: "text",
          text: adminMsg,
        });
      }
    } catch (e) {
      console.error("admin push error:", e?.response?.data || e);
    }

    // 注文者へ明細
    try {
      if (lineClient && order.lineUserId) {
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

        await lineClient.pushMessage(order.lineUserId, {
          type: "text",
          text: userMsg,
        });
        console.log("user receipt push OK:", order.lineUserId);
      }
    } catch (e) {
      console.error("user receipt push error:", e?.response?.data || e);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== サーバー起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
