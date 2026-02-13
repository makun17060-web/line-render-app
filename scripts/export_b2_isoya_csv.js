/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF）
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export SHIPPER_TEL="090-xxxx-xxxx"
 *   export SHIPPER_ZIP="123-4567"
 *   export SHIPPER_ADDR1="愛知県...（住所）"
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   node scripts/export_b2_isoya_csv.js > /tmp/isoya.csv
 *
 * 任意env:
 *   SHIP_DATE="today" or "2026/02/13"
 *   SHIFT_JIS=1
 *   SHIPPER_NAME="磯屋"
 *   RECEIVER_TITLE="様"
 *   COOL_TYPE=0   // 0:通常 / 1:冷蔵 / 2:冷凍（B2の設定に合わせて）
 *   ITEM_MAX=30   // 品名最大文字数（B2の項目制約に合わせる）
 *
 * 注意:
 * - 送り状種類（invoice_type）は B2仕様の数値が必要
 *   通常:0 / コレクト(代引):2
 * - CSVはヘッダーなし、CRLF
 */

"use strict";

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

const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim(); // 基本0
const ITEM_MAX = Math.max(10, Math.min(60, parseInt(process.env.ITEM_MAX || "30", 10)));

function pad2(n) { return String(n).padStart(2, "0"); }

function shipDateStr() {
  const v = String(process.env.SHIP_DATE || "today").trim();
  if (v && v !== "today") return v;
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function digitsOnly(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function normalizeZip(z) {
  const d = digitsOnly(z);
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return String(z || "").trim();
}

function normalizeTel(t) {
  // B2はハイフンありでも通ることが多いが、まず数字のみ→元が空なら空
  const d = digitsOnly(t);
  return d || "";
}

function isCodPayment(order) {
  const pm = String(order.payment_method || "").toLowerCase();
  return pm === "cod" || pm.includes("cod") || pm.includes("代引");
}

/**
 * 住所文字列から B2の「住所1」「住所2」にざっくり分割
 * - 住所1: 先頭から最大 16〜20 くらいに収まるのが理想だが、画面の列幅は環境差あり
 * - ここでは “長かったら後半を住所2へ” のシンプル分割
 */
function splitAddress(full, max1 = 20) {
  const s = String(full || "").trim();
  if (!s) return { a1: "", a2: "" };
  if (s.length <= max1) return { a1: s, a2: "" };
  return { a1: s.slice(0, max1), a2: s.slice(max1) };
}

function buildItemName(order) {
  let items = [];
  try {
    const obj = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    if (Array.isArray(obj)) items = obj;
  } catch {}

  const names = items
    .map((it) => {
      if (!it) return "";
      return (it.name || it.title || it.product_name || it.productName || "").trim();
    })
    .filter(Boolean);

  const s = names.length ? names.join(" / ") : "磯屋えびせん";
  return s.length > ITEM_MAX ? s.slice(0, ITEM_MAX) : s;
}

/**
 * 「磯屋発送」列順（あなたが使ってる順）
 * ※ ヘッダーは出さない（B2取り込み用）
 */
const COLUMNS = [
  "ship_date",
  "order_no",
  "invoice_type", // 送り状種類: 通常0 / コレクト2
  "cool_type",

  "receiver_code",
  "receiver_tel",
  "receiver_tel_branch",
  "receiver_name",
  "receiver_zip",
  "receiver_addr1",
  "receiver_addr2",
  "receiver_company1",
  "receiver_company2",
  "receiver_kana",
  "receiver_title",

  "shipper_code",
  "shipper_tel",
  "shipper_tel_branch",
  "shipper_name",
  "shipper_zip",
  "shipper_addr1",
  "shipper_addr2",
  "shipper_kana",

  "item_name_1",
  "item_code_2",
  "item_name_2",

  "handling_1",
  "handling_2",
  "note",

  "delivery_date",
  "delivery_time",

  "cod_amount",
  "cod_tax",

  "stop_flag",
  "office_code",
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  // ▼B2の「送り状種類」は数値コード必須
  //   通常:0 / コレクト:2
  const invoiceType = cod ? "2" : "0";

  const receiverFull = `${String(order.pref || "")}${String(order.address || "")}`.trim();
  const { a1, a2 } = splitAddress(receiverFull, 20);

  const receiverTel = normalizeTel(order.phone || "");
  const receiverZip = normalizeZip(order.zip || "");

  const receiverName = String(order.name || "").trim();

  const shipperTel = normalizeTel(SHIPPER_TEL);
  const shipperZip = normalizeZip(SHIPPER_ZIP);

  // 代引金額：B2の「コレクト代金引換額（税込）」に total を入れる
  // ※ ここは「代引注文だけ」必須
  const codAmount = cod ? (order.total != null ? String(order.total) : "") : "";

  return {
    ship_date: shipDateStr(),
    order_no: order.id != null ? String(order.id) : "",
    invoice_type: invoiceType,
    cool_type: String(COOL_TYPE || "0"),

    receiver_code: "",
    receiver_tel: receiverTel,
    receiver_tel_branch: "",
    receiver_name: receiverName,
    receiver_zip: receiverZip,
    receiver_addr1: a1,
    receiver_addr2: a2,

    receiver_company1: "",
    receiver_company2: "",
    receiver_kana: "",
    receiver_title: RECEIVER_TITLE,

    shipper_code: "",
    shipper_tel: shipperTel,
    shipper_tel_branch: "",
    shipper_name: SHIPPER_NAME,
    shipper_zip: shipperZip,
    shipper_addr1: String(SHIPPER_ADDR1 || "").trim(),
    shipper_addr2: "",
    shipper_kana: "",

    item_name_1: buildItemName(order),
    item_code_2: "",
    item_name_2: "",

    handling_1: "",
    handling_2: "",
    note: "",

    delivery_date: "",
    delivery_time: "",

    cod_amount: codAmount,
    cod_tax: "",

    stop_flag: "",
    office_code: "",
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
      id, user_id, status, payment_method,
      name, phone, zip, pref, address,
      items, total,
      created_at
    FROM orders
    ${where}
    ORDER BY created_at ASC
    LIMIT ${LIMIT}
  `;

  const res = await client.query(sql, params);

  const lines = (res.rows || []).map((order) => {
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
      // iconv-lite無い場合はUTF-8のまま出す
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
