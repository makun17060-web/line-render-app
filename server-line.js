/**
 * server.js — フル機能版（Stripe + ミニアプリ + 画像管理 + 住所DB + セグメント配信 + 注文DB永続化）
 *
 * ✅ 重要（あなたの要望）
 * - UPLOAD_DIR だけ Disk に保存（再デプロイで画像が消えない）
 *   - 画像保存先：UPLOAD_DIR=/var/data/uploads（デフォルト）
 *   - 静的配信：/public/uploads → Disk の UPLOAD_DIR を参照（重要）
 *
 * ✅ 重要（永続データ）
 * - products.json / sessions.json / logs などの DATA も Disk に保存（再デプロイでもズレない）
 *   - データ保存先：DATA_DIR=/var/data（デフォルト）
 *
 * ✅ 今回の修正（あなたの依頼）
 * - 久助の送料サイズ判定＝あかしゃと同じ（サイズ判定で久助を akasha 扱いに含める）
 * - チャット「久助 3」で、DBから住所を読んで送料計算できる（住所があれば）
 *
 * ✅ 今回の設計改善（超重要）
 * - 「久助」も他の商品と同じく products.json に従う（価格固定ロジックを撤廃）
 *   - 管理APIで久助の price / stock / volume を自由に変更できる
 *   - チャット案内の単価表示も products.json の値を表示
 *
 * ✅ 既存仕様（維持）
 * - 起動キーワードは「直接注文」と「久助」だけ（それ以外は無反応）
 * - セッション中の入力は受け付ける
 * - 公式アカウント受信は管理者へ通知（返信はしない）
 * - /api/admin/orders/notify-shipped はトップレベル
 *
 * ✅ 既存の修正（重要）
 * - 管理画面の抽出人数 ＝ DBで数えた userid数 ＝ 実送信対象 が必ず一致するように
 *   セグメント抽出ロジックを「1本化」
 *   - GET /api/admin/segment/users
 *   - GET /api/admin/segment/count
 *   - POST /api/admin/segment/send
 *   が同一の抽出条件を共有
 *
 * ✅ 追加（プロフィール保存）
 * - LINEプロフィール（display_name / picture_url / status_message）をDBへ保存
 *   - テーブル：line_users
 *   - follow は強制更新
 *   - 通常イベントでは 30日以上古い/未登録の時だけ更新（取りすぎ防止）
 * - 管理API：GET /api/admin/users（ユーザー一覧 + display_name）
 *
 * ✅ 追加（友だち追加＝DBでも100%一致）
 * - follow/unfollow をDBに正式保存：follow_events / unfollow_events
 * - 管理API：GET /api/admin/follow/stats（今日/昨日/7日/30日 + 純増）
 *
 * ✅ 追加（リッチメニュー：店頭受取を postback で開始）
 * - リッチメニューの「店頭受取」ボタンを postback にして “トークに文字を出さず” 開始
 *   postback data: action=pickup_start
 * - pickup_start で「直接注文」を内部開始しつつ “店頭受取に固定”
 *
 * --- 必須 .env ---
 * LINE_CHANNEL_ACCESS_TOKEN
 * LINE_CHANNEL_SECRET
 * LIFF_ID
 * ADMIN_API_TOKEN  (推奨) もしくは ADMIN_CODE
 * DATABASE_URL     (住所DB/注文DBを使うなら推奨)
 *
 * --- 推奨 .env ---
 * ADMIN_USER_ID（管理者へ通知）
 * PUBLIC_BASE_URL（Renderの https://xxxx.onrender.com ）
 * STRIPE_SECRET_KEY（Stripe使うなら）
 * LINE_CHANNEL_ID（LIFF idToken検証するなら）
 * PUBLIC_ADDRESS_LOOKUP_TOKEN（公開住所取得APIを使うなら）
 *
 * --- 推奨 .env ---
 * UPLOAD_DIR=/var/data/uploads
 * DATA_DIR=/var/data
 *
 * --- 重要：オリジナルセットID ---
 * あなたのproducts.jsonが original-set-2000 なので、デフォルトもそれに合わせています。
 * 必要なら env で上書き：
 * ORIGINAL_SET_PRODUCT_ID=original-set-2000
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const line = require("@line/bot-sdk");
const multer = require("multer");
const stripeLib = require("stripe");
const { Pool } = require("pg");

// Node18+ は fetch が標準。万一無い環境の保険（Renderは通常Node18+）
const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// =============== 基本 ===============
const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  channelAccessToken: (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim(),
  channelSecret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
};

const LIFF_ID = (process.env.LIFF_ID || "").trim();
const LIFF_ID_MINIAPP = (process.env.LIFF_ID_MINIAPP || LIFF_ID).trim(); // /liff redirect 用（任意）
const LIFF_ID_DIRECT_ADDRESS = (process.env.LIFF_ID_DIRECT_ADDRESS || LIFF_ID).trim();
const LIFF_ID_SHOP = (process.env.LIFF_ID_SHOP || "").trim(); // 任意
const LINE_CHANNEL_ID = (process.env.LINE_CHANNEL_ID || "").trim(); // 任意（idToken verify）

const ADMIN_USER_ID = (process.env.ADMIN_USER_ID || "").trim();
const ADMIN_API_TOKEN_ENV = (process.env.ADMIN_API_TOKEN || "").trim();
const ADMIN_CODE_ENV = (process.env.ADMIN_CODE || "").trim();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const PUBLIC_ADDRESS_LOOKUP_TOKEN = (process.env.PUBLIC_ADDRESS_LOOKUP_TOKEN || "").trim();

const COD_FEE = Number(process.env.COD_FEE || 330);

// セグメント設定
const LIFF_OPEN_KIND_MODE = (process.env.LIFF_OPEN_KIND_MODE || "all").trim(); // "all" or "keep"
const SEGMENT_PUSH_LIMIT = Math.min(20000, Math.max(1, Number(process.env.SEGMENT_PUSH_LIMIT || 5000)));
const SEGMENT_CHUNK_SIZE = Math.min(500, Math.max(50, Number(process.env.SEGMENT_CHUNK_SIZE || 500)));

// ★プロフィール更新の最小間隔（日）
const PROFILE_REFRESH_DAYS = Math.min(365, Math.max(1, Number(process.env.PROFILE_REFRESH_DAYS || 30)));

// ★店頭受取 postback の data（リッチメニュー）
const PICKUP_POSTBACK_DATA = (process.env.PICKUP_POSTBACK_DATA || "action=pickup_start").trim();

if (!config.channelAccessToken || !config.channelSecret || !LIFF_ID || (!ADMIN_API_TOKEN_ENV && !ADMIN_CODE_ENV)) {
  console.error(`ERROR: 必須envが不足しています
- LINE_CHANNEL_ACCESS_TOKEN
- LINE_CHANNEL_SECRET
- LIFF_ID
- ADMIN_API_TOKEN または ADMIN_CODE`);
  process.exit(1);
}

const client = new line.Client(config);

// =============== DB ===============
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    })
  : null;

function mustPool() {
  if (!pool) throw new Error("DATABASE_URL not set");
  return pool;
}

// =============== ルート / パーサ ===============
const jsonParser = express.json({ limit: "2mb" });
const urlParser = express.urlencoded({ extended: true });

app.use((req, res, next) => {
  if (req.path.startsWith("/webhook")) return next();
  return jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith("/webhook")) return next();
  return urlParser(req, res, next);
});

app.use((req, _res, next) => {
  console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

// ✅ /liff へ来たら LIFFへリダイレクト
app.get(["/liff", "/liff/"], (_req, res) => {
  const id = LIFF_ID_MINIAPP || LIFF_ID;
  if (!id) return res.status(500).send("LIFF_ID is not set");
  return res.redirect(302, `https://liff.line.me/${id}`);
});

// =============== ディレクトリ & ファイル ===============
// public 配信用（Git側）
const PUBLIC_DIR = path.join(__dirname, "public");

// Git側 data（もし残っていても読むのは主に “移行用”）
const GIT_DATA_DIR = path.join(__dirname, "data");

// ★Disk側 data（永続化）
const DISK_DATA_DIR = path.resolve(process.env.DATA_DIR || "/var/data");

// ★UPLOAD_DIRは env を優先（Disk）
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || "/var/data/uploads");

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(GIT_DATA_DIR)) fs.mkdirSync(GIT_DATA_DIR, { recursive: true });
if (!fs.existsSync(DISK_DATA_DIR)) fs.mkdirSync(DISK_DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 既存の public 配信（HTML/JS/CSS 等）
app.use("/public", express.static(PUBLIC_DIR));
// ★/public/uploads は Disk の UPLOAD_DIR を配信
app.use("/public/uploads", express.static(UPLOAD_DIR));

// ★Disk永続ファイル
const PRODUCTS_PATH = path.join(DISK_DATA_DIR, "products.json");
const ORDERS_LOG = path.join(DISK_DATA_DIR, "orders.log");
const RESERVATIONS_LOG = path.join(DISK_DATA_DIR, "reservations.log");
const MESSAGES_LOG = path.join(DISK_DATA_DIR, "messages.log");
const SESSIONS_PATH = path.join(DISK_DATA_DIR, "sessions.json");
const NOTIFY_STATE_PATH = path.join(DISK_DATA_DIR, "notify_state.json");
const STOCK_LOG = path.join(DISK_DATA_DIR, "stock.log");
const SEGMENT_USERS_PATH = path.join(DISK_DATA_DIR, "segment_users.json");

// ★プロフィール（DBが無い時の保険：ファイル）も Disk
const LINE_USERS_PATH = path.join(DISK_DATA_DIR, "line_users.json");

// 互換（旧JSON）も Disk 側へ
const ADDRESSES_PATH = path.join(DISK_DATA_DIR, "addresses.json");
const PHONE_ADDRESSES_PATH = path.join(DISK_DATA_DIR, "phone-addresses.json");

function safeReadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
}
function safeWriteJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}
function tryCopyFileIfMissing(dst, src) {
  try {
    if (fs.existsSync(dst)) return false;
    if (!fs.existsSync(src)) return false;
    fs.copyFileSync(src, dst);
    console.log(`[BOOT] migrated ${path.basename(src)} -> disk (${dst})`);
    return true;
  } catch (e) {
    console.warn("[BOOT] migrate skipped:", e?.message || e);
    return false;
  }
}

// ★Diskに products.json が無ければ、Git側があれば移行、それも無ければ seed
if (!fs.existsSync(PRODUCTS_PATH)) {
  const gitProducts = path.join(GIT_DATA_DIR, "products.json");
  const migrated = tryCopyFileIfMissing(PRODUCTS_PATH, gitProducts);

  if (!migrated) {
    const seed = [
      {
        id: "kusuke-250",
        name: "久助（えびせん）",
        price: 250, // ← 初期値（ここは運用で自由に変更OK）
        stock: 30,
        volume: "約○○g",
        desc: "お得な割れせん。",
        image: "",
      },
      {
        id: "nori-akasha-340",
        name: "のりあかしゃ",
        price: 340,
        stock: 20,
        volume: "80g",
        desc: "海苔の風味豊かなえびせんべい",
        image: "1766470818363_noriakasya90.png",
      },
      {
        id: "uzu-akasha-340",
        name: "うずあかしゃ",
        price: 340,
        stock: 10,
        volume: "80g",
        desc: "渦を巻いたえびせんべい",
        image: "1766470864228__.jpg",
      },
      {
        id: "shio-akasha-340",
        name: "潮あかしゃ",
        price: 340,
        stock: 5,
        volume: "80g",
        desc: "えびせんべいにあおさをトッピング",
        image: "1766470752238_1201_IMG_0076.jpg",
      },
      {
        id: "matsu-akasha-340",
        name: "松あかしゃ",
        price: 340,
        stock: 30,
        volume: "80g",
        desc: "海老をたっぷり使用した高級えびせんべい",
        image: "1766470721680_2_000000000002.png",
      },
      {
        id: "iso-akasha-340",
        name: "磯あかしゃ",
        price: 340,
        stock: 30,
        volume: "80g",
        desc: "海老せんべいに高級海苔をトッピング",
        image: "1766470910323__.jpg",
      },
      {
        id: "goma-akasha-340",
        name: "ごまあかしゃ",
        price: 340,
        stock: 30,
        volume: "80g",
        desc: "海老せんべいに風味豊かなごまをトッピング",
        image: "1766470974602__.jpg",
      },
      {
        id: "original-set-2000",
        name: "磯屋オリジナルセット",
        price: 2000,
        stock: 30,
        volume: "",
        desc: "6袋をセットにしたオリジナル",
        image: "1766470786708_akashi_item.jpg",
      },
    ];
    safeWriteJSON(PRODUCTS_PATH, seed);
    console.log("[BOOT] seeded products.json on disk");
  }
}

if (!fs.existsSync(SESSIONS_PATH)) {
  const migrated = tryCopyFileIfMissing(SESSIONS_PATH, path.join(GIT_DATA_DIR, "sessions.json"));
  if (!migrated) safeWriteJSON(SESSIONS_PATH, {});
}
if (!fs.existsSync(NOTIFY_STATE_PATH)) {
  const migrated = tryCopyFileIfMissing(NOTIFY_STATE_PATH, path.join(GIT_DATA_DIR, "notify_state.json"));
  if (!migrated) safeWriteJSON(NOTIFY_STATE_PATH, {});
}
if (!fs.existsSync(SEGMENT_USERS_PATH)) {
  const migrated = tryCopyFileIfMissing(SEGMENT_USERS_PATH, path.join(GIT_DATA_DIR, "segment_users.json"));
  if (!migrated) safeWriteJSON(SEGMENT_USERS_PATH, {});
}
if (!fs.existsSync(LINE_USERS_PATH)) {
  const migrated = tryCopyFileIfMissing(LINE_USERS_PATH, path.join(GIT_DATA_DIR, "line_users.json"));
  if (!migrated) safeWriteJSON(LINE_USERS_PATH, {});
}
if (!fs.existsSync(ADDRESSES_PATH)) {
  const migrated = tryCopyFileIfMissing(ADDRESSES_PATH, path.join(GIT_DATA_DIR, "addresses.json"));
  if (!migrated) safeWriteJSON(ADDRESSES_PATH, {});
}
if (!fs.existsSync(PHONE_ADDRESSES_PATH)) {
  const migrated = tryCopyFileIfMissing(PHONE_ADDRESSES_PATH, path.join(GIT_DATA_DIR, "phone-addresses.json"));
  if (!migrated) safeWriteJSON(PHONE_ADDRESSES_PATH, {});
}

const readProducts = () => safeReadJSON(PRODUCTS_PATH, []);
const writeProducts = (arr) => safeWriteJSON(PRODUCTS_PATH, arr);
const readSessions = () => safeReadJSON(SESSIONS_PATH, {});
const writeSessions = (obj) => safeWriteJSON(SESSIONS_PATH, obj);
const readNotifyState = () => safeReadJSON(NOTIFY_STATE_PATH, {});
const writeNotifyState = (obj) => safeWriteJSON(NOTIFY_STATE_PATH, obj);
const readSegmentUsers = () => safeReadJSON(SEGMENT_USERS_PATH, {});
const writeSegmentUsers = (obj) => safeWriteJSON(SEGMENT_USERS_PATH, obj);
const readLineUsersFile = () => safeReadJSON(LINE_USERS_PATH, {});
const writeLineUsersFile = (obj) => safeWriteJSON(LINE_USERS_PATH, obj);

const yen = (n) => `${Number(n || 0).toLocaleString("ja-JP")}円`;

function formatAddressText(a = {}) {
  const postal = a.postal || a.zip || "";
  const pref = a.prefecture || a.pref || "";
  const city = a.city || "";
  const addr1 = a.addr1 || a.address1 || "";
  const addr2 = a.addr2 || a.address2 || "";
  const line = `${pref}${city}${addr1}${addr2 ? " " + addr2 : ""}`.trim();
  return `${postal ? postal + " " : ""}${line}`.trim();
}

function pickNameFromAddress(a = {}) {
  const n = a.name || "";
  if (n) return String(n).trim();
  const ln = a.lastName || "";
  const fn = a.firstName || "";
  return `${ln}${fn}`.trim();
}

function normalizePaymentMethodFromOrder(order = {}) {
  const raw = String(order.paymentMethod || order.payment || order.method || "").trim().toLowerCase();
  if (raw === "cod" || raw === "daibiki" || raw === "代引" || raw === "代引き") return "cod";
  if (raw === "bank" || raw === "furikomi" || raw === "振込" || raw === "銀行振込") return "bank";
  if (raw === "store" || raw === "cash" || raw === "pickup" || raw === "店頭" || raw === "現金") return "store";
  if (raw === "stripe" || raw === "card" || raw === "credit") return "stripe";
  return "stripe";
}

// =============== 管理認証 ===============
function bearerToken(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
function requireAdmin(req, res) {
  const headerTok = bearerToken(req);
  const queryTok = String(req.query?.token || req.query?.code || "").trim();
  const tok = headerTok || queryTok;

  if (ADMIN_API_TOKEN_ENV && tok === ADMIN_API_TOKEN_ENV) return true;
  if (ADMIN_CODE_ENV && tok === ADMIN_CODE_ENV) return true;

  res.status(401).json({ ok: false, error: "unauthorized" });
  return false;
}

// =============== 画像アップロード ===============
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = (file.originalname || "image").replace(/[^\w.\-]+/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|gif|webp)/i.test(file.mimetype);
    cb(ok ? null : new Error("invalid_file_type"), ok);
  },
});

function toPublicImageUrl(raw) {
  if (!raw) return "";
  const s = String(raw).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;

  let fname = s;
  const last = s.lastIndexOf("/");
  if (last >= 0) fname = s.slice(last + 1);

  const pathPart = `/public/uploads/${fname}`;
  const hostFromRender =
    process.env.RENDER_EXTERNAL_HOSTNAME ||
    (process.env.RENDER_EXTERNAL_URL || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");

  if (hostFromRender) return `https://${hostFromRender}${pathPart}`;
  if (PUBLIC_BASE_URL) return `${PUBLIC_BASE_URL}${pathPart}`;
  return pathPart;
}

// =============== 商品・在庫 ===============
const HIDE_PRODUCT_IDS = new Set([]); // 必要ならここに追加で非表示化
const LOW_STOCK_THRESHOLD = 5;

function findProductById(id) {
  const products = readProducts();
  const idx = products.findIndex((p) => p.id === id);
  return { products, idx, product: idx >= 0 ? products[idx] : null };
}

function writeStockLog(entry) {
  try {
    fs.appendFileSync(STOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {}
}
async function maybeLowStockAlert(productId, productName, stockNow) {
  if (!ADMIN_USER_ID) return;
  if (stockNow >= LOW_STOCK_THRESHOLD) return;
  const msg = `⚠️ 在庫僅少\n商品：${productName}（${productId}）\n残り：${stockNow}個`;
  try {
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
  } catch {}
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

// =============== 送料（ヤマト中部 税込） ===============
const YAMATO_CHUBU_TAXED = {
  "60": { 北海道: 1610, 東北: 1190, 関東: 940, 中部: 940, 近畿: 940, 中国: 1060, 四国: 1060, 九州: 1190, 沖縄: 1460 },
  "80": { 北海道: 1900, 東北: 1480, 関東: 1230, 中部: 1230, 近畿: 1230, 中国: 1350, 四国: 1350, 九州: 1480, 沖縄: 2070 },
  "100": { 北海道: 2200, 東北: 1790, 関東: 1530, 中部: 1530, 近畿: 1530, 中国: 1650, 四国: 1650, 九州: 1790, 沖縄: 2710 },
  "120": { 北海道: 2780, 東北: 2310, 関東: 2040, 中部: 2040, 近畿: 2040, 中国: 2170, 四国: 2170, 九州: 2310, 沖縄: 3360 },
  "140": { 北海道: 3440, 東北: 2930, 関東: 2630, 中部: 2630, 近畿: 2630, 中国: 2780, 四国: 2780, 九州: 2930, 沖縄: 4030 },
  "160": { 北海道: 3820, 東北: 3320, 関東: 3020, 中部: 3020, 近畿: 3020, 中国: 3160, 四国: 3160, 九州: 3320, 沖縄: 4680 },
};
const SIZE_ORDER = ["60", "80", "100", "120", "140", "160"];

// ★デフォルトをあなたの products.json に合わせて 2000 に
const ORIGINAL_SET_PRODUCT_ID = (process.env.ORIGINAL_SET_PRODUCT_ID || "original-set-2000").trim();

function detectRegionFromAddress(address = {}) {
  const pref = String(address.prefecture || address.pref || "").trim();
  const addr1 = String(address.addr1 || address.address1 || "").trim();
  const hay = pref || addr1;

  if (/北海道/.test(hay)) return "北海道";
  if (/(青森|岩手|宮城|秋田|山形|福島|東北)/.test(hay)) return "東北";
  if (/(茨城|栃木|群馬|埼玉|千葉|東京|神奈川|山梨|関東)/.test(hay)) return "関東";
  if (/(新潟|富山|石川|福井|長野|岐阜|静岡|愛知|三重|中部)/.test(hay)) return "中部";
  if (/(滋賀|京都|大阪|兵庫|奈良|和歌山|近畿|関西)/.test(hay)) return "近畿";
  if (/(鳥取|島根|岡山|広島|山口|中国)/.test(hay)) return "中国";
  if (/(徳島|香川|愛媛|高知|四国)/.test(hay)) return "四国";
  if (/(福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|九州)/.test(hay)) return "九州";
  if (/(沖縄)/.test(hay)) return "沖縄";
  return "";
}

// ★修正：久助も「あかしゃサイズ判定」と同じ扱いにする
function isAkasha6(item) {
  const id = String(item?.id || "");
  const name = String(item?.name || "");

  // 久助を akasha 扱いに含める（サイズ判定）
  if (id === "kusuke-250" || /久助/.test(name)) return true;

  return /(のりあかしゃ|うずあかしゃ|潮あかしゃ|松あかしゃ|ごまあかしゃ|磯あかしゃ|いそあかしゃ)/.test(name);
}
function sizeFromAkasha6Qty(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  if (q <= 4) return "60";
  if (q <= 8) return "80";
  if (q <= 13) return "100";
  if (q <= 18) return "120";
  return "140";
}

// ★あなたのルール：オリジナルセットは 1個80 / 2個100 / 3-4個120 / 5-6個140 / それ以上160
function sizeFromOriginalSetQty(qty) {
  const q = Number(qty) || 0;
  if (q <= 0) return null;
  if (q === 1) return "80";
  if (q === 2) return "100";
  if (q <= 4) return "120";
  if (q <= 6) return "140";
  return "160";
}

function sizeFromTotalQty(totalQty) {
  const q = Number(totalQty) || 0;
  if (q <= 1) return "60";
  if (q === 2) return "80";
  if (q === 3) return "100";
  if (q <= 4) return "120";
  if (q <= 6) return "140";
  return "160";
}
function calcYamatoShipping(region, size) {
  if (!region) return 0;
  const table = YAMATO_CHUBU_TAXED[String(size)] || null;
  if (!table) return 0;
  return Number(table[region] || 0);
}
function calcShippingUnified(items = [], address = {}) {
  const region = detectRegionFromAddress(address);
  const totalQty = items.reduce((s, it) => s + Number(it.qty || 0), 0);
  const akasha6Qty = items.reduce((s, it) => s + (isAkasha6(it) ? Number(it.qty || 0) : 0), 0);
  const originalQty = items.reduce((s, it) => {
    return s + ((it.id === ORIGINAL_SET_PRODUCT_ID || /磯屋.?オリジナルセ/.test(it.name || "")) ? Number(it.qty || 0) : 0);
  }, 0);

  let size;
  if (akasha6Qty > 0) size = sizeFromAkasha6Qty(akasha6Qty);
  else if (originalQty > 0) size = sizeFromOriginalSetQty(originalQty);
  else size = sizeFromTotalQty(totalQty);

  const shipping = calcYamatoShipping(region, size);
  return { region, size, shipping };
}

// =============== DBスキーマ ===============
function rand4() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

async function ensureDbSchema() {
  if (!pool) return;
  const p = mustPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS codes (
      user_id      TEXT PRIMARY KEY,
      member_code  CHAR(4) UNIQUE,
      address_code CHAR(4) UNIQUE
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS addresses (
      member_code CHAR(4) PRIMARY KEY,
      user_id     TEXT,
      name        TEXT,
      phone       TEXT,
      postal      TEXT,
      prefecture  TEXT,
      city        TEXT,
      address1    TEXT,
      address2    TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_addresses_user_id ON addresses(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS liff_open_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      opened_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_kind_time ON liff_open_logs(kind, opened_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_liff_open_logs_user ON liff_open_logs(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS segment_users (
      user_id TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen  TIMESTAMPTZ DEFAULT NOW(),
      last_chat_at TIMESTAMPTZ,
      last_liff_at TIMESTAMPTZ
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_seen ON segment_users(last_seen DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_chat ON segment_users(last_chat_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_segment_users_last_liff ON segment_users(last_liff_at DESC);`);

  // ★LINEプロフィール保存
  await p.query(`
    CREATE TABLE IF NOT EXISTS line_users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      picture_url TEXT,
      status_message TEXT,
      language TEXT,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      last_seen  TIMESTAMPTZ DEFAULT NOW(),
      profile_updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_line_users_last_seen ON line_users(last_seen DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_line_users_profile_updated_at ON line_users(profile_updated_at DESC);`);

  // ★友だち追加/ブロック ログ
  await p.query(`
    CREATE TABLE IF NOT EXISTS follow_events (
      id        BIGSERIAL PRIMARY KEY,
      user_id   TEXT NOT NULL,
      event_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_event JSONB NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_follow_events_ts ON follow_events(event_ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_follow_events_user ON follow_events(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS unfollow_events (
      id        BIGSERIAL PRIMARY KEY,
      user_id   TEXT NOT NULL,
      event_ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_event JSONB NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_unfollow_events_ts ON unfollow_events(event_ts DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_unfollow_events_user ON unfollow_events(user_id);`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      user_id TEXT,
      member_code CHAR(4),
      phone TEXT,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      total INT NOT NULL DEFAULT 0,
      shipping_fee INT NOT NULL DEFAULT 0,
      payment_method TEXT NOT NULL DEFAULT 'unknown',
      status TEXT NOT NULL DEFAULT 'new',
      name TEXT,
      zip TEXT,
      pref TEXT,
      address TEXT,
      source TEXT,
      raw_event JSONB
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_member_code ON orders(member_code);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_orders_payment_method ON orders(payment_method);`);

  try {
    await p.query(`ALTER TABLE orders ALTER COLUMN payment_method SET DEFAULT 'unknown'`);
    await p.query(`UPDATE orders SET payment_method='unknown' WHERE payment_method IS NULL OR payment_method=''`);
    await p.query(`ALTER TABLE orders ALTER COLUMN payment_method SET NOT NULL`);

    await p.query(`ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'new'`);
    await p.query(`UPDATE orders SET status='new' WHERE status IS NULL OR status=''`);
    await p.query(`ALTER TABLE orders ALTER COLUMN status SET NOT NULL`);
  } catch (e) {
    console.warn("[BOOT] orders migration skipped:", e?.message || e);
  }
}

async function dbGetCodesByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const r = await p.query(`SELECT user_id, member_code, address_code FROM codes WHERE user_id=$1 LIMIT 1`, [uid]);
  return r.rows[0] || null;
}
async function dbEnsureCodes(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const exist = await dbGetCodesByUserId(uid);
  if (exist?.member_code && exist?.address_code) return exist;

  for (let i = 0; i < 200; i++) {
    const mc = exist?.member_code?.trim() || rand4();
    const ac = exist?.address_code?.trim() || rand4();

    const c = await p.connect();
    try {
      await c.query("BEGIN");
      await c.query(`INSERT INTO codes (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);

      const cur = await c.query(`SELECT member_code, address_code FROM codes WHERE user_id=$1 FOR UPDATE`, [uid]);
      const row = cur.rows[0] || {};
      const nextMember = row.member_code ? row.member_code : mc;
      const nextAddress = row.address_code ? row.address_code : ac;

      await c.query(`UPDATE codes SET member_code=$2, address_code=$3 WHERE user_id=$1`, [uid, nextMember, nextAddress]);
      await c.query("COMMIT");

      const done = await dbGetCodesByUserId(uid);
      if (done?.member_code && done?.address_code) return done;
    } catch (e) {
      await c.query("ROLLBACK");
      if (String(e?.code) === "23505") continue;
      throw e;
    } finally {
      c.release();
    }
  }
  throw new Error("code_generation_exhausted");
}

async function dbUpsertAddressByUserId(userId, addr = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) throw new Error("userId required");

  const codes = await dbEnsureCodes(uid);
  const memberCode = String(codes.member_code || "").trim();

  const a = {
    name: String(addr.name || "").trim(),
    phone: String(addr.phone || "").trim(),
    postal: String(addr.postal || "").trim(),
    prefecture: String(addr.prefecture || "").trim(),
    city: String(addr.city || "").trim(),
    address1: String(addr.address1 || "").trim(),
    address2: String(addr.address2 || "").trim(),
  };

  await p.query(
    `
    INSERT INTO addresses (member_code, user_id, name, phone, postal, prefecture, city, address1, address2, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
    ON CONFLICT (member_code) DO UPDATE SET
      user_id=EXCLUDED.user_id,
      name=EXCLUDED.name,
      phone=EXCLUDED.phone,
      postal=EXCLUDED.postal,
      prefecture=EXCLUDED.prefecture,
      city=EXCLUDED.city,
      address1=EXCLUDED.address1,
      address2=EXCLUDED.address2,
      updated_at=NOW()
    `,
    [memberCode, uid, a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2]
  );

  return { memberCode, ...a };
}

async function dbGetAddressByUserId(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;

  const r = await p.query(
    `
    SELECT
      c.user_id, c.member_code, c.address_code,
      a.name, a.phone, a.postal, a.prefecture, a.city, a.address1, a.address2, a.updated_at
    FROM codes c
    LEFT JOIN addresses a ON a.member_code = c.member_code
    WHERE c.user_id = $1
    LIMIT 1
    `,
    [uid]
  );

  const row = r.rows[0] || null;
  if (!row?.member_code) return null;

  const hasAny = row.name || row.phone || row.postal || row.prefecture || row.city || row.address1 || row.address2;
  if (!hasAny) return null;

  return row;
}

async function dbGetAddressByMemberCode(memberCode) {
  const p = mustPool();
  const mc = String(memberCode || "").trim();
  if (!/^\d{4}$/.test(mc)) return null;
  const r = await p.query(`SELECT * FROM addresses WHERE member_code=$1 LIMIT 1`, [mc]);
  return r.rows[0] || null;
}

// ================================
// ★プロフィール保存（DB / ファイル）
// ================================
function nowIso() {
  return new Date().toISOString();
}

function fileUpsertLineUser(userId, prof = {}, patch = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return;
  const book = readLineUsersFile();
  const now = nowIso();
  if (!book[uid]) {
    book[uid] = {
      user_id: uid,
      display_name: "",
      picture_url: "",
      status_message: "",
      language: "",
      first_seen: now,
      last_seen: now,
      profile_updated_at: now,
      updated_at: now,
    };
  }
  const cur = book[uid];
  book[uid] = {
    ...cur,
    display_name: prof.displayName != null ? String(prof.displayName || "").slice(0, 120) : cur.display_name,
    picture_url: prof.pictureUrl != null ? String(prof.pictureUrl || "").slice(0, 512) : cur.picture_url,
    status_message: prof.statusMessage != null ? String(prof.statusMessage || "").slice(0, 400) : cur.status_message,
    language: prof.language != null ? String(prof.language || "").slice(0, 16) : cur.language,
    last_seen: now,
    profile_updated_at: patch.profileUpdatedAt || cur.profile_updated_at || now,
    updated_at: now,
  };
  writeLineUsersFile(book);
}

async function dbGetLineUserMeta(userId) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return null;
  const r = await p.query(
    `SELECT user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at FROM line_users WHERE user_id=$1 LIMIT 1`,
    [uid]
  );
  return r.rows[0] || null;
}

async function dbUpsertLineUser(userId, prof = {}, opts = {}) {
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return;

  const displayName = prof?.displayName != null ? String(prof.displayName || "").slice(0, 120) : null;
  const pictureUrl = prof?.pictureUrl != null ? String(prof.pictureUrl || "").slice(0, 512) : null;
  const statusMessage = prof?.statusMessage != null ? String(prof.statusMessage || "").slice(0, 400) : null;
  const language = prof?.language != null ? String(prof.language || "").slice(0, 16) : null;

  const forceProfile = !!opts.forceProfile;
  const hasProfileAny = !!(displayName || pictureUrl || statusMessage || language);

  await p.query(
    `
    INSERT INTO line_users (user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at, updated_at)
    VALUES ($1,$2,$3,$4,$5, NOW(), NOW(), NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, line_users.display_name),
      picture_url = COALESCE(EXCLUDED.picture_url, line_users.picture_url),
      status_message = COALESCE(EXCLUDED.status_message, line_users.status_message),
      language = COALESCE(EXCLUDED.language, line_users.language),
      last_seen = NOW(),
      profile_updated_at = CASE
        WHEN $6 THEN NOW()
        WHEN $7 THEN NOW()
        ELSE line_users.profile_updated_at
      END,
      updated_at = NOW()
    `,
    [uid, displayName, pictureUrl, statusMessage, language, forceProfile, hasProfileAny]
  );
}

function daysAgoMs(days) {
  return Number(days || 0) * 24 * 60 * 60 * 1000;
}

async function getLineProfileByEvent(ev) {
  const src = ev?.source || {};
  const type = src.type || "user";
  const userId = src.userId || "";
  if (!userId) return null;

  try {
    if (type === "group" && src.groupId) {
      if (typeof client.getGroupMemberProfile === "function") {
        return await client.getGroupMemberProfile(src.groupId, userId);
      }
      return null;
    }
    if (type === "room" && src.roomId) {
      if (typeof client.getRoomMemberProfile === "function") {
        return await client.getRoomMemberProfile(src.roomId, userId);
      }
      return null;
    }
    return await client.getProfile(userId);
  } catch {
    return null;
  }
}

async function maybeRefreshLineProfile(userId, ev, opts = {}) {
  const uid = String(userId || "").trim();
  if (!uid) return;

  const force = !!opts.force;

  if (!pool) {
    const prof = await getLineProfileByEvent(ev);
    if (prof) fileUpsertLineUser(uid, prof, { profileUpdatedAt: nowIso() });
    else fileUpsertLineUser(uid, {}, {});
    return;
  }

  try {
    const meta = await dbGetLineUserMeta(uid);
    const last = meta?.profile_updated_at ? new Date(meta.profile_updated_at).getTime() : 0;
    const need = force || !last || Date.now() - last > daysAgoMs(PROFILE_REFRESH_DAYS);

    if (!need) {
      await dbUpsertLineUser(uid, {}, { forceProfile: false });
      return;
    }

    const prof = await getLineProfileByEvent(ev);
    if (prof) await dbUpsertLineUser(uid, prof, { forceProfile: force });
    else await dbUpsertLineUser(uid, {}, { forceProfile: false });
  } catch {
    try {
      const prof = await getLineProfileByEvent(ev);
      if (prof) fileUpsertLineUser(uid, prof, { profileUpdatedAt: nowIso() });
      else fileUpsertLineUser(uid, {}, {});
    } catch {}
  }
}

// ★注文DB保存
async function dbInsertOrder(payload) {
  if (!pool) return { ok: false, skipped: "db_not_configured" };
  const p = mustPool();

  const {
    userId = null,
    memberCode = null,
    phone = null,
    items = [],
    total = 0,
    shippingFee = 0,
    paymentMethod = null,
    status = "new",
    name = null,
    zip = null,
    pref = null,
    address = null,
    source = null,
    rawEvent = null,
  } = payload || {};

  const src = String(source || rawEvent?.source || "").toLowerCase().trim();
  const payFromEvent = String(rawEvent?.payment_method || rawEvent?.paymentMethod || rawEvent?.payment || "").toLowerCase().trim();

  let pm = String(paymentMethod || payFromEvent || "").toLowerCase().trim();
  if (!pm) {
    if (src.includes("stripe")) pm = "stripe";
    else if (src.includes("cod")) pm = "cod";
    else if (src.includes("bank")) pm = "bank";
    else if (src.includes("store") || src.includes("pickup") || src.includes("cash")) pm = "store";
    else pm = "unknown";
  }
  if (!["stripe", "cod", "bank", "store", "unknown"].includes(pm)) pm = "unknown";

  let st = String(status || "").toLowerCase().trim();
  if (!st) st = pm === "stripe" ? "paid" : "new";

  const safeItems = Array.isArray(items) ? items : [];

  await p.query(
    `
    INSERT INTO orders (
      user_id, member_code, phone,
      items, total, shipping_fee,
      payment_method, status,
      name, zip, pref, address,
      source, raw_event
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `,
    [
      userId,
      memberCode,
      phone,
      JSON.stringify(safeItems),
      Number(total || 0),
      Number(shippingFee || 0),
      pm,
      st,
      name,
      zip,
      pref,
      address,
      source || null,
      rawEvent ? JSON.stringify(rawEvent) : null,
    ]
  );

  return { ok: true, payment_method: pm, status: st };
}

// =============== セグメント台帳 ===============
function normalizeLiffKind(kindRaw) {
  const k = String(kindRaw || "").trim().slice(0, 32);
  if (LIFF_OPEN_KIND_MODE === "keep") return k || "all";
  return "all";
}

async function dbTouchUser(userId, source = "seen") {
  if (!pool) return;
  const p = mustPool();
  const uid = String(userId || "").trim();
  if (!uid) return;

  const setChat = source === "chat";
  const setLiff = source === "liff";

  await p.query(
    `
    INSERT INTO segment_users (user_id, first_seen, last_seen, last_chat_at, last_liff_at)
    VALUES ($1, NOW(), NOW(),
      CASE WHEN $2 THEN NOW() ELSE NULL END,
      CASE WHEN $3 THEN NOW() ELSE NULL END
    )
    ON CONFLICT (user_id) DO UPDATE SET
      last_seen = NOW(),
      last_chat_at = CASE WHEN $2 THEN NOW() ELSE segment_users.last_chat_at END,
      last_liff_at = CASE WHEN $3 THEN NOW() ELSE segment_users.last_liff_at END
    `,
    [uid, setChat, setLiff]
  );
}

function fileTouchUser(userId, source = "seen") {
  const uid = String(userId || "").trim();
  if (!uid) return;
  const book = readSegmentUsers();
  const now = new Date().toISOString();
  if (!book[uid]) book[uid] = { userId: uid, firstSeen: now, lastSeen: now, lastChatAt: "", lastLiffAt: "" };
  book[uid].lastSeen = now;
  if (source === "chat") book[uid].lastChatAt = now;
  if (source === "liff") book[uid].lastLiffAt = now;
  writeSegmentUsers(book);
}

async function touchUser(userId, source = "seen") {
  try {
    if (pool) await dbTouchUser(userId, source);
    else fileTouchUser(userId, source);
  } catch {
    try {
      fileTouchUser(userId, source);
    } catch {}
  }
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// =====================================================
// ✅ セグメント抽出ロジック 1本化
// =====================================================
function normalizeSegmentSource(srcRaw) {
  const s = String(srcRaw || "active").trim().toLowerCase();
  if (["active", "chat", "liff", "seen", "all"].includes(s)) return s;
  return "active";
}
function clampDays(daysRaw) {
  return Math.min(365, Math.max(1, Number(daysRaw || 30)));
}

function buildSegmentWhereSql(source, daysParamIndex) {
  const src = normalizeSegmentSource(source);
  if (src === "all") {
    return { whereSql: `user_id IS NOT NULL AND user_id <> ''`, needsDays: false };
  }
  if (src === "chat") {
    return { whereSql: `last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  }
  if (src === "liff") {
    return { whereSql: `last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  }
  if (src === "seen") {
    return { whereSql: `last_seen >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day')`, needsDays: true };
  }
  return {
    whereSql: `(
      (last_chat_at IS NOT NULL AND last_chat_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day'))
      OR
      (last_liff_at IS NOT NULL AND last_liff_at >= NOW() - ($${daysParamIndex}::int * INTERVAL '1 day'))
    )`,
    needsDays: true,
  };
}

async function segmentGetUsersUnified({ days = 30, source = "active", limit = SEGMENT_PUSH_LIMIT } = {}) {
  if (pool) {
    const p = mustPool();
    const src = normalizeSegmentSource(source);
    const d = clampDays(days);
    const lim = Math.min(SEGMENT_PUSH_LIMIT, Math.max(1, Number(limit || SEGMENT_PUSH_LIMIT)));

    const { whereSql, needsDays } = buildSegmentWhereSql(src, 1);

    let countTotal = 0;
    if (needsDays) {
      const rc = await p.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM segment_users WHERE ${whereSql}`, [d]);
      countTotal = Number(rc.rows?.[0]?.c || 0);
    } else {
      const rc = await p.query(`SELECT COUNT(DISTINCT user_id)::int AS c FROM segment_users WHERE ${whereSql}`);
      countTotal = Number(rc.rows?.[0]?.c || 0);
    }

    let items = [];
    if (needsDays) {
      const r = await p.query(`SELECT DISTINCT user_id FROM segment_users WHERE ${whereSql} ORDER BY user_id ASC LIMIT $2`, [d, lim]);
      items = r.rows.map((x) => x.user_id).filter(Boolean);
    } else {
      const r = await p.query(`SELECT DISTINCT user_id FROM segment_users WHERE ${whereSql} ORDER BY user_id ASC LIMIT $1`, [lim]);
      items = r.rows.map((x) => x.user_id).filter(Boolean);
    }

    items = Array.from(new Set(items.filter(Boolean)));
    return { source: src, days: src === "all" ? null : d, countTotal, countItems: items.length, items };
  }

  const src = normalizeSegmentSource(source);
  const d = clampDays(days);
  const book = readSegmentUsers();
  const now = Date.now();
  const ms = d * 24 * 60 * 60 * 1000;

  const all = Object.values(book)
    .filter((x) => {
      const lastSeen = x?.lastSeen ? new Date(x.lastSeen).getTime() : 0;
      const lastChat = x?.lastChatAt ? new Date(x.lastChatAt).getTime() : 0;
      const lastLiff = x?.lastLiffAt ? new Date(x.lastLiffAt).getTime() : 0;

      if (src === "all") return !!x?.userId;
      if (src === "chat") return lastChat && now - lastChat <= ms;
      if (src === "liff") return lastLiff && now - lastLiff <= ms;
      if (src === "seen") return lastSeen && now - lastSeen <= ms;
      return (lastChat && now - lastChat <= ms) || (lastLiff && now - lastLiff <= ms);
    })
    .map((x) => x.userId)
    .filter(Boolean);

  const uniq = Array.from(new Set(all));
  const lim = Math.min(SEGMENT_PUSH_LIMIT, Math.max(1, Number(limit || SEGMENT_PUSH_LIMIT)));
  const items = uniq.slice(0, lim);

  return { source: src, days: src === "all" ? null : d, countTotal: uniq.length, countItems: items.length, items };
}

// =============== LIFF idToken verify（任意） ===============
async function verifyLineIdToken(idToken) {
  if (!idToken || !LINE_CHANNEL_ID) return null;
  try {
    const params = new URLSearchParams();
    params.set("id_token", idToken);
    params.set("client_id", LINE_CHANNEL_ID);

    const r = await fetchFn("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.sub || null;
  } catch {
    return null;
  }
}

// =============== 画面 ===============
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).type("text/plain").send("OK"));
app.get("/healthz", (_req, res) => res.status(200).type("text/plain").send("OK"));

app.get("/api/health", async (_req, res) => {
  let pg = null;
  if (pool) {
    try {
      const r = await mustPool().query("SELECT NOW() as now");
      pg = { ok: true, now: r.rows?.[0]?.now || null };
    } catch (e) {
      pg = { ok: false, error: e?.message || String(e) };
    }
  }
  res.json({
    ok: true,
    time: new Date().toISOString(),
    node: process.version,
    pg,
    env: {
      LIFF_OPEN_KIND_MODE,
      DATABASE_URL: !!process.env.DATABASE_URL,
      STRIPE_SECRET_KEY: !!process.env.STRIPE_SECRET_KEY,
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
      UPLOAD_DIR,
      DATA_DIR: DISK_DATA_DIR,
      PROFILE_REFRESH_DAYS,
      PICKUP_POSTBACK_DATA,
      ORIGINAL_SET_PRODUCT_ID,
    },
  });
});

// =============== LIFF config ===============
app.get("/api/liff/config", (req, res) => {
  const kind = String(req.query.kind || "order").trim();
  if (kind === "shop") {
    if (!LIFF_ID_SHOP) return res.status(500).json({ ok: false, error: "LIFF_ID_SHOP_not_set" });
    return res.json({ ok: true, liffId: LIFF_ID_SHOP });
  }
  if (kind === "cod") return res.json({ ok: true, liffId: LIFF_ID_DIRECT_ADDRESS || LIFF_ID });
  return res.json({ ok: true, liffId: LIFF_ID });
});

// =============== LIFF open log（kind=all統一） ===============
app.post("/api/liff/open", async (req, res) => {
  try {
    const kind = normalizeLiffKind(req.body?.kind);
    const idToken = String(req.body?.idToken || "").trim();
    const tokenUserId = await verifyLineIdToken(idToken);
    const userId = String(tokenUserId || req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });

    await touchUser(userId, "liff");

    try {
      if (pool) await dbUpsertLineUser(userId, {}, { forceProfile: false });
      else fileUpsertLineUser(userId, {}, {});
    } catch {}

    if (pool) {
      await mustPool().query(`INSERT INTO liff_open_logs (user_id, kind) VALUES ($1,$2)`, [userId, kind]);
      try {
        await dbEnsureCodes(userId);
      } catch {}
    }

    return res.json({ ok: true, kind });
  } catch (e) {
    console.error("/api/liff/open error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== 住所（DB） ===============
app.post("/api/liff/address", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const addr = req.body?.address || {};
    if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    await dbUpsertAddressByUserId(userId, addr);
    const codes = await dbEnsureCodes(userId);

    return res.json({
      ok: true,
      memberCode: String(codes.member_code || ""),
      addressCode: String(codes.address_code || ""),
      saved: true,
    });
  } catch (e) {
    console.error("/api/liff/address error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.get("/api/liff/address/me", async (req, res) => {
  try {
    const userId = String(req.query.userId || req.headers["x-line-userid"] || "").trim();
    if (!userId) return res.json({ ok: true, address: null });
    if (!pool) return res.json({ ok: true, address: null });

    const row = await dbGetAddressByUserId(userId);
    if (!row) return res.json({ ok: true, address: null });

    return res.json({
      ok: true,
      address: {
        name: row.name || "",
        phone: row.phone || "",
        postal: row.postal || "",
        prefecture: row.prefecture || "",
        city: row.city || "",
        address1: row.address1 || "",
        address2: row.address2 || "",
        memberCode: String(row.member_code || ""),
        addressCode: String(row.address_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/liff/address/me error:", e);
    return res.json({ ok: false, address: null });
  }
});

// ★公開住所取得（トークン必須）
app.get("/api/public/address-by-code", async (req, res) => {
  try {
    if (!PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(500).json({ ok: false, error: "PUBLIC_ADDRESS_LOOKUP_TOKEN_not_set" });
    const token = String(req.query.token || req.headers["x-public-token"] || "").trim();
    if (token !== PUBLIC_ADDRESS_LOOKUP_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });

    const code = String(req.query.code || "").trim();
    if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: "code_required" });
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const addr = await dbGetAddressByMemberCode(code);
    if (!addr) return res.status(404).json({ ok: false, error: "address_not_registered" });

    return res.json({
      ok: true,
      address: {
        postal: addr.postal || "",
        prefecture: addr.prefecture || "",
        city: addr.city || "",
        address1: addr.address1 || "",
        address2: addr.address2 || "",
        memberCode: String(addr.member_code || ""),
      },
    });
  } catch (e) {
    console.error("/api/public/address-by-code error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== ミニアプリ：商品一覧 ===============
app.get("/api/products", (_req, res) => {
  try {
    const items = readProducts()
      .filter((p) => !HIDE_PRODUCT_IDS.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        desc: p.desc || "",
        volume: p.volume || "",
        image: toPublicImageUrl(p.image || ""),
      }));
    return res.json({ ok: true, products: items });
  } catch (e) {
    console.error("/api/products error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =============== ミニアプリ：送料計算 ===============
app.post("/api/shipping", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const address = req.body?.address || {};

    const itemsTotal = items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const { region, size, shipping } = calcShippingUnified(items, address);
    const finalTotal = itemsTotal + shipping;

    return res.json({ ok: true, itemsTotal, region, size, shipping, finalTotal });
  } catch (e) {
    console.error("/api/shipping error:", e);
    return res.status(400).json({ ok: false, error: e?.message || "shipping_error" });
  }
});

app.get("/api/shipping/config", (_req, res) => {
  return res.json({
    ok: true,
    config: {
      origin: "yamato_chubu_taxed",
      originalSetProductId: ORIGINAL_SET_PRODUCT_ID,
      sizeOrder: SIZE_ORDER,
      yamatoChubuTaxed: YAMATO_CHUBU_TAXED,
      codFee: COD_FEE,
    },
  });
});

// =============== 送料見積（商品選択式：pref + items） ===============
app.post("/api/shipping/quote", (req, res) => {
  try {
    const pref = String(req.body?.pref || "").trim();
    const itemsIn = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!pref) return res.status(400).json({ ok: false, error: "pref_required" });
    if (!itemsIn.length) return res.status(400).json({ ok: false, error: "items_required" });

    const address = { prefecture: pref };

    const products = readProducts();
    const originalProduct =
      products.find((p) => p.id === ORIGINAL_SET_PRODUCT_ID) ||
      products.find((p) => /磯屋.?オリジナルセ/.test(String(p.name || ""))) ||
      null;
const hasOriginal = itemsIn.some((it) => String(it?.product_id || "").trim() === "original-set");

     const items = itemsIn
      .map((it) => {
        const pid = String(it?.product_id || "").trim();
        const qty = Math.max(0, Number(it?.qty || 0));
        if (!pid || !qty) return null;

        if (pid === "original-set") {
          return {
            id: ORIGINAL_SET_PRODUCT_ID,
            name: originalProduct?.name || "磯屋オリジナルセット",
            qty,
            price: Number(originalProduct?.price || 0),
          };
        }
        if (pid === "akasha") {
          return { id: "akasha_bundle", name: "のりあかしゃ", qty, price: 0 };
        }

        // ✅ 追加：久助（われせん）＝あかしゃと同一送料ロジック
       if (pid === "kusuke") {
  // ✅ original-set と一緒に買うときは、梱包（送料）を original-set 側で判定させる
  if (hasOriginal) {
    return {
      id: ORIGINAL_SET_PRODUCT_ID,         // ←梱包判定をオリジナルセット側へ
      name: "久助（われせん）",
      qty,
      price: 0,                            // 目安ページで商品代も出したいなら 250 に
    };
  }
  // ✅ 単体/あかしゃ系と一緒のときは、あかしゃ側の送料
  return { id: "akasha_bundle", name: "久助（われせん）", qty, price: 0 };
}

        return { id: "other_bundle", name: "その他商品", qty, price: 0 };
      })
      .filter(Boolean);


    if (!items.length) return res.status(400).json({ ok: false, error: "no_valid_items" });

    const itemsTotal = items.reduce((s, it) => s + (Number(it.price || 0) * Number(it.qty || 0)), 0);
    const { region, size, shipping } = calcShippingUnified(items, address);

    const shippingFee = Number(shipping || 0);
    const total = itemsTotal + shippingFee;

    return res.json({
      ok: true,
      region: region || "(不明)",
      size: size || "(不明)",
      shipping_fee: shippingFee,
      items_total: itemsTotal,
      total,
    });
  } catch (e) {
    console.error("/api/shipping/quote error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== Stripe ===============
const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET || "").trim();
const stripe = stripeSecretKey ? stripeLib(stripeSecretKey) : null;

app.post("/api/pay-stripe", async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ ok: false, error: "stripe_not_configured" });

    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.status(400).json({ ok: false, error: "no_items" });

    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);

    const line_items = [];
    for (const it of items) {
      const unit = Number(it.price) || 0;
      const qty = Number(it.qty) || 0;
      if (!qty || unit < 0) continue;
      line_items.push({
        price_data: { currency: "jpy", product_data: { name: String(it.name || it.id || "商品") }, unit_amount: unit },
        quantity: qty,
      });
    }
    if (shipping > 0) line_items.push({ price_data: { currency: "jpy", product_data: { name: "送料" }, unit_amount: shipping }, quantity: 1 });
    if (codFee > 0) line_items.push({ price_data: { currency: "jpy", product_data: { name: "代引き手数料" }, unit_amount: codFee }, quantity: 1 });
    if (!line_items.length) return res.status(400).json({ ok: false, error: "no_valid_line_items" });

    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers.host;
    const base = PUBLIC_BASE_URL || `${proto}://${host}`;

    const successUrl = `${base}/public/confirm-card-success.html`;
    const cancelUrl = `${base}/public/confirm-fail.html`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        lineUserId: order.lineUserId || "",
        lineUserName: order.lineUserName || "",
      },
    });

    return res.json({ ok: true, checkoutUrl: session.url });
  } catch (e) {
    console.error("[pay-stripe] error:", e?.raw || e);
    return res.status(500).json({ ok: false, error: "stripe_error" });
  }
});

// Stripe/代引/振込の完了通知（管理者/購入者） + ★DB保存
app.post("/api/order/complete", async (req, res) => {
  try {
    const order = req.body || {};
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return res.json({ ok: false, error: "no_items" });

    const paymentMethod = normalizePaymentMethodFromOrder(order);
    const status = paymentMethod === "stripe" ? "paid" : "new";
    const source =
      paymentMethod === "cod" ? "liff-cod" :
      paymentMethod === "bank" ? "liff-bank" :
      paymentMethod === "store" ? "liff-store" :
      "liff-stripe";

    try {
      fs.appendFileSync(
        ORDERS_LOG,
        JSON.stringify({ ts: new Date().toISOString(), ...order, source, payment_method: paymentMethod, status }) + "\n",
        "utf8"
      );
    } catch {}

    const a = order.address || {};
    const name = pickNameFromAddress(a) || order.lineUserName || "";
    const zip = a.zip || a.postal || "";
    const pref = a.prefecture || a.pref || "";
    const addrText = formatAddressText(a);
    const tel = a.tel || a.phone || "";
    const itemsTotal =
      Number(order.itemsTotal || 0) ||
      items.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty) || 0), 0);
    const shipping = Number(order.shipping || 0);
    const codFee = Number(order.codFee || 0);
    const finalTotal = Number(order.finalTotal ?? order.total ?? 0) || (itemsTotal + shipping + codFee);

    try {
      const memberCode = null;
      const addrLineForDb = `${a.city || ""}${a.addr1 || a.address1 || ""}${(a.addr2 || a.address2) ? " " + (a.addr2 || a.address2) : ""}`.trim();

      await dbInsertOrder({
        userId: order.lineUserId || null,
        memberCode,
        phone: tel || null,
        items: items.map((it) => ({ id: it.id || "", name: it.name || "", price: Number(it.price || 0), qty: Number(it.qty || 0) })),
        total: finalTotal,
        shippingFee: shipping,
        paymentMethod,
        status,
        name: name || null,
        zip: zip || null,
        pref: pref || null,
        address: addrLineForDb || null,
        source,
        rawEvent: order,
      });
    } catch (e) {
      console.error("orders db insert skipped:", e?.message || e);
    }

    const payText =
      paymentMethod === "cod" ? `代引（+${yen(codFee || COD_FEE)}）` :
      paymentMethod === "bank" ? "銀行振込" :
      paymentMethod === "store" ? "店頭現金" :
      "カード(Stripe)";

    const itemsLines = items
      .map((it) => `${it.name || it.id || "商品"} ×${Number(it.qty || 0)} = ${yen((Number(it.price) || 0) * (Number(it.qty) || 0))}`)
      .join("\n");

    const adminMsg =
      `🧾【注文完了（ミニアプリ）】\n` +
      `${itemsLines || "（明細なし）"}\n` +
      `\n支払：${payText}\n` +
      `商品計：${yen(itemsTotal)}\n` +
      `送料：${yen(shipping)}\n` +
      `代引手数料：${yen(codFee)}\n` +
      `合計：${yen(finalTotal)}\n` +
      `\n氏名：${name || ""}\nTEL：${tel || ""}\n住所：${addrText || "（未入力）"}\n` +
      `userId：${order.lineUserId || ""}\nsource：${source}`;

    if (ADMIN_USER_ID) {
      try {
        await client.pushMessage(ADMIN_USER_ID, { type: "text", text: adminMsg });
      } catch (e) {
        console.error("[ADMIN PUSH] /api/order/complete failed:", e?.response?.data || e?.message || e);
      }
    }

    const buyerId = String(order.lineUserId || "").trim();
    if (buyerId) {
      const buyerMsg =
        `ご注文ありがとうございます！\n` +
        `${itemsLines || ""}\n` +
        `\n支払：${payText}\n` +
        `合計：${yen(finalTotal)}\n` +
        `\n（このメッセージは自動送信です）`;

      try {
        await client.pushMessage(buyerId, { type: "text", text: buyerMsg });
      } catch (e) {
        console.warn("[BUYER PUSH] skipped/failed:", e?.response?.data || e?.message || e);
      }
    }

    return res.json({ ok: true, paymentMethod, status, source });
  } catch (e) {
    console.error("/api/order/complete error:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =============== 管理API：画像 ===============
app.post("/api/admin/upload", upload.single("file"), (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ ok: false, error: "no_file" });
    const url = toPublicImageUrl(f.filename);
    return res.json({ ok: true, filename: f.filename, url });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "upload_error" });
  }
});

app.get("/api/admin/images", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = fs.readdirSync(UPLOAD_DIR).filter((x) => !x.startsWith("."));
    return res.json({ ok: true, items: files.map((name) => ({ name, url: toPublicImageUrl(name) })) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/admin/images/delete", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });
    const pth = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(pth)) return res.status(404).json({ ok: false, error: "not_found" });
    fs.unlinkSync(pth);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// =============== 管理API：商品/在庫 ===============
app.get("/api/admin/products", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const items = readProducts().map((p) => ({ ...p, image: toPublicImageUrl(p.image || "") }));
  return res.json({ ok: true, products: items });
});

// ✅ 久助も含めて price/stock/volume を自由に更新できる
app.post("/api/admin/products/update", (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "id_required" });

    const { products, idx, product } = findProductById(id);
    if (!product) return res.status(404).json({ ok: false, error: "not_found" });

    const name = req.body?.name != null ? String(req.body.name) : product.name;
    const desc = req.body?.desc != null ? String(req.body.desc) : product.desc;
    const image = req.body?.image != null ? String(req.body.image) : product.image;
    const volume = req.body?.volume != null ? String(req.body.volume) : (product.volume || "");

    // ★久助も含めて price は request か既存値を採用（強制上書きしない）
    const price = req.body?.price != null ? Number(req.body.price) : product.price;
    const stock = req.body?.stock != null ? Number(req.body.stock) : product.stock;

    products[idx] = { ...product, name, desc, image, volume, price, stock };
    writeProducts(products);

    return res.json({ ok: true, product: products[idx] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/stock/add", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    const delta = Number(req.body?.delta || 0);
    const r = addStock(id, delta, "admin");
    const { product } = findProductById(id);
    await maybeLowStockAlert(id, product?.name || id, r.after);
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/stock/set", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = String(req.body?.id || "").trim();
    const qty = Number(req.body?.qty || 0);
    const r = setStock(id, qty, "admin");
    const { product } = findProductById(id);
    await maybeLowStockAlert(id, product?.name || id, r.after);
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== 管理API：注文（ファイル）/（DB） ===============
function readLogLines(filePath, limit = 100) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-Math.min(Number(limit) || 100, lines.length));
  return tail
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function yyyymmddFromIso(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

app.get("/api/admin/orders", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(5000, Number(req.query.limit || 1000));
  const date = String(req.query.date || "").trim();
  let items = readLogLines(ORDERS_LOG, limit);

  if (date && /^\d{8}$/.test(date)) {
    items = items.filter((o) => {
      const ts = o.ts || o.timestamp || o.created_at || "";
      const key = ts ? yyyymmddFromIso(ts) : "";
      return key === date;
    });
  }

  return res.json({ ok: true, items });
});

// ✅ 発送通知API（管理画面→顧客へPush）
app.post("/api/admin/orders/notify-shipped", async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const userId = String(req.body?.userId || "").trim();
    const orderKey = String(req.body?.orderKey || "").trim();
    const message = String(req.body?.message || "").trim();

    if (!userId) return res.status(400).json({ ok: false, error: "userId_required" });
    if (!message) return res.status(400).json({ ok: false, error: "message_required" });

    await client.pushMessage(userId, { type: "text", text: message });

    try {
      const st = readNotifyState();
      st[orderKey || `${userId}:${Date.now()}`] = { status: "ok", userId, ts: new Date().toISOString() };
      writeNotifyState(st);
    } catch (e) {
      console.warn("notify_state save skipped:", e?.message || e);
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("/api/admin/orders/notify-shipped error:", e?.response?.data || e?.message || e);
    return res.status(500).json({ ok: false, error: "notify_failed" });
  }
});

// DB注文（検索用）
app.get("/api/admin/orders-db", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const limit = Math.min(2000, Number(req.query.limit || 200));
    const payment = String(req.query.payment || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim().toLowerCase();
    const source = String(req.query.source || "").trim().toLowerCase();

    const wh = [];
    const params = [];
    let i = 1;

    if (payment) { wh.push(`payment_method = $${i++}`); params.push(payment); }
    if (status) { wh.push(`status = $${i++}`); params.push(status); }
    if (source) { wh.push(`LOWER(COALESCE(source,'')) LIKE $${i++}`); params.push(`%${source}%`); }

    params.push(limit);
    const whereSql = wh.length ? `WHERE ${wh.join(" AND ")}` : "";
    const sql = `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT $${i}`;

    const r = await mustPool().query(sql, params);
    return res.json({ ok: true, count: r.rows.length, items: r.rows });
  } catch (e) {
    console.error("/api/admin/orders-db error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =====================================
// ★管理：ユーザー一覧（display_name）
// =====================================
app.get("/api/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit || 500)));
    const q = String(req.query.q || "").trim();

    if (pool) {
      const p = mustPool();
      const params = [];
      let where = "";
      if (q) {
        params.push(`%${q}%`);
        where = `WHERE (display_name ILIKE $1 OR user_id ILIKE $1)`;
      }
      params.push(limit);

      const sql =
        `SELECT user_id, display_name, picture_url, status_message, language, first_seen, last_seen, profile_updated_at
         FROM line_users
         ${where}
         ORDER BY last_seen DESC
         LIMIT $${params.length}`;

      const r = await p.query(sql, params);
      return res.json({ ok: true, count: r.rows.length, items: r.rows });
    }

    const book = readLineUsersFile();
    let items = Object.values(book);
    if (q) {
      const qq = q.toLowerCase();
      items = items.filter((x) => String(x.display_name || "").toLowerCase().includes(qq) || String(x.user_id || "").toLowerCase().includes(qq));
    }
    items.sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));
    items = items.slice(0, limit);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    console.error("/api/admin/users error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =====================================================
// ✅ 管理：セグメント（統一抽出）
// =====================================================
app.get("/api/admin/segment/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const source = String(req.query.source || "active");
    const includeProfile = String(req.query.includeProfile || "0") === "1";

    const r = await segmentGetUsersUnified({ days, source, limit: SEGMENT_PUSH_LIMIT });

    let profiles = null;
    if (includeProfile) {
      profiles = {};
      if (pool) {
        const p = mustPool();
        const parts = chunkArray(r.items, 1000);
        for (const part of parts) {
          const rr = await p.query(`SELECT user_id, display_name FROM line_users WHERE user_id = ANY($1::text[])`, [part]);
          for (const row of rr.rows) profiles[row.user_id] = row.display_name || "";
        }
      } else {
        const book = readLineUsersFile();
        for (const uid of r.items) profiles[uid] = book?.[uid]?.display_name || "";
      }
    }

    return res.json({
      ok: true,
      days: r.days,
      source: r.source,
      count: r.countTotal,
      returned: r.countItems,
      limit: SEGMENT_PUSH_LIMIT,
      items: r.items,
      profiles,
    });
  } catch (e) {
    console.error("/api/admin/segment/users error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.get("/api/admin/segment/count", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const days = Number(req.query.days || 30);
    const source = String(req.query.source || "active");

    const r = await segmentGetUsersUnified({ days, source, limit: 1 });
    return res.json({ ok: true, days: r.days, source: r.source, count: r.countTotal });
  } catch (e) {
    console.error("/api/admin/segment/count error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/api/admin/segment/send", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(Boolean) : [];
    const messageText = String(req.body?.message || "").trim();

    if (!userIds.length) return res.status(400).json({ ok: false, error: "userIds_required" });
    if (!messageText) return res.status(400).json({ ok: false, error: "message_required" });

    const ids = Array.from(new Set(userIds)).slice(0, SEGMENT_PUSH_LIMIT);
    const chunks = chunkArray(ids, SEGMENT_CHUNK_SIZE);

    let okCount = 0;
    let ngCount = 0;

    for (const part of chunks) {
      try {
        await client.multicast(part, { type: "text", text: messageText });
        okCount += part.length;
      } catch (e) {
        ngCount += part.length;
        console.error("segment multicast error:", e?.response?.data || e?.message || e);
      }
    }

    return res.json({ ok: true, requested: ids.length, sent: okCount, failed: ngCount });
  } catch (e) {
    console.error("/api/admin/segment/send error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =====================================
// ★管理：友だち追加/ブロック 統計
// =====================================
app.get("/api/admin/follow/stats", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!pool) return res.status(500).json({ ok: false, error: "db_not_configured" });

    const p = mustPool();
    const tz = String(req.query.tz || "Asia/Tokyo").trim();

    const sql = `
      WITH
      t AS (
        SELECT (date_trunc('day', now() AT TIME ZONE $1))::timestamp AS jst_today_start
      ),
      f AS (
        SELECT
          COUNT(*)::int AS follow_total_events,
          COUNT(DISTINCT user_id)::int AS follow_total_unique,

          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t))::int AS follow_today,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '1 day'
                           AND (event_ts AT TIME ZONE $1) <  (SELECT jst_today_start FROM t))::int AS follow_yesterday,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '7 day')::int AS follow_last7,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '30 day')::int AS follow_last30,

          COUNT(DISTINCT user_id) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t))::int AS follow_today_unique,
          COUNT(DISTINCT user_id) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '7 day')::int AS follow_last7_unique,
          COUNT(DISTINCT user_id) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '30 day')::int AS follow_last30_unique
        FROM follow_events
      ),
      u AS (
        SELECT
          COUNT(*)::int AS unfollow_total_events,
          COUNT(DISTINCT user_id)::int AS unfollow_total_unique,

          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t))::int AS unfollow_today,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '1 day'
                           AND (event_ts AT TIME ZONE $1) <  (SELECT jst_today_start FROM t))::int AS unfollow_yesterday,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '7 day')::int AS unfollow_last7,
          COUNT(*) FILTER (WHERE (event_ts AT TIME ZONE $1) >= (SELECT jst_today_start FROM t) - INTERVAL '30 day')::int AS unfollow_last30
        FROM unfollow_events
      )
      SELECT
        (SELECT jst_today_start FROM t) AS jst_today_start,
        f.*, u.*,
        (f.follow_today - u.unfollow_today)::int AS net_today,
        (f.follow_last7 - u.unfollow_last7)::int AS net_last7,
        (f.follow_last30 - u.unfollow_last30)::int AS net_last30
      FROM f, u
    `;

    const r = await p.query(sql, [tz]);
    return res.json({ ok: true, tz, stats: r.rows?.[0] || null });
  } catch (e) {
    console.error("/api/admin/follow/stats error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// =============== LINE疎通 ===============
app.get("/api/line/ping", async (_req, res) => {
  try {
    if (!ADMIN_USER_ID) return res.status(400).json({ ok: false, error: "ADMIN_USER_ID not set" });
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: "✅ LINEサーバー疎通OK" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.response?.data || e?.message || String(e) });
  }
});

// =============== 注文フローUI（Flex） ===============
function qstr(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? "" : String(v))}`)
    .join("&");
}
function parseQuery(data) {
  const s = data && data.includes("?") ? data.split("?")[1] : data;
  const o = {};
  String(s || "")
    .split("&")
    .forEach((kv) => {
      const [k, v] = kv.split("=");
      if (k) o[decodeURIComponent(k)] = decodeURIComponent(v || "");
    });
  return o;
}
function parsePostbackParams(data) {
  try {
    const s = String(data || "").trim();
    const qs = s.includes("?") ? s.split("?")[1] : s;
    return new URLSearchParams(qs);
  } catch {
    return new URLSearchParams();
  }
}

function productsFlex() {
  const all = readProducts().filter((p) => !HIDE_PRODUCT_IDS.has(p.id));
  const bubbles = all.map((p) => {
    const img = toPublicImageUrl(p.image || "");
    return {
      type: "bubble",
      hero: img ? { type: "image", url: img, size: "full", aspectRatio: "1:1", aspectMode: "cover" } : undefined,
      body: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          { type: "text", text: p.name, weight: "bold", size: "md", wrap: true },
          { type: "text", text: `価格：${yen(p.price)}　在庫：${p.stock ?? 0}`, size: "sm", wrap: true },
          p.volume ? { type: "text", text: `内容量：${String(p.volume)}`, size: "sm", wrap: true } : null,
          p.desc ? { type: "text", text: p.desc, size: "sm", wrap: true } : null,
        ].filter(Boolean),
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [{ type: "button", style: "primary", action: { type: "postback", label: "数量を選ぶ", data: `order_qty?${qstr({ id: p.id, qty: 1 })}` } }],
      },
    };
  });

  bubbles.push({
    type: "bubble",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      contents: [
        { type: "text", text: "その他（自由入力）", weight: "bold", size: "md" },
        { type: "text", text: "商品名と個数だけ入力します（価格入力不要）。", size: "sm", wrap: true },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      contents: [{ type: "button", style: "primary", action: { type: "postback", label: "商品名を入力する", data: "other_start" } }],
    },
  });

  return { type: "flex", altText: "商品一覧", contents: { type: "carousel", contents: bubbles } };
}

function qtyFlex(id, qty = 1) {
  const q = Math.max(1, Math.min(99, Number(qty) || 1));
  return {
    type: "flex",
    altText: "数量を選択してください",
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "数量選択", weight: "bold", size: "lg" }, { type: "text", text: `現在の数量：${q} 個`, size: "md" }] },
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
              { type: "button", style: "secondary", action: { type: "postback", label: "-1", data: `order_qty?${qstr({ id, qty: Math.max(1, q - 1) })}` } },
              { type: "button", style: "secondary", action: { type: "postback", label: "+1", data: `order_qty?${qstr({ id, qty: Math.min(99, q + 1) })}` } },
            ],
          },
          {
            type: "box",
            layout: "horizontal",
            spacing: "md",
            contents: [1, 2, 3, 5].map((n) => ({
              type: "button",
              style: n === q ? "primary" : "secondary",
              action: { type: "postback", label: `${n}個`, data: `order_qty?${qstr({ id, qty: n })}` },
            })),
          },
          { type: "button", style: "primary", action: { type: "postback", label: "受取方法へ", data: `order_method?${qstr({ id, qty: q })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧", data: "order_back" } },
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
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "受取方法", weight: "bold", size: "lg" }, { type: "text", text: "宅配 または 店頭受取 を選択してください。", wrap: true }] },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", label: "宅配（送料あり）", data: `order_payment?${qstr({ id, qty, method: "delivery" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "店頭受取（送料0円）", data: `order_payment?${qstr({ id, qty, method: "pickup" })}` } },
        ],
      },
    },
  };
}

function paymentFlex(id, qty, method) {
  if (method === "pickup") {
    return {
      type: "flex",
      altText: "店頭受取（現金のみ）",
      contents: {
        type: "bubble",
        body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "お支払い方法", weight: "bold", size: "lg" }, { type: "text", text: "店頭受取は現金のみです。", wrap: true }] },
        footer: {
          type: "box",
          layout: "vertical",
          spacing: "md",
          contents: [
            { type: "button", style: "primary", action: { type: "postback", label: "現金で支払う（店頭）", data: `order_pickup_name?${qstr({ id, qty, method: "pickup", payment: "cash" })}` } },
            { type: "button", style: "secondary", action: { type: "postback", label: "← 戻る", data: `order_method?${qstr({ id, qty })}` } },
          ],
        },
      },
    };
  }

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
          { type: "text", text: "お支払い方法", weight: "bold", size: "lg" },
          { type: "text", text: "送料は登録住所から自動計算します。", wrap: true },
          { type: "text", text: `代引きは +${yen(COD_FEE)}`, wrap: true },
        ],
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "md",
        contents: [
          { type: "button", style: "primary", action: { type: "postback", label: `代金引換（+${yen(COD_FEE)}）`, data: `order_confirm_view?${qstr({ id, qty, method: "delivery", payment: "cod" })}` } },
          { type: "button", style: "secondary", action: { type: "postback", label: "銀行振込", data: `order_confirm_view?${qstr({ id, qty, method: "delivery", payment: "bank" })}` } },
        ],
      },
    },
  };
}

function confirmFlex(product, qty, method, payment, address, pickupName) {
  const subtotal = Number(product.price) * Number(qty);

  let region = "";
  let size = "";
  let shipping = 0;
  let addressOk = true;

  if (method === "delivery") {
    if (!address) addressOk = false;
    else {
      const r = calcShippingUnified([{ id: product.id, name: product.name, qty }], address);
      region = r.region;
      size = r.size;
      shipping = r.shipping;
      if (!region) addressOk = false;
    }
  }

  const codFee = payment === "cod" ? COD_FEE : 0;
  const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

  const payText = payment === "cod" ? `代金引換（+${yen(COD_FEE)}）` : payment === "bank" ? "銀行振込" : "現金（店頭）";

  const lines = [
    `受取方法：${method === "pickup" ? "店頭受取（送料0円）" : "宅配（送料あり）"}`,
    `支払い：${payText}`,
    `商品：${product.name}`,
    ...(product.volume ? [`内容量：${String(product.volume)}`] : []),
    `数量：${qty}個`,
    `小計：${yen(subtotal)}`,
  ];

  if (method === "delivery") {
    if (addressOk) {
      lines.push(`配送地域：${region}`);
      lines.push(`サイズ：${size}`);
      lines.push(`送料：${yen(shipping)}`);
    } else {
      lines.push("送料：住所未登録（または都道府県が不明）のため計算できません");
    }
  } else {
    lines.push("送料：0円");
  }

  lines.push(`代引き手数料：${yen(codFee)}`);
  lines.push(`合計：${yen(total)}`);

  if (method === "pickup" && pickupName) lines.push(`お名前：${pickupName}`);

  const img = toPublicImageUrl(product.image || "");

  const footerButtons = [];
  if (method === "delivery" && !addressOk) {
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "uri", label: "住所を入力（LIFF）", uri: `https://liff.line.me/${LIFF_ID_DIRECT_ADDRESS || LIFF_ID}?from=address&need=shipping` },
    });
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
  } else {
    footerButtons.push({ type: "button", style: "secondary", action: { type: "postback", label: "← 商品一覧へ", data: "order_back" } });
    footerButtons.push({
      type: "button",
      style: "primary",
      action: { type: "postback", label: "この内容で確定", data: `order_confirm?${qstr({ id: product.id, qty, method, payment, pickupName: pickupName || "" })}` },
    });
  }

  return {
    type: "flex",
    altText: "注文内容の最終確認",
    contents: {
      type: "bubble",
      hero: img ? { type: "image", url: img, size: "full", aspectRatio: "1:1", aspectMode: "cover" } : undefined,
      body: { type: "box", layout: "vertical", spacing: "md", contents: [{ type: "text", text: "最終確認", weight: "bold", size: "lg" }, ...lines.map((t) => ({ type: "text", text: t, wrap: true }))] },
      footer: { type: "box", layout: "vertical", spacing: "md", contents: footerButtons },
    },
  };
}

// =============== セッション（注文途中状態） ===============
function setSession(userId, patch) {
  const s = readSessions();
  s[userId] = { ...(s[userId] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeSessions(s);
}
function getSession(userId) {
  const s = readSessions();
  return s[userId] || null;
}
function clearSession(userId) {
  const s = readSessions();
  delete s[userId];
  writeSessions(s);
}

// =============== LINE Webhook ===============
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    const detail = err?.response?.data || err?.stack || err;
    console.error("Webhook Error:", JSON.stringify(detail, null, 2));
    res.status(500).end();
  }
});

// =============== 予約ログ ===============
function appendJsonl(filePath, obj) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  } catch {}
}

function eventSourceText(ev) {
  const s = ev?.source || {};
  const type = s.type || "unknown";
  if (type === "user") return `user:${s.userId || ""}`;
  if (type === "group") return `group:${s.groupId || ""} user:${s.userId || ""}`;
  if (type === "room") return `room:${s.roomId || ""} user:${s.userId || ""}`;
  return `${type}:${s.userId || ""}`;
}

async function notifyAdminIncomingMessage(ev, bodyText, extra = {}) {
  if (!ADMIN_USER_ID) return;

  const userId = ev?.source?.userId || "";
  const ts = ev?.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString();
  const src = eventSourceText(ev);

  const msg =
    `📩【受信メッセージ】\n` +
    `時刻：${ts}\n` +
    `送信元：${src}\n` +
    (userId ? `userId：${userId}\n` : "") +
    (extra?.kind ? `種別：${extra.kind}\n` : "") +
    (extra?.session ? `セッション：${extra.session}\n` : "") +
    `\n` +
    `${String(bodyText || "").slice(0, 1800)}`;

  try {
    await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg });
  } catch (e) {
    console.error("[ADMIN PUSH] incoming message failed:", e?.response?.data || e?.message || e);
  }
}

async function logFollowUnfollow(ev) {
  if (!pool) return;

  const userId = ev?.source?.userId;
  if (!userId) return;

  try {
    const tsMs = Number(ev.timestamp || Date.now());
    const eventTs = new Date(tsMs).toISOString();
    const raw = ev || {};

    if (ev.type === "follow") {
      await mustPool().query(
        `
        INSERT INTO follow_events (user_id, event_ts, raw_event)
        VALUES ($1, $2::timestamptz, $3::jsonb)
        `,
        [userId, eventTs, JSON.stringify(raw)]
      );
      console.log("[follow_events] inserted:", userId);
    } else if (ev.type === "unfollow") {
      await mustPool().query(
        `
        INSERT INTO unfollow_events (user_id, event_ts, raw_event)
        VALUES ($1, $2::timestamptz, $3::jsonb)
        `,
        [userId, eventTs, JSON.stringify(raw)]
      );
      console.log("[unfollow_events] inserted:", userId);
    }
  } catch (e) {
    console.error("[follow/unfollow] DB insert failed:", e?.code, e?.message);
  }
}

// =============== handleEvent ===============
async function handleEvent(ev) {
  const userId = ev?.source?.userId || "";

  try { await logFollowUnfollow(ev); } catch (e) { console.error("logFollowUnfollow:", e?.message || e); }

  if (userId) {
    try { await touchUser(userId, "seen"); } catch {}
    try {
      const force = ev.type === "follow";
      await maybeRefreshLineProfile(userId, ev, { force });
    } catch {}
  }

  // 会員コード照会（チャット）
  if (ev.type === "message" && ev.message?.type === "text" && ev.message.text.trim() === "会員コード") {
    try {
      if (!pool) {
        return client.replyMessage(ev.replyToken, {
          type: "text",
          text: "現在、会員コード照会（DB）が未設定です。住所登録（LIFF）後にDB設定をご確認ください。",
        });
      }

      let c = await dbGetCodesByUserId(userId);
      if (!c?.member_code) c = await dbEnsureCodes(userId);

      if (!c?.member_code) {
        return client.replyMessage(ev.replyToken, { type: "text", text: "会員コードの発行に失敗しました。時間をおいてお試しください。" });
      }

      return client.replyMessage(ev.replyToken, {
        type: "text",
        text: `あなたの会員コードは【${String(c.member_code).trim()}】です。\n\n📞 電話注文の際にお伝えください。`,
      });
    } catch (err) {
      console.error("会員コード取得エラー", err);
      return client.replyMessage(ev.replyToken, { type: "text", text: "会員コードの取得に失敗しました。時間をおいてお試しください。" });
    }
  }

  // 友だち追加
  if (ev.type === "follow") {
    if (userId) {
      if (pool) {
        try { await dbEnsureCodes(userId); } catch {}
      }
      if (ADMIN_USER_ID) {
        try {
          await client.pushMessage(ADMIN_USER_ID, {
            type: "text",
            text:
              `➕【友だち追加】\nuserId：${userId}\n` +
              `時刻：${ev?.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString()}`,
          });
        } catch {}
      }
    }

    const msg =
      "友だち追加ありがとうございます！\n\n" +
      "・「直接注文」→ 商品一覧（通常商品）\n" +
      "・「久助」→ 久助の注文（「久助 3」のように入力）\n" +
      "・住所登録（LIFF）もできます";
    return client.replyMessage(ev.replyToken, { type: "text", text: msg });
  }

  if (ev.type === "unfollow") return null;

  // テキスト以外は管理者へ通知（返信なし）
  if (ev.type === "message" && ev.message && ev.message.type && ev.message.type !== "text") {
    const m = ev.message;

    if (m.type === "sticker") {
      await notifyAdminIncomingMessage(ev, `（スタンプ）packageId=${m.packageId} stickerId=${m.stickerId}`, { kind: "sticker" });
      return null;
    }
    if (m.type === "location") {
      const t =
        `（位置情報）\n` +
        `タイトル：${m.title || ""}\n` +
        `住所：${m.address || ""}\n` +
        `緯度経度：${m.latitude},${m.longitude}`;
      await notifyAdminIncomingMessage(ev, t, { kind: "location" });
      return null;
    }
    if (m.type === "image" || m.type === "video" || m.type === "audio" || m.type === "file") {
      await notifyAdminIncomingMessage(ev, `（${m.type}）messageId=${m.id || ""}`, { kind: m.type });
      return null;
    }

    await notifyAdminIncomingMessage(ev, `（${m.type}）受信`, { kind: m.type });
    return null;
  }

  // ✅ テキストメッセージ
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = String(ev.message.text || "").trim();
    const sess = userId ? getSession(userId) : null;

    try { await notifyAdminIncomingMessage(ev, text, { kind: "text", session: sess?.mode || "" }); } catch {}

    // --- セッション入力 ---
    if (sess?.mode === "pickup_name") {
      await touchUser(userId, "chat");
      const pickupName = text.slice(0, 40);
      const id = sess.id;
      const qty = Number(sess.qty || 1);
      const method = "pickup";
      const payment = "cash";
      clearSession(userId);

      const product = loadProductByOrderId(id);
      return client.replyMessage(ev.replyToken, [
        { type: "text", text: `店頭受取のお名前「${pickupName}」で進めます。` },
        confirmFlex(product, qty, method, payment, null, pickupName),
      ]);
    }

    if (sess?.mode === "other_name") {
      await touchUser(userId, "chat");
      const name = text.replace(/\s+/g, " ").slice(0, 60);
      if (!name) return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください。" });
      setSession(userId, { mode: "other_qty", otherName: name });
      return client.replyMessage(ev.replyToken, { type: "text", text: `「${name}」ですね。個数を数字で入力してください（例：3）` });
    }

    if (sess?.mode === "other_qty") {
      await touchUser(userId, "chat");
      const m = /^(\d{1,2})$/.exec(text);
      if (!m) return client.replyMessage(ev.replyToken, { type: "text", text: "個数を数字で入力してください（例：3）" });
      const qty = Number(m[1]);
      if (qty < 1 || qty > 99) return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 で入力してください。" });

      const otherName = String(sess.otherName || "その他");
      setSession(userId, { mode: "", otherName: "" });

      const id = `other:${encodeURIComponent(otherName)}:0`;
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "受取方法を選択してください。" }, methodFlex(id, qty)]);
    }

    // ① 直接注文（通常）
    if (text === "直接注文") {
      await touchUser(userId, "chat");
      clearSession(userId);
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "直接注文を開始します。商品一覧です。" }, productsFlex()]);
    }

    // ② 久助（単価は products.json の現在値を表示）
    if (text === "久助") {
      await touchUser(userId, "chat");
      const { product } = findProductById("kusuke-250");
      const unit = product ? yen(product.price) : "（不明）";
      const msg =
        "久助のご注文を開始します。\n" +
        `単価：${unit}（税込）\n\n` +
        "「久助 3」のように数量を入力してください。";
      return client.replyMessage(ev.replyToken, { type: "text", text: msg });
    }

    // ③ 久助 数量（★修正：DB住所があれば読み込んで送料計算できる）
    const m = /^久助\s*(\d{1,2})$/.exec(text.replace(/[　]+/g, " "));
    if (m) {
      await touchUser(userId, "chat");
      const qty = Number(m[1]);
      if (qty < 1 || qty > 99) {
        return client.replyMessage(ev.replyToken, { type: "text", text: "個数は 1〜99 で入力してください。" });
      }

      const { product } = findProductById("kusuke-250");
      if (!product) {
        return client.replyMessage(ev.replyToken, { type: "text", text: "久助の商品データが見つかりません。" });
      }

      const stock = Number(product.stock || 0);
      if (stock < qty) {
        appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: product.id, productName: product.name, qty, reason: "stock_shortage" });
        return client.replyMessage(ev.replyToken, [
          { type: "text", text: `在庫不足です（在庫${stock}個）。予約しますか？` },
          {
            type: "template",
            altText: "予約",
            template: {
              type: "confirm",
              text: "予約しますか？",
              actions: [
                { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: product.id, qty })}` },
                { type: "postback", label: "やめる", data: "order_cancel" },
              ],
            },
          },
        ]);
      }

      // ★DBから住所を読む（住所があれば confirmFlex に反映して送料/サイズが出る）
      let address = null;
      if (pool) {
        try {
          const row = await dbGetAddressByUserId(userId);
          if (row) {
            address = {
              name: row.name || "",
              phone: row.phone || "",
              postal: row.postal || "",
              prefecture: row.prefecture || "",
              city: row.city || "",
              address1: row.address1 || "",
              address2: row.address2 || "",
            };
          }
        } catch (e) {
          console.warn("[kusuke] dbGetAddressByUserId failed:", e?.message || e);
        }
      }

      // デフォルトは「宅配 + 代引」で確認表示（住所が無ければ住所未登録表示 + 住所入力LIFFボタン）
      return client.replyMessage(ev.replyToken, [
        { type: "text", text: "久助の注文内容です。" },
        confirmFlex(product, qty, "delivery", "cod", address, null),
      ]);
    }

    // それ以外は無反応
    return null;
  }

  // ===========================
  // Postback
  // ===========================
  if (ev.type === "postback") {
    const data = String(ev.postback?.data || "");
    if (!userId) return null;

    // ★リッチメニュー：店頭受取開始（postback）
    {
      const params = parsePostbackParams(data);
      const action = params.get("action") || "";

      if (data.trim() === PICKUP_POSTBACK_DATA || action === "pickup_start") {
        setSession(userId, { pickupOnly: true });
        return client.replyMessage(ev.replyToken, [
          { type: "text", text: "店頭受取でご注文を開始します。商品を選んでください。" },
          productsFlex(),
        ]);
      }
    }

    if (data === "order_back") {
      return client.replyMessage(ev.replyToken, [{ type: "text", text: "商品一覧に戻ります。" }, productsFlex()]);
    }

    if (data === "other_start") {
      setSession(userId, { mode: "other_name" });
      return client.replyMessage(ev.replyToken, { type: "text", text: "商品名を入力してください（例：えびせん詰め合わせ）" });
    }

    if (data.startsWith("order_qty?")) {
      const q = parseQuery(data);
      return client.replyMessage(ev.replyToken, qtyFlex(q.id, q.qty));
    }

    if (data.startsWith("order_method?")) {
      const q = parseQuery(data);
      const qty = Number(q.qty || 1);

      const sess = getSession(userId);
      if (sess?.pickupOnly) {
        return client.replyMessage(ev.replyToken, paymentFlex(q.id, qty, "pickup"));
      }
      return client.replyMessage(ev.replyToken, methodFlex(q.id, qty));
    }

    if (data.startsWith("order_payment?")) {
      const q = parseQuery(data);
      const qty = Number(q.qty || 1);

      const sess = getSession(userId);
      const method = sess?.pickupOnly ? "pickup" : q.method;

      return client.replyMessage(ev.replyToken, paymentFlex(q.id, qty, method));
    }

    if (data.startsWith("order_pickup_name?")) {
      const q = parseQuery(data);
      setSession(userId, { mode: "pickup_name", id: q.id, qty: Number(q.qty || 1), method: "pickup", payment: "cash" });
      return client.replyMessage(ev.replyToken, { type: "text", text: "店頭で受け取るお名前を入力してください。" });
    }

    if (data.startsWith("order_confirm_view?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);

      const sess = getSession(userId);
      const method = sess?.pickupOnly ? "pickup" : q.method;
      const payment = sess?.pickupOnly ? "cash" : q.payment;

      const product = loadProductByOrderId(id);

      let address = null;
      if (method === "delivery" && pool) {
        const row = await dbGetAddressByUserId(userId);
        if (row) {
          address = { name: row.name || "", phone: row.phone || "", postal: row.postal || "", prefecture: row.prefecture || "", city: row.city || "", address1: row.address1 || "", address2: row.address2 || "" };
        }
      }

      const flex = confirmFlex(product, qty, method, payment, address, null);
      return client.replyMessage(ev.replyToken, flex);
    }

    if (data.startsWith("order_confirm?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);

      const sess = getSession(userId);
      const method = sess?.pickupOnly ? "pickup" : q.method;
      const payment = sess?.pickupOnly ? "cash" : q.payment;

      const pickupName = String(q.pickupName || "").trim();
      const product = loadProductByOrderId(id);

      if (!String(product.id).startsWith("other:")) {
        const { product: p } = findProductById(product.id);
        if (!p) return client.replyMessage(ev.replyToken, { type: "text", text: "商品が見つかりません。" });

        const stock = Number(p.stock || 0);
        if (stock < qty) {
          appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: p.id, productName: p.name, qty, reason: "stock_shortage" });
          return client.replyMessage(ev.replyToken, [
            { type: "text", text: `在庫不足です（在庫${stock}個）。予約しますか？` },
            {
              type: "template",
              altText: "予約",
              template: {
                type: "confirm",
                text: "予約しますか？",
                actions: [
                  { type: "postback", label: "予約する", data: `order_reserve?${qstr({ id: p.id, qty })}` },
                  { type: "postback", label: "やめる", data: "order_cancel" },
                ],
              },
            },
          ]);
        }

        addStock(p.id, -qty, "order_confirm");
        await maybeLowStockAlert(p.id, p.name, Math.max(0, stock - qty));
      }

      let address = null;
      if (method === "delivery" && pool) {
        const row = await dbGetAddressByUserId(userId);
        if (row) {
          address = { name: row.name || "", phone: row.phone || "", postal: row.postal || "", prefecture: row.prefecture || "", city: row.city || "", address1: row.address1 || "", address2: row.address2 || "" };
        }
      }

      let shipping = 0;
      let region = "";
      let size = "";
      if (method === "delivery") {
        const r = calcShippingUnified([{ id: product.id, name: product.name, qty }], address || {});
        shipping = r.shipping;
        region = r.region;
        size = r.size;
      }

      const subtotal = Number(product.price || 0) * qty;
      const codFee = payment === "cod" ? COD_FEE : 0;
      const total = subtotal + (method === "delivery" ? shipping : 0) + codFee;

      const order = {
        ts: new Date().toISOString(),
        userId,
        productId: product.id,
        productName: product.name,
        price: Number(product.price || 0),
        qty,
        method,
        payment,
        pickupName: method === "pickup" ? pickupName : "",
        shipping,
        region,
        size,
        codFee,
        total,
        address: address ? { name: address.name || "", phone: address.phone || "", postal: address.postal || "", prefecture: address.prefecture || "", city: address.city || "", address1: address.address1 || "", address2: address.address2 || "" } : null,
        note: String(product.id).startsWith("other:") ? "価格未入力（その他）" : "",
      };

      try { appendJsonl(ORDERS_LOG, { ...order, source: "line-postback" }); } catch {}

      try {
        let memberCode = null;
        if (pool) {
          const c = await dbGetCodesByUserId(userId);
          memberCode = c?.member_code ? String(c.member_code).trim() : null;
        }

        const nameForDb = method === "pickup" ? pickupName || null : address?.name || null;
        const zip = address?.postal || null;
        const pref = address?.prefecture || null;
        const addrLine = address ? `${address.city || ""}${address.address1 || ""}${address.address2 ? " " + address.address2 : ""}`.trim() || null : null;

        await dbInsertOrder({
          userId,
          memberCode,
          phone: address?.phone || null,
          items: [{ id: product.id, name: product.name, price: Number(product.price || 0), qty }],
          total,
          shippingFee: method === "delivery" ? shipping : 0,
          paymentMethod: payment === "cod" ? "cod" : payment === "bank" ? "bank" : "store",
          status: "new",
          name: nameForDb,
          zip,
          pref,
          address: addrLine,
          source: "line-postback",
          rawEvent: { ...order, source: "line-postback" },
        });
      } catch (e) {
        console.error("orders db insert skipped:", e?.message || e);
      }

      if (ADMIN_USER_ID) {
        const addrText =
          method === "delivery" && address
            ? `住所：${address.postal || ""} ${address.prefecture || ""}${address.city || ""}${address.address1 || ""}${address.address2 ? " " + address.address2 : ""}\n氏名：${address.name || ""}\nTEL：${address.phone || ""}`
            : method === "pickup"
            ? `店頭受取：${pickupName || ""}`
            : "住所：未登録";

        const msg =
          `🧾【新規注文】\n` +
          `商品：${product.name}\n` +
          `数量：${qty}\n` +
          `受取：${method === "pickup" ? "店頭" : "宅配"}\n` +
          `支払：${payment === "cod" ? "代引" : payment === "bank" ? "振込" : "店頭現金"}\n` +
          (method === "delivery" ? `送料：${yen(shipping)}（${region || "不明"} / ${size || "?"}）\n` : "送料：0円\n") +
          (codFee ? `代引手数料：${yen(codFee)}\n` : "") +
          `合計：${yen(total)}\n` +
          (order.note ? `※${order.note}\n` : "") +
          `\n${addrText}`;

        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
      }

      const userMsg =
        "ご注文ありがとうございます！\n\n" +
        `商品：${product.name}\n` +
        `数量：${qty}\n` +
        (method === "delivery" ? `送料：${yen(shipping)}\n` + (codFee ? `代引手数料：${yen(codFee)}\n` : "") : "送料：0円\n") +
        `合計：${yen(total)}\n` +
        (method === "pickup" ? `\n店頭受取のお名前：${pickupName || ""}\n` : "") +
        (method === "delivery" && !address ? "\n※住所が未登録です。住所登録（LIFF）をお願いします。\n" : "");

      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: userMsg });
    }

    if (data.startsWith("order_reserve?")) {
      const q = parseQuery(data);
      const id = q.id;
      const qty = Number(q.qty || 1);
      const { product } = findProductById(id);
      appendJsonl(RESERVATIONS_LOG, { ts: new Date().toISOString(), userId, productId: id, productName: product?.name || id, qty, action: "reserve" });

      if (ADMIN_USER_ID) {
        const msg = `📌【予約】\n商品：${product?.name || id}\n数量：${qty}\nuserId：${userId}`;
        try { await client.pushMessage(ADMIN_USER_ID, { type: "text", text: msg }); } catch {}
      }

      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: "予約を受け付けました。入荷次第ご案内します。" });
    }

    if (data === "order_cancel") {
      clearSession(userId);
      return client.replyMessage(ev.replyToken, { type: "text", text: "キャンセルしました。" });
    }
  }

  return null;
}

function loadProductByOrderId(id) {
  if (String(id).startsWith("other:")) {
    const parts = String(id).split(":");
    const encName = parts[1] || "";
    const priceStr = parts[2] || "0";
    return { id, name: decodeURIComponent(encName || "その他"), price: Number(priceStr || 0), stock: 9999, image: "", volume: "" };
  }

  const { product } = findProductById(id);
  if (!product) return { id, name: id, price: 0, stock: 0, image: "", volume: "" };

  // ★久助も特別扱いしない（products.json の値をそのまま）
  return product;
}

// =============== 起動 ===============
async function start() {
  try {
    await ensureDbSchema();
    console.log("[BOOT] DB schema ensured");
  } catch (e) {
    console.error("[BOOT] ensureDbSchema failed:", e?.message || e);
  }

  app.listen(PORT, () => {
    console.log(`[BOOT] server listening on ${PORT}`);
    console.log(`[BOOT] DATA_DIR=${DISK_DATA_DIR}`);
    console.log(`[BOOT] PRODUCTS_PATH=${PRODUCTS_PATH}`);
    console.log(`[BOOT] UPLOAD_DIR=${UPLOAD_DIR}`);
    console.log(`[BOOT] PROFILE_REFRESH_DAYS=${PROFILE_REFRESH_DAYS}`);
    console.log(`[BOOT] PICKUP_POSTBACK_DATA=${PICKUP_POSTBACK_DATA}`);
    console.log(`[BOOT] ORIGINAL_SET_PRODUCT_ID=${ORIGINAL_SET_PRODUCT_ID}`);
  });
}

start().catch((e) => {
  console.error("[BOOT] start() failed:", e);
  process.exit(1);
});
