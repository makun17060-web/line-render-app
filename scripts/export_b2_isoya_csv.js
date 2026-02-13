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

/**
 * 「磯屋発送」列順（B2画面で確認した順）
 */
const COLUMNS = [
  "ship_date",
  "order_no",
  "invoice_type",
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
  const receiver_addr1 = `${order.pref || ""}${order.address || ""}`;

  return {
    ship_date: shipDateStr(),
    order_no: order.id != null ? order.id : "",
    invoice_type: cod ? 2 : 0,
    cool_type: 0,

    receiver_code: "",
    receiver_tel: order.phone || "",
    receiver_tel_branch: "",
    receiver_name: order.name || "",
    receiver_zip: order.zip || "",
    receiver_addr1,
    receiver_addr2: "",          // address2列が無いので常に空

    receiver_company1: "",
    receiver_company2: "",
    receiver_kana: "",           // kana列が無いので空
    receiver_title: RECEIVER_TITLE,

    shipper_code: "",
    shipper_tel: SHIPPER_TEL,
    shipper_tel_branch: "",
    shipper_name: SHIPPER_NAME,
    shipper_zip: SHIPPER_ZIP,
    shipper_addr1: SHIPPER_ADDR1,
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

    cod_amount: cod ? (order.total != null ? order.total : "") : "",
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

  // address2 / kana を SELECT しない（存在しないため）
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
