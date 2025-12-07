"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const line = require("@line/bot-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio Webhook は x-www-form-urlencoded で来る
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, "public");
app.use("/public", express.static(PUBLIC_DIR));
// ====== データパス ======
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");
const PHONE_ORDERS_LOG = path.join(DATA_DIR, "orders-phone-cod.log");

// ====== LINE 設定（管理者通知用・任意） ======
const LINE_CONFIG = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();

const hasLineConfig =
  !!LINE_CONFIG.channelAccessToken && !!LINE_CONFIG.channelSecret;

const lineClient = hasLineConfig ? new line.Client(LINE_CONFIG) : null;

// ====== 共通ユーティリティ ======
const COD_FEE = 330;

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

function safeReadJSON(p, fb) {
  try {
    if (!fs.existsSync(p)) return fb;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}

function readProducts() {
  return safeReadJSON(PRODUCTS_PATH, []);
}

function readAddresses() {
  return safeReadJSON(ADDRESSES_PATH, {});
}

function yen(n) {
  return `${Number(n || 0).toLocaleString("ja-JP")}円`;
}

function xmlWrap(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${body}\n</Response>`;
}

function escXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function digitsOnly(raw) {
  return String(raw || "").replace(/[^0-9]/g, "");
}

// 住所→地域判定（server.js と同じロジック）
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
  if (/(沖縄)/.test(hay)) return "沖縄";
  return "";
}

// 会員コードで住所検索
function normalizeMemberCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function findAddressByMemberCode(inputDigits) {
  if (!inputDigits) return null;
  const normalizedInput = normalizeMemberCode(inputDigits); // 例: "123456"
  const withPrefix = normalizeMemberCode("IS" + inputDigits); // 例: "IS123456"

  const book = readAddresses();
  const vals = Object.values(book);

  for (const addr of vals) {
    const mc = addr.memberCode || addr.membercode || "";
    if (!mc) continue;
    const norm = normalizeMemberCode(mc);
    if (norm === normalizedInput || norm === withPrefix) {
      return addr;
    }
  }
  return null;
}

// 商品メニュー音声を生成（最大9商品）
function buildProductMenuSpeech() {
  const products = readProducts();
  const list = products.slice(0, 9); // 1〜9番まで

  if (list.length === 0) {
    return {
      speech:
        "ただいま、電話でご注文いただける商品が登録されていません。恐れ入りますが、スタッフまでお問い合わせください。",
      products: [],
    };
  }

  const lines = [];
  lines.push("ご希望の商品を、番号でお選びください。");

  list.forEach((p, idx) => {
    const no = idx + 1;
    lines.push(`${no}番、${p.name}、${p.price}円。`);
  });

  lines.push("ご希望の番号を押して、シャープで確定してください。");

  return {
    speech: lines.join(" "),
    products: list,
  };
}

// 商品IDから商品を取得
function findProductById(productId) {
  const products = readProducts();
  const product = products.find((p) => p.id === productId);
  return { products, product };
}

// 管理者へ通知（任意）
async function notifyAdmin(text) {
  if (!lineClient || !ADMIN_USER_ID) return;
  try {
    await lineClient.pushMessage(ADMIN_USER_ID, { type: "text", text });
  } catch (e) {
    console.error("notifyAdmin error:", e?.response?.data || e);
  }
}

// ====== LIFF 設定（電話用 会員住所登録 LIFF） ======
app.get("/api/liff/config", (_req, res) => {
  const liffId = (process.env.LIFF_ID_COD_REGISTER || "").trim();
  res.json({ liffId });
});

// ====== Health ======
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("OK");
});

// ====== Twilio 用 音声フロー ======

/**
 * エントリーポイント
 * Twilio の Voice URL: https://xxx.onrender.com/twilio/cod/voice
 */
app.post("/twilio/cod/voice", (req, res) => {
  try {
    console.log("[/twilio/cod/voice] body =", req.body);

    const { speech, products } = buildProductMenuSpeech();

    if (products.length === 0) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  ただいま、電話注文を受け付けている商品がありません。 恐れ入りますが、スタッフまでお問い合わせください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const xml = xmlWrap(
      `
<Gather input="dtmf" numDigits="2" timeout="10" finishOnKey="#"
        action="/twilio/cod/product" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
</Say>
<Hangup/>
`.trim()
    );

    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/voice error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

/**
 * 商品番号の決定
 * Digits = "1" や "1#" など → 数字だけ抽出
 */
app.post("/twilio/cod/product", (req, res) => {
  try {
    console.log("[/twilio/cod/product] body =", req.body);

    const digitsRaw = (req.body.Digits || "").toString();
    const d = digitsOnly(digitsRaw);
    const idx = Number(d);

    const { products } = buildProductMenuSpeech();
    if (!d || !idx || idx < 1 || idx > products.length) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  商品番号の入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const product = products[idx - 1];

    const speech =
      `${product.name} を選択されました。 ` +
      `個数を 1 から 99 の間で押して、最後にシャープを押してください。 ` +
      `例えば 2個 の場合は 2シャープ、 12個 の場合は 1 2 シャープ のように入力してください。`;

    const xml = xmlWrap(
      `
<Gather input="dtmf" numDigits="2" timeout="10" finishOnKey="#"
        action="/twilio/cod/qty?pid=${encodeURIComponent(
          product.id
        )}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  個数の入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );

    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/product error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

