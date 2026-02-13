/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF / 列順固定）
 *
 * ✅この版の狙い（いまの結論）
 * - 住所分割はDB列（addr_city / addr_line1）を最優先で使う（=安定）
 * - 15列テンプレ（電話番号枝番あり）に固定（カンマ数14個）
 * - addr_city / addr_line1 が未埋めでも “落ちない” フォールバック付き
 *
 * ✅B2テンプレ（15列）A〜O
 * A お客様管理番号
 * B 送り状種類
 * C クール区分
 * D 伝票番号
 * E 出荷予定日
 * F お届け予定日
 * G 配達時間帯
 * H お届け先コード
 * I お届け先電話番号
 * J お届け先電話番号枝番
 * K お届け先名
 * L お届け先郵便番号
 * M 都道府県
 * N 市区郡町村
 * O 町・番地
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   export SHIP_DATE="today" or "2026/02/13"
 *   export SHIFT_JIS=1
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
 *
 * 任意:
 *   export DELIVERY_TIME=""    # 0812/1416/1618/1820/1921 など。空は指定なし
 *   export COOL_TYPE=0         # 0:通常 1:冷凍 2:冷蔵
 *   export RECEIVER_CODE=""    # 固定で入れたい時
 *   export SLIP_NO=""          # 伝票番号（通常空でOK）
 *
 * 🔎 チェック:
 * - 1行のカンマ数 = 14個（=15列）
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

const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim(); // 0812/1416/...
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
  const digits = String(z).trim().replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return String(z).trim();
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

/**
 * 住所分割（フォールバック用）
 * ※本命はDB列 addr_city / addr_line1
 */
function splitCityAndAddrFallback(pref, address) {
  const p = String(pref || "").trim();
  let a = String(address || "").trim();
  if (!a) return { city: "", line1: "" };

  // addressが "愛知県..." のように都道府県入りなら除去
  if (p && a.startsWith(p)) a = a.slice(p.length).trim();

  // 市区郡町村を「市/区/町/村」で確定
  const m = a.match(/^(.+?(市|区|町|村))(.+)$/);
  if (m) {
    return { city: (m[1] || "").trim(), line1: (m[3] || "").trim() };
  }

  // 分けられなければ全部を町番地へ（B2赤を減らす）
  return { city: "", line1: a };
}

/**
 * ✅15列（枝番あり）固定
 */
const COLUMNS = [
  "customer_no",     // A
  "invoice_type",    // B
  "cool_type",       // C
  "slip_no",         // D
  "ship_date",       // E
  "delivery_date",   // F
  "delivery_time",   // G
  "receiver_code",   // H
  "receiver_tel",    // I
  "receiver_tel2",   // J
  "receiver_name",   // K
  "receiver_zip",    // L
  "receiver_pref",   // M
  "receiver_city",   // N
  "receiver_addr",   // O
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = String(order.pref || "").trim();
  const address = String(order.address || "").trim();

  // ✅DB列優先
  let city = String(order.addr_city || "").trim();
  let line1 = String(order.addr_line1 || "").trim();

  // DB未埋めの時だけフォールバック
  if (!city || !line1) {
    const fb = splitCityAndAddrFallback(pref, address);
    if (!city) city = fb.city;
    if (!line1) line1 = fb.line1 || address;
  }

  // 送り状種類: 0=発払い / 2=コレクト（代引）
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

    receiver_tel: String(order.phone || "").trim(),
    receiver_tel2: "", // ★枝番は空でOK（列は必ず出す）
    receiver_name: String(order.name || "").trim(),
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: line1,
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

  // ✅DB列 addr_city / addr_line1 を使う
  // ※存在しない環境だとここで落ちるので、既に ALTER 済み前提
  const sql = `
    SELECT
      id, status, payment_method,
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
