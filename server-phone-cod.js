"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");

// ===============================
// fetch（LINE通知用）
// ===============================
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
  } catch (e) {
    console.warn("[WARN] fetch が利用できません。LINE通知は無効です。");
  }
}

// ===============================
// パス設定
// ===============================
const DATA_DIR = path.join(__dirname, "data");
const CUSTOMERS_PATH = path.join(DATA_DIR, "cod-customers.json");
const COD_LOG = path.join(DATA_DIR, "cod-phone-orders.log");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ===============================
// 共通ユーティリティ
// ===============================
function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function writeJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function readCustomers() {
  return safeReadJSON(CUSTOMERS_PATH, {});
}

// ===============================
// 環境変数
// ===============================
const PORT = process.env.PORT || 3000;

const LINE_CHANNEL_ACCESS_TOKEN =
  (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const LINE_ADMIN_USER_ID =
  (process.env.LINE_ADMIN_USER_ID || "").trim();

// ✅ 電話用 住所登録 LIFF
const LIFF_ID_COD_REGISTER =
  (process.env.LIFF_ID_COD_REGISTER || "").trim();

// ===============================
// Express
// ===============================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ✅ CORS（LIFF対策）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ✅ 静的ファイル
const PUBLIC_DIR = path.join(__dirname, "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use("/public", express.static(PUBLIC_DIR));
}

// ===============================
// ✅ LIFF 設定取得 API（★重要）
// ===============================
app.get("/api/liff/config", (_req, res) => {
  return res.json({
    liffId: LIFF_ID_COD_REGISTER,
  });
});

// ===============================
// ✅ 会員登録 API（電話・LIFF 共通）
// ===============================
app.post("/api/cod/customers", async (req, res) => {
  try {
    const { code, name, phone, zip, address, lineUserId } = req.body || {};

    const codeStr = String(code || "").trim();
    if (!/^\d{4,8}$/.test(codeStr)) {
      return res.status(400).json({
        ok: false,
        error: "会員番号は4〜8桁の数字で入力してください。",
      });
    }

    if (!name || !address) {
      return res.status(400).json({
        ok: false,
        error: "名前と住所は必須です。",
      });
    }

    const customers = readCustomers();

    if (customers[codeStr]) {
      return res.status(400).json({
        ok: false,
        error: "この会員番号はすでに登録されています。",
        code: "DUPLICATE_CODE",
      });
    }

    const now = new Date().toISOString();

    customers[codeStr] = {
      name,
      phone: phone || "",
      zip: zip || "",
      address,
      lineUserId: lineUserId || "",
      createdAt: now,
      updatedAt: now,
    };

    writeJSON(CUSTOMERS_PATH, customers);

    // ✅ 管理者通知
    if (
      fetchFn &&
      LINE_CHANNEL_ACCESS_TOKEN &&
      LINE_ADMIN_USER_ID
    ) {
      const msg =
        `【電話 会員登録】\n` +
        `会員番号: ${codeStr}\n` +
        `お名前: ${name}\n` +
        `住所: ${address}\n` +
        `電話: ${phone || "未入力"}`;

      await fetchFn("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          to: LINE_ADMIN_USER_ID,
          messages: [{ type: "text", text: msg.slice(0, 2000) }],
        }),
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/cod/customers error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ✅ 会員番号検索
app.get("/api/cod/customers/:code", (req, res) => {
  const customers = readCustomers();
  const c = customers[req.params.code];
  if (!c) return res.status(404).json({ ok: false });
  res.json({ ok: true, customer: c });
});

// ✅ LINE userId 検索
app.get("/api/cod/customers/by-line", (req, res) => {
  const lineUserId = String(req.query.lineUserId || "").trim();
  const customers = readCustomers();
  for (const code of Object.keys(customers)) {
    if (customers[code].lineUserId === lineUserId) {
      return res.json({
        ok: true,
        code,
        customer: customers[code],
      });
    }
  }
  res.status(404).json({ ok: false });
});

// ===============================
// ✅ Twilio エントリ（最低限）
// ===============================
app.post("/twilio/cod", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="ja-JP" voice="alice">
    お電話ありがとうございます。磯屋です。
    只今システム準備中です。
  </Say>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ===============================
// ✅ Health
// ===============================
app.get("/", (_req, res) => res.send("phone-cod server ok"));
app.get("/health", (_req, res) => res.send("OK"));

// ===============================
// ✅ 起動
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`📦 server-phone-cod started on ${PORT}`);
  console.log("LIFF:", LIFF_ID_COD_REGISTER ? "OK" : "MISSING");
});
