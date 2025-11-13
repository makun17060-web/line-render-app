// =============================
// server.js — 画像管理つきフル機能版
// ベース: ユーザー提供の server.js に下記を追記/調整
// - 画像アップロードAPI（multer, 5MB, PNG/JPG/WEBP/GIF）
// - 画像一覧API / 削除API / 商品への画像設定API
// - /public/uploads 静的配信とRender向けの安全対策
// - Flexの商品一覧に hero 画像表示（imageUrlがあれば）
// - 管理画面用の admin.html / admin.js （public配下）
// =============================


"use strict";


require("dotenv").config();


const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const multer = require("multer");


const app = express();


// ====== 環境変数 ======
const PORT = process.env.PORT || 3000;
const LIFF_ID = (process.env.LIFF_ID || "").trim();
const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const MULTICAST_USER_IDS = (process.env.MULTICAST_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);


const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim(); // 推奨
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim(); // 互換（クエリ ?code= でも可）


// ★ 銀行振込案内（任意）
const BANK_INFO = (process.env.BANK_INFO || "").trim();
const BANK_NOTE = (process.env.BANK_NOTE || "").trim();


const config = {
channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};


if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
console.error(
`ERROR: .env の必須値が不足しています。
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- LIFF_ID
- （ADMIN_API_TOKEN または ADMIN_CODE のどちらか）`
);
});
