/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF）
 * ✅ あなたのB2画面（磯屋発送）に完全一致する “26列順” 確定版
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export SHIPPER_TEL="0569xxxxxxx"
 *   export SHIPPER_ZIP="4703412"          # ハイフン無し推奨（あっても中で除去）
 *   export SHIPPER_ADDR1="愛知県知多郡..." # 住所1
 *   export SHIPPER_NAME="磯屋"
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
 *
 * 任意env:
 *   SHIP_DATE="today" or "2026/02/13"
 *   SHIFT_JIS=1
 *   RECEIVER_TITLE="様"
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const LIMIT = parseInt(process.env.LIMIT || "200", 10);
const STATUS_LIST = (process.env.STATUS_LIST || "confirmed,paid,pickup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHIPPER_NAME = process.env.SHIPPER_NAME || "磯屋";
const SHIPPER_TEL = process.env.SHIPPER_TEL || "";
const SHIPPER_ZIP = process.env.SHIPPER_ZIP || "";
const SHIPPER_ADDR1 = process.env.SHIPPER_ADDR1 || "";
const RECEIVER_TITLE = process.env.RECEIVER_TITLE || "様";

function pad2(n) { return String(n).padStart(2, "0"); }
function shipDateStr() {
  const v = process.env.SHIP_DATE || "today";
  if (v !== "today") return v;
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function digitsOnly(v) {
  if (!v) return "";
  return String(v).replace(/[^\d]/g, "");
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

function buildItemName(order) {
  let items = [];
  try {
    const obj = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    if (Array.isArray(obj)) items = obj;
  } catch {}

  const names = items
    .map((it) => (it && (it.name || it.title || it.product_name)) ? (it.name || it.title || it.product_name) : "")
    .filter(Boolean);

  const s = names.length ? names.join(" / ") : "磯屋えびせん";
  return s.length > 30 ? s.slice(0, 30) : s;
}

// ✅ あなたのB2（磯屋発送）に完全一致する 26 列順
const COLUMNS = [
  "invoice_type",     // 1 送り状種類
  "cool_type",        // 2 クール区分
  "customer_no",      // 3 お客様管理番号
  "ship_date",        // 4 出荷予定日

  "receiver_tel",     // 5 お届け先電話番号
  "receiver_zip",     // 6 お届け先郵便番号
  "receiver_addr1",   // 7 お届け先住所1
  "receiver_addr2",   // 8 お届け先住所2
  "receiver_name",    // 9 お届け先名
  "receiver_kana",    // 10 お届け先名カナ
  "receiver_title",   // 11 敬称

  "tel_branch",       // 12 電話番号枝番（未使用で空でOK）
  "shipper_name",     // 13 ご依頼主名
  "shipper_tel",      // 14 ご依頼主電話番号
  "shipper_zip",      // 15 ご依頼主郵便番号
  "shipper_addr1",    // 16 ご依頼主住所1
  "shipper_addr2",    // 17 ご依頼主住所2

  "item_name_1",      // 18 品名1
  "item_name_2",      // 19 品名2
  "item_name_3",      // 20 品名3

  "handling_1",       // 21 荷扱い1
  "handling_2",       // 22 荷扱い2
  "note",             // 23 記事

  "cod_amount",       // 24 コレクト代金
  "cod_tax",          // 25 コレクト消費税
  "tail",             // 26 末尾列（止置/営業所コード等の枠：未使用なら空）
];

function normalizeReceiverAddr(pref, address) {
  const p = (pref || "").trim();
  const a = (address || "").trim();
  if (!p) return a;
  // 住所がすでに都道府県から始まってるなら二重にしない
  if (a.startsWith(p)) return a;
  return `${p}${a}`;
}

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const receiver_zip = digitsOnly(order.zip);
  const receiver_tel = digitsOnly(order.phone);

  const receiver_addr1 = normalizeReceiverAddr(order.pref, order.address);

  return {
    invoice_type: cod ? 2 : 0,                 // 代引き→2 / それ以外→0（あなたの運用に合わせてOK）
    cool_type: 0,
    customer_no: order.id != null ? String(order.id) : "", // ←ここに注文IDを入れるのが一番安全
    ship_date: shipDateStr(),

    receiver_tel,
    receiver_zip,
    receiver_addr1,
    receiver_addr2: "",
    receiver_name: order.name || "",
    receiver_kana: "",
    receiver_title: RECEIVER_TITLE,

    tel_branch: "",
    shipper_name: SHIPPER_NAME,
    shipper_tel: digitsOnly(SHIPPER_TEL),
    shipper_zip: digitsOnly(SHIPPER_ZIP),
    shipper_addr1: SHIPPER_ADDR1 || "",
    shipper_addr2: "",

    item_name_1: "手造りえびせんべい　磯屋",  // ←あなたの行に合わせるなら固定もOK
    item_name_2: buildItemName(order),         // ←ここにセット名など（例: 磯屋オリジナルセット）
    item_name_3: "",

    handling_1: "",
    handling_2: "",
    note: "",

    cod_amount: cod ? (order.total != null ? String(order.total) : "") : "",
    cod_tax: "",
    tail: "",
  };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const params = [];
  let where = "";
  if (STATUS_LIST.length) {
    params.push(STATUS_LIST);
    where = `WHERE status = ANY($1)`;
  }

  const sql = `
    SELECT
      id, status, payment_method,
      name, phone, zip, pref, address,
      items, total,
      created_at
    FROM orders
    ${where}
    ORDER BY created_at ASC
    LIMIT ${LIMIT}
  `;

  const res = await client.query(sql, params);

  const lines = res.rows.map((order) => {
    const dict = mapOrderToDict(order);
    return COLUMNS.map((k) => csvEscape(dict[k])).join(",");
  });

  let out = lines.join("\r\n");
  if (out && !out.endsWith("\r\n")) out += "\r\n";

  if (process.env.SHIFT_JIS === "1") {
    try {
      const iconv = require("iconv-lite");
      process.stdout.write(iconv.encode(out, "Shift_JIS"));
    } catch {
      process.stdout.write(out);
    }
  } else {
    process.stdout.write(out);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
