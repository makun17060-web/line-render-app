/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF）
 * ✅テンプレが「電話番号枝番」無し(14列)の場合の版
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

const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim(); // 0812/1416/1618/1820/1921/空
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();   // "0" "1" "2"
const RECEIVER_CODE = (process.env.RECEIVER_CODE || "").trim();
const SLIP_NO = (process.env.SLIP_NO || "").trim();

function pad2(n) {
  return String(n).padStart(2, "0");
}

function shipDateStr() {
  const v = (process.env.SHIP_DATE || "today").trim();
  if (v && v !== "today") return v; // "YYYY/MM/DD"
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
  const s = String(z).trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return s;
}

function splitCityAndAddr(address) {
  const a = String(address || "").trim();
  if (!a) return { city: "", addr: "" };

  const m = a.match(/^(.+?[市区郡])(.+)$/);
  if (m) {
    const rest = m[2];
    const m2 = rest.match(/^(.+?[町村])(.+)$/);
    if (m2) return { city: m[1] + m2[1], addr: m2[2].trim() };
    return { city: m[1].trim(), addr: m[2].trim() };
  }
  return { city: "", addr: a };
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

/**
 * ✅テンプレ（14列）列順
 * A お客様管理番号
 * B 送り状種類
 * C クール区分
 * D 伝票番号
 * E 出荷予定日
 * F お届け予定日
 * G 配達時間帯
 * H お届け先コード
 * I お届け先電話番号
 * J お届け先名
 * K お届け先郵便番号
 * L 都道府県
 * M 市区郡町村
 * N 町・番地
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
  const { city, addr } = splitCityAndAddr(address);

  const invoice_type = cod ? "2" : "0";

  return {
    customer_no: order.id != null ? String(order.id) : "",
    invoice_type,
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
