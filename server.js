// server.js — フル機能版（画像アップロード&管理UI DnD対応・whoami・"me"解決）
//
// 必須 .env: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET, LIFF_ID, (ADMIN_API_TOKEN または ADMIN_CODE)
// 任意 .env: PORT, ADMIN_USER_ID, MULTICAST_USER_IDS, BANK_INFO, BANK_NOTE, DATA_DIR（任意で上書き）

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const multer = require("multer");
const sharp = require("sharp");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");

// ====== アップロード設定 ======
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]/g, "_");
    cb(null, `${base}-${Date.now()}${ext.toLowerCase()}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ====== 画像アップロードAPI ======
app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "no file" });

    const inputPath = req.file.path;
    const base = path.basename(inputPath, path.extname(inputPath));
    const outputPath = path.join(uploadDir, `${base}-800.webp`);

    // 800x800以内・WebPに変換
    await sharp(inputPath)
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(outputPath);

    try { fs.unlinkSync(inputPath); } catch {}

    const url = `/uploads/${path.basename(outputPath)}?v=${Date.now()}`;
    return res.json({ ok: true, url });
  } catch (e) {
    console.error("upload resize error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== 画像URLを products.json に反映するAPI ======
app.post("/api/admin/products/set-image", async (req, res) => {
  try {
    const { productId, imageUrl } = req.body;
    if (!productId || !imageUrl) return res.status(400).json({ ok: false, error: "missing params" });

    let products = [];
    if (fs.existsSync(PRODUCTS_FILE)) {
      products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
    }

    const idx = products.findIndex(p => p.id === productId);
    if (idx === -1) return res.status(404).json({ ok: false, error: "product not found" });

    products[idx].image = imageUrl;
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
    return res.json({ ok: true, saved: products[idx] });
  } catch (e) {
    console.error("set-image error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ====== whoami API（LIFF用：管理者自身のuserId解決） ======
app.get("/api/admin/whoami", (req, res) => {
  // 仮にADMIN_USER_IDを返す簡易実装
  const userId = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxx";
  res.json({ ok: true, userId });
});

// ====== ヘルスチェック ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ====== public配信（最後に置く！） ======
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));

// ====== サーバー起動 ======
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`   DATA_DIR: ${DATA_DIR}`);
});
