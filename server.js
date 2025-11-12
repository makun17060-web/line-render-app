// server.js — 完全版（Render/GitHub向け・構文修正済み）
// - /public 配信（admin.html をここに置く想定）
// - /admin で簡易リダイレクト
// - /api/admin/ping（要トークン）
// - Flex/テキスト配信 API（セグメント/ブロードキャスト）
// - 直近アクティブユーザー・メッセージログ API
// - LIFF 用の軽いAPI
// - 画像アップロード（multer）→ /uploads 配信
// - products.json（imageUrl 対応）

"use strict";

require("dotenv").config();

const fs = require("fs");
const fse = require("fs-extra");
const path = require("path");
const express = require("express");
const multer = require("multer");
const line = require("@line/bot-sdk");

const app = express();

// ====== 環境変数 ======
const PORT = Number(process.env.PORT || 3000);
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim(); // 互換（?code= でもOK）

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

if (!config.channelAccessToken || !config.channelSecret) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が未設定です。");
  process.exit(1);
}
if (!LIFF_ID) {
  console.error("ERROR: LIFF_ID が未設定です。");
  process.exit(1);
}
if (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV) {
  console.error("ERROR: 管理トークン（ADMIN_API_TOKEN or ADMIN_CODE）が未設定です。");
  process.exit(1);
}

// ====== データディレクトリ ======
function pickWritableDir(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {}
  }
  const fallback = path.join(__dirname, "data");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}
const DATA_DIR = pickWritableDir([
  (process.env.DATA_DIR || "").trim(),
  (process.env.RENDER_DATA_DIR || "").trim(),
  "/data",
  path.join(__dirname, "data"),
]);

const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const MESSAGES_LOG = path.join(DATA_DIR, "messages.log");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

// 初期ファイル
if (!fs.existsSync(PRODUCTS_PATH)) {
  const sample = [
    { id: "kusuke-250", name: "久助（えびせん）", price: 250, stock: 30, desc: "お得な割れせん。", imageUrl: "" },
    { id: "nori-akasha-340", name: "のりあかしゃ", price: 340, stock: 20, desc: "海苔の風味豊かなえびせんべい", imageUrl: "" },
    { id: "uzu-akasha-340", name: "うずあかしゃ", price: 340, stock: 10, desc: "渦を巻いたえびせんべい", imageUrl: "" },
    { id: "shio-akasha-340", name: "潮あかしゃ", price: 340, stock: 5, desc: "えびせんべいにあおさをトッピング", imageUrl: "" },
    { id: "matsu-akasha-340", name: "松あかしゃ", price: 340, stock: 30, desc: "海老をたっぷり使用した高級えびせんべい", imageUrl: "" },
    { id: "iso-akasha-340", name: "磯あかしゃ", price: 340, stock: 30, desc: "海老せんべいに高級海苔をトッピング", imageUrl: "" },
    { id: "goma-akasha-340", name: "ごまあかしゃ", price: 340, stock: 30, desc: "風味豊かなごまをトッピング", imageUrl: "" },
    { id: "original-set-2000", name: "磯屋オリジナルセット", price: 2000, stock: 30, desc: "6袋セット", imageUrl: "" },
  ];
  fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(sample, null, 2), "utf8");
}
if (!fs.existsSync(MESSAGES_LOG)) fs.writeFileSync(MESSAGES_LOG, "", "utf8");
fse.ensureDirSync(UPLOADS_DIR);

// ====== ユーティリティ ======
const readProducts = () => {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf8"));
  } catch {
    return [];
  }
};
const writeProducts = (items) => fs.writeFileSync(PRODUCTS_PATH, JSON.stringify(items, null, 2), "utf8");

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
  res.status(401).json({ ok: false, error: "unauthorized" });
  return false;
}
function logMessage(rec) {
  try {
    fs.appendFileSync(MESSAGES_LOG, JSON.stringify(rec) + "\n", "utf8");
  } catch {}
}
function absUrl(req, p) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers.host;
  return `${proto}://${host}${p}`;
}

// ====== Middlewares / Static ======
app.use("/api", express.json({ limit: "2mb" }));
app.use("/public", express.static(path.join(__dirname, "public"))); // admin.html など
app.use("/uploads", express.static(UPLOADS_DIR, { maxAge: "7d", immutable: true })); // 画像配信
app.get("/", (_req, res) => res.status(200).send("OK"));

// ====== 画像アップロード機能（重複定義なし・ここだけ） ======
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || "image").replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({ storage });

// 単純アップロード（管理画面のドラッグ＆ドロップから呼ぶ）
app.post(
  "/api/admin/upload-image",
  (req, res, next) => {
    if (!requireAdmin(req, res)) return; // 認証
    next();
  },
  upload.single("file"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "no_file" });
    const urlPath = `/uploads/${req.file.filename}`;
    res.json({ ok: true, path: urlPath, url: absUrl(req, urlPath) });
  }
);

// ====== LIFF （軽い情報） ======
app.get("/api/liff/config", (_req, res) => res.json({ liffId: LIFF_ID }));

// ====== Health ======
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    dataDir: DATA_DIR,
    files: { products: PRODUCTS_PATH, messages: MESSAGES_LOG, uploads: UPLOADS_DIR },
    env: {
      PORT: !!process.env.PORT,
      LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
      LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
      LIFF_ID: !!process.env.LIFF_ID,
      ADMIN_API_TOKEN: !!ADMIN_API_TOKEN_ENV,
      ADMIN_CODE: !!ADMIN_CODE_ENV,
    },
  });
});

