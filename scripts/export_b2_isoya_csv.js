/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF）
 *
 * ✅安定版の目的
 * - ship_date を必ず5列目に固定
 * - 列順固定（16列）
 * - 代引(COD)のときだけ「コレクト金額 = total + shipping_fee」
 * - SHIFT_JIS=1 でShift_JIS出力（iconv-lite が入っていれば）
 * - STATUS_LIST="" or " " で status 絞り込み無し
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

// STATUS_LIST: 未設定なら既定 "confirmed,paid,pickup"
// 空文字/空白だけなら「絞り込み無し」
const STATUS_LIST_RAW =
  process.env.STATUS_LIST === undefined ? "confirmed,paid,pickup" : process.env.STATUS_LIST;

const STATUS_LIST = String(STATUS_LIST_RAW)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHIFT_JIS = process.env.SHIFT_JIS === "1";
const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim(); // 0812/1416/...
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();  // 0/1/2
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
  const digits = String(z).trim().replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return String(z).trim();
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

/**
 * 住所分割（pref + address から市区郡町村 / 番地を雑に切る）
 */
function splitCityAndAddr(pref, address) {
  const p = String(pref || "").trim();
  let a = String(address || "").trim();
  if (!a) return { city: "", addr: "" };

  if (p && a.startsWith(p)) a = a.slice(p.length).trim();

  // 例: 知多郡南知多町豊浜清水谷25-5 → city=知多郡南知多町, addr=豊浜清水谷25-5
  const m = a.match(/^(.+?(市|区|郡))(.+)$/);
  if (m) {
    const rest = m[3].trim();
    const m2 = rest.match(/^(.+?(町|村))(.+)$/);
    if (m2) return { city: (m[1] + m2[1]).trim(), addr: m2[3].trim() };
    return { city: m[1].trim(), addr: rest };
  }

  const m3 = a.match(/^(.+?(町|村))(.+)$/);
  if (m3) return { city: m3[1].trim(), addr: m3[3].trim() };

  return { city: "", addr: a };
}

/**
 * ✅B2に合わせた列順（16列）
 * ★重要：出荷予定日が 5列目
 */
const COLUMNS = [
  "customer_no",       // 1
  "invoice_type",      // 2 (0:発払い / 2:コレクト)
  "cool_type",         // 3
  "slip_no",           // 4
  "ship_date",         // 5 ★
  "collect_amount",    // 6 ★代引のみ total+shipping_fee
  "delivery_date",     // 7
  "delivery_time",     // 8
  "receiver_tel",      // 9
  "receiver_tel2",     // 10
  "receiver_name",     // 11
  "receiver_zip",      // 12
  "receiver_pref",     // 13
  "receiver_city",     // 14
  "receiver_addr",     // 15
  "receiver_building", // 16
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = String(order.pref || "").trim();
  const address = String(order.address || "").trim();

  const fb = splitCityAndAddr(pref, address);
  const city = fb.city;
  const addr = fb.addr || address;

  // 送り状種類（0:発払い / 2:コレクト）
  const invoice_type = cod ? "2" : "0";

  // ★コレクト金額：代引のときだけ total+shipping_fee
  const totalYen = toIntYen(order.total);
  const shipYen = toIntYen(order.shipping_fee);
  const collect_amount = cod ? String(Math.max(0, totalYen + shipYen)) : "";

  return {
    customer_no: order.id != null ? String(order.id) : "",
    invoice_type,
    cool_type: COOL_TYPE || "0",
    slip_no: SLIP_NO,
    ship_date: shipDateStr(),

    collect_amount,
    delivery_date: "",
    delivery_time: DELIVERY_TIME,

    receiver_tel: String(order.phone || "").trim(),
    receiver_tel2: "",
    receiver_name: String(order.name || "").trim(),
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: addr,
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
    } catch (e) {
      // iconv-lite が無い/失敗ならUTF-8で出す（B2に入れる前に要注意）
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