/**
 * 個数入力 → 確認ステップへ
 */
app.post("/twilio/cod/qty", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const digitsRaw = (req.body.Digits || "").toString();
    const digits = digitsOnly(digitsRaw);
    const qty = Math.max(1, Math.min(99, Number(digits) || 0));

    console.log("[/twilio/cod/qty] pid=", pid, "digitsRaw=", digitsRaw, "digits=", digits, "qty=", qty);

    const { product } = findProductById(pid);

    if (!pid || !product || !digits || !qty) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  個数の入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const confirmSpeech =
      `${product.name} を ${qty}個 ですね。 よろしければ 1 を、 ` +
      `個数をやり直す場合は 2 を押してください。`;

    const xml = xmlWrap(
      `
<Gather input="dtmf" numDigits="1" timeout="10"
        action="/twilio/cod/qty-confirm?pid=${encodeURIComponent(
          pid
        )}&qty=${qty}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(confirmSpeech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );

    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/qty error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

/**
 * 個数 OK / やり直し
 */
app.post("/twilio/cod/qty-confirm", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const qty = Math.max(1, Math.min(99, Number(req.query.qty || 1)));

    const digitsRaw = (req.body.Digits || "").toString();
    const digits = digitsOnly(digitsRaw);
    const choice = Number(digits || 0);

    console.log(
      "[/twilio/cod/qty-confirm] pid=",
      pid,
      "qty=",
      qty,
      "digitsRaw=",
      digitsRaw,
      "digits=",
      digits,
      "choice=",
      choice
    );

    const { product } = findProductById(pid);
    if (!product) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  商品情報の取得に失敗しました。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    if (choice === 1) {
      // 個数OK → 会員コード入力へ
      const speech =
        `${product.name} を ${qty}個 で承ります。 ` +
        `次に、会員コードを 6桁の数字で入力し、最後にシャープを押してください。`;

      const xml = xmlWrap(
        `
<Gather input="dtmf" numDigits="8" timeout="15" finishOnKey="#"
        action="/twilio/cod/member-confirm?pid=${encodeURIComponent(
          pid
        )}&qty=${qty}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  会員コードの入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );

      return res.type("text/xml").send(xml);
    }

    if (choice === 2) {
      // やり直し → 個数入力へ戻す
      const speech =
        `${product.name} の個数を、 1 から 99 の間で押して、最後にシャープを押してください。`;

      const xml = xmlWrap(
        `
<Gather input="dtmf" numDigits="2" timeout="10" finishOnKey="#"
        action="/twilio/cod/qty?pid=${encodeURIComponent(
          pid
        )}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  個数の入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/qty-confirm error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

/**
 * 会員コード確定 → 住所検索 → 送料＋代引き手数料＋合計を読み上げ
 */
app.post("/twilio/cod/member-confirm", async (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const qty = Math.max(1, Math.min(99, Number(req.query.qty || 1)));

    const digitsRaw = (req.body.Digits || "").toString();
    const digits = digitsOnly(digitsRaw);

    console.log(
      "[/twilio/cod/member-confirm] pid=",
      pid,
      "qty=",
      qty,
      "digitsRaw=",
      digitsRaw,
      "digits=",
      digits
    );

    const { product } = findProductById(pid);
    if (!product) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  商品情報の取得に失敗しました。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    if (!digits) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  会員コードの入力が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const addr = findAddressByMemberCode(digits);

    let addrText = "";
    let region = "";
    if (!addr) {
      addrText =
        "会員コードから住所が見つかりませんでした。送料は 0円 として計算いたしますが、後ほど店舗からご確認のご連絡をさせていただきます。";
    } else {
      addrText =
        `お届け先は、` +
        `${addr.prefecture || ""}${addr.city || ""}${
          addr.address1 || ""
        } ` +
        `${addr.address2 || ""}、 ` +
        `${addr.name || ""} 様 です。`;
      region = detectRegionFromAddress(addr);
    }

    const subtotal = Number(product.price || 0) * qty;
    const shipping = region ? SHIPPING_BY_REGION[region] || 0 : 0;
    const codFee = COD_FEE;
    const total = subtotal + shipping + codFee;

    // 音声メッセージ
    const speechLines = [];

    speechLines.push("ご注文ありがとうございます。");
    speechLines.push(
      `${product.name} を、 ${qty}個。 商品代金は、${subtotal}円 です。`
    );
    if (region) {
      speechLines.push(
        `配送地域は、${region} です。 送料は、${shipping}円 です。`
      );
    } else {
      speechLines.push(
        `送料は、0円 として仮計算いたします。後ほど、正しい送料をご案内いたします。`
      );
    }
    speechLines.push(`代引き手数料は、${COD_FEE}円 です。`);
    speechLines.push(`お支払い合計は、${total}円 です。`);
    if (addrText) speechLines.push(addrText);
    speechLines.push("この内容でご注文をお受けいたしました。ありがとうございました。");

    const speech = speechLines.join(" ");

    // ログ保存
    const orderLog = {
      ts: new Date().toISOString(),
      source: "phone-cod",
      productId: product.id,
      productName: product.name,
      qty,
      price: product.price,
      subtotal,
      shipping,
      codFee,
      total,
      region,
      memberCodeDigits: digits,
      address: addr || null,
    };

    try {
      fs.appendFileSync(
        PHONE_ORDERS_LOG,
        JSON.stringify(orderLog) + "\n",
        "utf8"
      );
    } catch (e) {
      console.error("PHONE_ORDERS_LOG write error:", e);
    }

    // 管理者にも通知（任意）
    try {
      const adminTextLines = [
        "🧾【電話・代引き注文】",
        `商品：${product.name}`,
        `数量：${qty}個`,
        `小計：${yen(subtotal)}`,
        `送料：${yen(shipping)}（地域：${region || "不明"}）`,
        `代引き手数料：${yen(codFee)}`,
        `合計：${yen(total)}`,
        `会員コード入力：${digits}`,
      ];
      if (addr) {
        adminTextLines.push(
          `住所：${addr.postal || ""} ${addr.prefecture || ""}${
            addr.city || ""
          }${addr.address1 || ""}${addr.address2 ? " " + addr.address2 : ""}`
        );
        adminTextLines.push(
          `氏名：${addr.name || ""} / TEL：${addr.phone || addr.tel || ""}`
        );
      } else {
        adminTextLines.push("※会員コードから住所を特定できませんでした。");
      }

      await notifyAdmin(adminTextLines.join("\n"));
    } catch (e) {
      console.error("notifyAdmin phone-cod error:", e);
    }

    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  ${escXml(speech)}
</Say>
<Hangup/>
`.trim()
    );

    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/member-confirm error:", e);
    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  システムエラーが発生しました。 恐れ入りますが、後ほどおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  }
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 server-phone-cod.js listening on ${PORT}`);
  console.log("Twilio Voice URL: POST /twilio/cod/voice");
});