// ====== 管理 画面ショートカット ======
app.get("/admin", (_req, res) => {
  // /public/admin.html を使う運用のため、存在すればそちらに誘導
  res.redirect(302, "/public/admin.html");
});

// ====== LINE Client ======
const client = new line.Client(config);

// ====== Admin APIs ======

// 認証テスト
app.get("/api/admin/ping", (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, ping: "pong" });
});

// 商品一覧（imageUrl 付き）
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock ?? 0,
    desc: p.desc || "",
    imageUrl: p.imageUrl || "",
  }));
  res.json({ ok: true, items });
});

// 商品の画像URLを更新（id, imageUrl）
app.post("/api/admin/products/image", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id, imageUrl } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    const items = readProducts();
    const i = items.findIndex((p) => p.id === id);
    if (i < 0) return res.status(404).json({ ok: false, error: "not_found" });
    items[i].imageUrl = imageUrl || "";
    writeProducts(items);
    res.json({ ok: true, item: items[i] });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// セグメント：テキスト
app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds)
      ? Array.from(new Set(req.body.userIds.filter(Boolean)))
      : [];
    const message = (req.body?.message || "").trim();
    if (!userIds.length) return res.status(400).json({ ok: false, error: "no_users" });
    if (!message) return res.status(400).json({ ok: false, error: "no_message" });
    // 500件ずつ
    const chunk = 500;
    for (let i = 0; i < userIds.length; i += chunk) {
      const ids = userIds.slice(i, i + chunk);
      await client.multicast(ids, [{ type: "text", text: message }]);
    }
    res.json({ ok: true, sent: userIds.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.response?.data || e.message || String(e) });
  }
});

// セグメント：Flex
function ensureAltText(s) {
  s = String(s || "").trim();
  if (!s) throw new Error("altText required");
  if (s.length > 400) throw new Error("altText too long");
  return s;
}
function ensureContents(c) {
  if (!c || typeof c !== "object") throw new Error("contents required");
  const t = c.type;
  if (t !== "bubble" && t !== "carousel") throw new Error("contents.type must be bubble or carousel");
  return c;
}

app.post("/api/admin/segment/send-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds)
      ? Array.from(new Set(req.body.userIds.filter(Boolean)))
      : [];
    const altText = ensureAltText(req.body?.altText);
    const contents = ensureContents(req.body?.contents);
    if (!userIds.length) return res.status(400).json({ ok: false, error: "no_users" });
    const msg = [{ type: "flex", altText, contents }];
    const chunk = 500;
    let sent = 0;
    for (let i = 0; i < userIds.length; i += chunk) {
      const ids = userIds.slice(i, i + chunk);
      await client.multicast(ids, msg);
      sent += ids.length;
    }
    res.json({ ok: true, sent });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.response?.data || e.message || String(e) });
  }
});

// 全体：Flex broadcast
app.post("/api/admin/broadcast-flex", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const altText = ensureAltText(req.body?.altText);
    const contents = ensureContents(req.body?.contents);
    await client.broadcast([{ type: "flex", altText, contents }]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e?.response?.data || e.message || String(e) });
  }
});

// 直近アクティブユーザー（messages.log から）
app.get("/api/admin/active-chatters", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(200000, Number(req.query.limit || 50000));
    if (!fs.existsSync(MESSAGES_LOG)) return res.json({ ok: true, totalMessages: 0, uniqueUsers: 0, users: [] });

    const lines = fs.readFileSync(MESSAGES_LOG, "utf8").split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.min(limit, lines.length));
    const items = tail
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const onlyText = items.filter((x) => x && (x.type === "text" || x.type === "postback") && x.userId);
    const set = new Set(onlyText.map((x) => x.userId));
    const list = String(req.query.list || "false").toLowerCase() === "true";

    res.json({
      ok: true,
      totalMessages: onlyText.length,
      uniqueUsers: set.size,
      users: list ? Array.from(set) : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// メッセージログ（簡易表示用）
app.get("/api/admin/messages", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(200000, Number(req.query.limit || 2000));
    if (!fs.existsSync(MESSAGES_LOG)) return res.json({ ok: true, items: [], path: MESSAGES_LOG });
    const lines = fs.readFileSync(MESSAGES_LOG, "utf8").split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-Math.min(limit, lines.length));
    const items = tail
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.json({ ok: true, items, path: MESSAGES_LOG });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ====== Webhook（最低限のログ記録） ======
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(
      events.map(async (ev) => {
        if (ev.type === "message" && ev.message?.type === "text") {
          logMessage({ ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "text", len: (ev.message.text || "").length });
        }
        if (ev.type === "postback") {
          const d_ = String(ev.postback?.data || "");
          logMessage({ ts: new Date().toISOString(), userId: ev.source?.userId || "", type: "postback", data: d_.slice(0, 200) });
        }
      })
    );
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e.stack || e);
    res.status(500).end();
  }
});

// ====== 起動 ======
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
  console.log(`   Static admin: /public/admin.html  （ショートカット /admin）`);
  console.log(`   Uploads: /uploads/*`);
});
