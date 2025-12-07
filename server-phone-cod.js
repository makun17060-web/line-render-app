"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio からは x-www-form-urlencoded
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ===== データファイル =====
const DATA_DIR = path.join(__dirname, "data");
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ADDRESSES_PATH = path.join(DATA_DIR, "addresses.json");

// ===== ユーティリティ =====
function safeReadJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("safeReadJSON error:", p, e.message || e);
    return fallback;
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

function escXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlWrap(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

// ===== 送料・地域判定 =====
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

function detectRegionFromAddress(address) {
  address = address || {};
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.address1 || address.addr1 || "").trim();
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

/**
 * 電話で入力された 6桁（例 123456）から addresses.json を逆引きする
 * memberCode: "IS123456" を想定
 */
function findAddressByMemberDigits(digits) {
  const numeric = String(digits || "").replace(/\D/g, "");
  if (!numeric) return null;

  const code1 = "IS" + numeric;
  const code2 = numeric;

  const book = readAddresses();
  for (const v of Object.values(book || {})) {
    if (!v) continue;
    if (v.memberCode === code1 || v.memberCode === code2) {
      return v;
    }
  }
  return null;
}

// ===== Health =====
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("OK");
});

// =================================================
//  Twilio フロー
//  start → product → qty → confirm → member
// =================================================

