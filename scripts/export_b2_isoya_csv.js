/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF）
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export SHIPPER_TEL="090-xxxx-xxxx"
 *   export SHIPPER_ZIP="123-4567"
 *   export SHIPPER_ADDR1="愛知県..."
 *   export SHIPPER_NAME="磯屋"
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   # 任意:
 *   export SHIP_DATE="today"   # or "2026/02/13"
 *   export SHIFT_JIS=1         # 1でShift_JIS出力（PAD/B2向け）
 *   export RECEIVER_TITLE="様"
 *   export OUTPUT_HEADER=0     # 1にすると“確認用に”ヘッダー行も出す（B2投入時は0）
 *
 *   node scripts/export_b2_isoya_csv.js > /tmp/isoya.csv
 *
 * ✅重要:
 * - 「磯屋発送」画面の列順に完全一致させた配列 COLUMNS を使う
 * - 値は dict で持ち、COLUMNS 順に出す（ズレない）
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
const SHIPPER_ADDR2 = process.env.SHIPPER_ADDR2 || ""; // 任意（建物名など）
const RECEIVER_TITLE = process.env.RECEIVER_TITLE || "様";
const OUTPUT_HEADER = process.env.OUTPUT_HEADER === "1";

function pad2(n) {
  return String(n).padStart(2, "0");
}
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
  // 品名は長すぎるとB2で弾かれることがあるので保守的に30文字
  return s.length > 30 ? s.slice(0, 30) : s;
}

/**
 * ===========================
 * ここが「100%通る」肝：列順
 * ===========================
 * 画像のB2「磯屋発送」画面タブ構成に合わせて
 * 1) 基本情報
 * 2) お届け先
 * 3) ご依頼主
 * 4) 品名
 * 5) その他
 *
 * ※B2側で“磯屋発送”のレイアウトを変更したら、ここも同じ順に変える。
 */
const COLUMNS = [
  // --- 基本情報（あなたの画面：送り状種類/クール区分/お客様管理番号/出荷予定日） ---
  "invoice_type",     // 送り状種類：通常=0 / コレクト=2
  "cool_type",        // クール区分：0=なし（必要なら env で切替可にしてもOK）
  "customer_no",      // お客様管理番号（注文IDなど）
  "ship_date",        // 出荷予定日（YYYY/MM/DD）

  // --- お届け先 ---
  "receiver_tel",
  "receiver_zip",
  "receiver_addr1",
  "receiver_addr2",
  "receiver_name",
  "receiver_kana",
  "receiver_title",
  "receiver_company1",
  "receiver_company2",

  // --- ご依頼主 ---
  "shipper_tel",
  "shipper_zip",
  "shipper_addr1",
  "shipper_addr2",
  "shipper_name",
  "shipper_kana",

  // --- 品名 ---
  "item_name_1",
  "item_name_2",

  // --- その他 ---
  "delivery_date",
  "delivery_time",
  "cod_amount",
  "cod_tax",
  "note",
];

/**
 * B2「磯屋発送」へ入れる値を dict 化（列ズレしない）
 */
function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  // お届け先住所：pref + address を 1行に寄せる（あなたのDB構造に合わせる）
  const receiver_addr1 = `${order.pref || ""}${order.address || ""}`;

  return {
    // 基本情報
    invoice_type: cod ? 2 : 0,             // ✅ 0/2 だけ
    cool_type: 0,
    customer_no: order.id != null ? String(order.id) : "",
    ship_date: shipDateStr(),

    // お届け先
    receiver_tel: order.phone || "",
    receiver_zip: order.zip || "",
    receiver_addr1,
    receiver_addr2: "",                    // address2がDBに無いので空
    receiver_name: order.name || "",
    receiver_kana: "",                     // kanaが無いので空
    receiver_title: RECEIVER_TITLE,
    receiver_company1: "",
    receiver_company2: "",

    // ご依頼主
    shipper_tel: SHIPPER_TEL,
    shipper_zip: SHIPPER_ZIP,
    shipper_addr1: SHIPPER_ADDR1,
    shipper_addr2: SHIPPER_ADDR2,
    shipper_name: SHIPPER_NAME,
    shipper_kana: "",

    // 品名
    item_name_1: buildItemName(order),
    item_name_2: "",

    // その他
    delivery_date: "",
    delivery_time: "",
    cod_amount: cod ? (order.total != null ? String(order.total) : "") : "",
    cod_tax: "",
    note: "",
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

  // 必要列だけ
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

  // 確認用にヘッダーを付けたい時だけ（B2投入時は必ずOFF）
  const lines = [];
  if (OUTPUT_HEADER) {
    lines.push(COLUMNS.map(csvEscape).join(","));
  }

  for (const order of res.rows) {
    const dict = mapOrderToDict(order);
    const row = COLUMNS.map((k) => csvEscape(dict[k]));
    lines.push(row.join(","));
  }

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
