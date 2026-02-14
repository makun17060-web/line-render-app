/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF）
 *
 * ✅この版の確定仕様
 * - B2は「電話番号枝番を使っていない」前提（実画面ベース）
 * - 14列（カンマ13個）に固定
 * - addr_city / addr_line1 を最優先使用（ズレ防止）
 * - 未分割住所もフォールバックで落ちない
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

const SHIFT_JIS = process.env.SHIFT_JIS === "1";

const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim();
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();
const RECEIVER_CODE = (process.env.RECEIVER_CODE || "").trim();
const SLIP_NO = (process.env.SLIP_NO || "").trim();

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shipDateStr() {
  const v = (process.env.SHIP_DATE || "today").trim();
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

function normalizeZip(z) {
  if (!z) return "";
  const digits = String(z).replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return z;
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

/**
 * フォールバック住所分割
 */
function splitCityAndAddr(pref, address) {
  const p = String(pref || "").trim();
  let a = String(address || "").trim();
  if (!a) return { city: "", addr: "" };

  if (p && a.startsWith(p)) {
    a = a.slice(p.length).trim();
  }

  const m = a.match(/^(.+?(市|区|町|村))(.+)$/);
  if (m) {
    return {
      city: m[1].trim(),
      addr: m[3].trim(),
    };
  }

  return { city: "", addr: a };
}

/**
 * ✅14列（枝番なし）
 */
const COLUMNS = [
  "customer_no",
  "invoice_type",
  "cool_type",
  "slip_no",
  "ship_date",
  "delivery_date",
  "delivery_time",
  "receiver_code",
  "receiver_tel",
  "receiver_tel2",   // ←復活（これが超重要）
  "receiver_name",
  "receiver_zip",
  "receiver_pref",
  "receiver_city",
  "receiver_addr",
];


function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = (order.pref || "").trim();
  const address = (order.address || "").trim();

  let city = (order.addr_city || "").trim();
  let addr = (order.addr_line1 || "").trim();

  if (!city || !addr) {
    const fb = splitCityAndAddr(pref, address);
    if (!city) city = fb.city;
    if (!addr) addr = fb.addr || address;
  }

  return {
    customer_no: String(order.id || ""),
    invoice_type: cod ? "2" : "0",
    cool_type: COOL_TYPE || "0",
    slip_no: SLIP_NO,
    ship_date: shipDateStr(),
    delivery_date: "",
    delivery_time: DELIVERY_TIME,
    receiver_code: RECEIVER_CODE,

    receiver_tel: order.phone || "",
    receiver_name: order.name || "",
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: addr,
    receiver_tel2: "", // 空でOK（でも列は必須）

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
      id, payment_method,
      name, phone, zip, pref, address,
      addr_city, addr_line1,
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
  if (!out.endsWith("\r\n")) out += "\r\n";

  if (SHIFT_JIS) {
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