// 入口
app.post("/twilio/cod/start", (req, res) => {
  try {
    const products = readProducts();
    const target = products.slice(0, 9); // 1〜9番まで

    let menuSpeech;
    if (!target.length) {
      menuSpeech =
        "ただいま、電話でご注文いただける商品がありません。 恐れ入りますが、後ほどおかけ直しください。";
    } else {
      const lines = target.map((p, i) => {
        const no = i + 1;
        return `${p.name} は ${no} 番。`;
      });
      menuSpeech =
        "お電話ありがとうございます。 手造りえびせんべい磯屋です。 こちらは代引きご希望のお客様専用の自動受付です。" +
        "ご希望の商品番号を押してください。 " +
        lines.join(" ");
    }

    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  ${escXml(menuSpeech)}
</Say>
<Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/product" method="POST">
</Gather>
<Say language="ja-JP" voice="alice">
  入力が確認できませんでした。 お手数ですが、もう一度おかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/start error:", e);
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

// 商品番号 → 個数
app.post("/twilio/cod/product", (req, res) => {
  try {
    const digit = (req.body.Digits || "").trim();
    console.log("[/twilio/cod/product] Digits =", digit);

    const products = readProducts();
    const idx = Number(digit || 0) - 1;
    const product = products[idx];

    if (!product) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  入力された番号の商品が見つかりませんでした。 最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const askQtySpeech =
      `${product.name} ですね。 個数を押して、最後にシャープを押してください。 ` +
      "例えば 2個 の場合は、 2、シャープ のように押してください。";

    const xml = xmlWrap(
      `
<Gather input="dtmf" timeout="10" finishOnKey="#" action="/twilio/cod/qty?pid=${encodeURIComponent(
        product.id
      )}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(askQtySpeech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  個数が確認できませんでした。 お手数ですが、最初からおかけ直しください。
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

// 個数 → 「これでいいか？」確認
app.post("/twilio/cod/qty", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const digitsRaw = (req.body.Digits || "").toString();
    const digits = digitsRaw.replace(/[^0-9]/g, "");
    const qty = Math.max(1, Math.min(99, Number(digits) || 0));

    console.log("[/twilio/cod/qty] pid =", pid, "digits =", digits, "qty =", qty);

    const products = readProducts();
    const product = products.find((p) => p.id === pid);
    if (!product) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  商品情報が見つかりませんでした。 最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const unit = Number(product.price) || 0;
    const subtotal = unit * qty;
    const speech =
      `${product.name} を ${qty}個、商品合計は ${subtotal}円 でお受けしてよろしいでしょうか。 ` +
      "よろしければ 1 を、やり直す場合は 2 を押してください。";

    const xml = xmlWrap(
      `
<Gather input="dtmf" numDigits="1" timeout="10" action="/twilio/cod/confirm?pid=${encodeURIComponent(
        pid
      )}&qty=${qty}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
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

// これでいいか？ → OKなら会員番号入力へ
app.post("/twilio/cod/confirm", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const qty = Math.max(1, Number(req.query.qty || 1) || 1);
    const digit = (req.body.Digits || "").trim();

    console.log("[/twilio/cod/confirm] pid =", pid, "qty =", qty, "Digits =", digit);

    if (digit !== "1") {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  ありがとうございます。 もう一度最初から商品をお選びください。
</Say>
<Redirect method="POST">/twilio/cod/start</Redirect>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const speech =
      "ありがとうございます。 次に、会員番号を6桁の数字で入力し、最後にシャープを押してください。 " +
      "会員カードに記載の番号の、数字の部分だけを押してください。 例として、アイエス 123456 の場合は、 123456、シャープ のように押してください。";

    const xml = xmlWrap(
      `
<Gather input="dtmf" timeout="15" finishOnKey="#" action="/twilio/cod/member?pid=${encodeURIComponent(
        pid
      )}&qty=${qty}" method="POST">
  <Say language="ja-JP" voice="alice">
    ${escXml(speech)}
  </Say>
</Gather>
<Say language="ja-JP" voice="alice">
  会員番号が確認できませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/confirm error:", e);
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

// 会員番号 → 送料 + 代引手数料込みの合計読み上げ
app.post("/twilio/cod/member", (req, res) => {
  try {
    const pid = String(req.query.pid || "").trim();
    const qty = Math.max(1, Number(req.query.qty || 1) || 1);
    const digitsRaw = (req.body.Digits || "").toString();
    const digits = digitsRaw.replace(/[^0-9]/g, "");

    console.log("[/twilio/cod/member] pid =", pid, "qty =", qty, "member digits =", digits);

    if (!digits) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  会員番号が入力されませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const addr = findAddressByMemberDigits(digits);
    if (!addr) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  入力された会員番号のご登録が見つかりませんでした。 お手数ですが、LINE の住所登録や会員登録をお確かめいただき、改めてお電話ください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const products = readProducts();
    const product = products.find((p) => p.id === pid);
    if (!product) {
      const xml = xmlWrap(
        `
<Say language="ja-JP" voice="alice">
  商品情報が見つかりませんでした。 お手数ですが、最初からおかけ直しください。
</Say>
<Hangup/>
`.trim()
      );
      return res.type("text/xml").send(xml);
    }

    const unit = Number(product.price) || 0;
    const subtotal = unit * qty;

    const region = detectRegionFromAddress(addr);
    const shipping = region ? SHIPPING_BY_REGION[region] || 0 : 0;
    const codFee = COD_FEE;
    const total = subtotal + shipping + codFee;

    const addrText =
      `${addr.postal || ""} ` +
      `${addr.prefecture || ""}${addr.city || ""}${addr.address1 || ""}` +
      (addr.address2 ? ` ${addr.address2}` : "");

    const speech =
      `${product.name} を ${qty}個、ご登録の ${region || "地域"} へのお届けで、 ` +
      `商品合計 ${subtotal}円、送料 ${shipping}円、代引き手数料 ${codFee}円、 ` +
      `合計 ${total}円 となります。 ` +
      `お届け先は、${addrText} です。 ご注文ありがとうございました。`;

    const xml = xmlWrap(
      `
<Say language="ja-JP" voice="alice">
  ${escXml(speech)}
</Say>
<Say language="ja-JP" voice="alice">
  内容にお間違いがある場合は、お手数ですが、お店までお問い合わせください。
</Say>
<Hangup/>
`.trim()
    );
    res.type("text/xml").send(xml);
  } catch (e) {
    console.error("/twilio/cod/member error:", e);
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

// ===== 起動 =====
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 server-phone-cod started on port ${PORT}`);
  console.log("   Twilio Voice Webhook → POST /twilio/cod/start");
});
