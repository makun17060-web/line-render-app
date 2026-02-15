/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF）
 *
 * ✅仕様（確定版）
 * - 列数：16列（B2基本レイアウト）
 * - 5列目：出荷予定日（固定）
 * - 6列目：コレクト金額 = DB total（商品＋送料）※代引のみ
 * - SHIFT_JIS=1 でShift_JIS出力
 * - STATUS_LIST="" or " " で全件対象
 * - ONLY_ID=284 で単発検証
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const LIMIT = parseInt(process.env.LIMIT || "200", 10);
const ONLY_ID = (process.env.ONLY_ID || "").trim();

const STATUS_LIST_RAW =
  process.env.STATUS_LIST === undefined ? "confirmed,paid,pickup" : process.env.STATUS_LIST;

const STATUS_LIST = String(STATUS_LIST_RAW)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHIFT_JIS = process.env.SHIFT_JIS === "1";
const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim();
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();
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
  const pm = String(order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引") || pm.includes("collect");
}

function toIntYen(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

// 住所分割
function splitCityAndAddr(pref, address) {
  const p = String(pref || "").trim();
  let a = String(address || "").trim();

  if (p && a.startsWith(p)) {
    a = a.slice(p.length).trim();
  }

  const m = a.match(/^(.+?(市|区|郡))(.+)$/);
  if (m) {
    const rest = m[3].trim();
    const m2 = rest.match(/^(.+?(町|村))(.+)$/);
    if (m2) {
      return { city: (m[1] + m2[1]).trim(), addr: m2[3].trim() };
    }
    return { city: m[1].trim(), addr: rest };
  }

  const m3 = a.match(/^(.+?(町|村))(.+)$/);
  if (m3) return { city: m3[1].trim(), addr: m3[3].trim() };

  return { city: "", addr: a };
}

// 16列固定
const COLUMNS = [
  "customer_no",
  "invoice_type",
  "cool_type",
  "slip_no",
  "ship_date",
  "collect_amount",
  "delivery_date",
  "delivery_time",
  "receiver_tel",
  "receiver_tel2",
  "receiver_name",
  "receiver_zip",
  "receiver_pref",
  "receiver_city",
  "receiver_addr",
  "receiver_building",
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = String(order.pref || "").trim();
  const address = String(order.address || "").trim();

  const { city, addr } = splitCityAndAddr(pref, address);

  // ★ここが最重要（DB totalそのまま）
  const totalYen = toIntYen(order.total);
  const collect_amount = cod ? String(Math.max(0, totalYen)) : "";

  return {
    customer_no: String(order.id || ""),
    invoice_type: cod ? "2" : "0",
    cool_type: COOL_TYPE,
    slip_no: SLIP_NO,
    ship_date: shipDateStr(),

    collect_amount,
    delivery_date: "",
    delivery_time: DELIVERY_TIME,

    receiver_tel: String(order.phone || ""),
    receiver_tel2: "",
    receiver_name: String(order.name || ""),
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: addr || address,
    receiver_building: "",
  };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const whereParts = [];
  const params = [];

  if (ONLY_ID) {
    params.push(Number(ONLY_ID));
    whereParts.push(`id = $${params.length}`);
  }

  if (STATUS_LIST.length) {
    params.push(STATUS_LIST);
    whereParts.push(`status = ANY($${params.length})`);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  const sql = `
    SELECT
      id, status, payment_method,
      name, phone, zip, pref, address,
      total, shipping_fee,
      created_at
    FROM orders
    ${where}
    ORDER BY created_at DESC
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
