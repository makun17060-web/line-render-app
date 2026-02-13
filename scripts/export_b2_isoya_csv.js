/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF）
 *
 * 使い方（例）:
 *   DATABASE_URL=... \
 *   SHIPPER_TEL="090-xxxx-xxxx" SHIPPER_ZIP="123-4567" SHIPPER_ADDR1="愛知県..." \
 *   node scripts/export_b2_isoya_csv.js > /tmp/isoya.csv
 *
 * 任意env:
 *   LIMIT=200
 *   STATUS_LIST="confirmed,paid,pickup"    // 対象ステータス
 *   SHIP_DATE="today" or "2026/02/13"     // 出荷予定日
 *   SHIFT_JIS=1                           // iconv-lite があればSJIS出力
 *   SHIPPER_NAME="磯屋"
 *   RECEIVER_TITLE="様"                   // 敬称
 */

import pkg from "pg";
const { Client } = pkg;

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

function pad2(n) {
  return String(n).padStart(2, "0");
}
function shipDateStr() {
  const v = process.env.SHIP_DATE || "today";
  if (v !== "today") return v; // "YYYY/MM/DD"
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

/** items から品名を作る（長すぎると弾かれやすいので短め） */
function buildItemName(order) {
  let items = [];
  try {
    const obj = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    if (Array.isArray(obj)) items = obj;
  } catch {}

  const names = items
    .map((it) => it?.name || it?.title || it?.product_name || "")
    .filter(Boolean);

  const s = names.length ? names.join(" / ") : "磯屋えびせん";
  return s.length > 30 ? s.slice(0, 30) : s;
}

/**
 * 「磯屋発送」列順（あなたの画面で確認できた項目の順番）
 * ※ヘッダーなしで、この順番通りに値を並べます
 */
const COLUMNS = [
  // --- 基本 ---
  "ship_date", // 出荷予定日
  "order_no", // お客様管理番号
  "invoice_type", // 送り状種類（0:発払い / 2:代引き）
  "cool_type", // クール区分（0:常温）

  // --- お届け先 ---
  "receiver_code", // お届け先コード
  "receiver_tel", // お届け先電話番号
  "receiver_tel_branch", // お届け先電話番号枝番
  "receiver_name", // お届け先名
  "receiver_zip", // お届け先郵便番号
  "receiver_addr1", // お届け先住所
  "receiver_addr2", // お届け先建物名（アパートマンション名）
  "receiver_company1", // お届け先会社・部門1
  "receiver_company2", // お届け先会社・部門2
  "receiver_kana", // お届け先名略称カナ
  "receiver_title", // 敬称

  // --- ご依頼主（磯屋）---
  "shipper_code", // ご依頼主コード
  "shipper_tel", // ご依頼主電話番号
  "shipper_tel_branch", // ご依頼主電話番号枝番
  "shipper_name", // ご依頼主名
  "shipper_zip", // ご依頼主郵便番号
  "shipper_addr1", // ご依頼主住所
  "shipper_addr2", // ご依頼主建物名（アパートマンション名）
  "shipper_kana", // ご依頼主名略称カナ

  // --- 品名 ---
  "item_name_1", // 品名1
  "item_code_2", // 品名コード2（使わないなら空）
  "item_name_2", // 品名2（使わないなら空）

  // --- 取扱い・記事 ---
  "handling_1", // 荷扱い1
  "handling_2", // 荷扱い2
  "note", // 記事

  // --- 日付・時間 ---
  "delivery_date", // お届け予定（指定）日
  "delivery_time", // 配達時間帯区分

  // --- 代引 ---
  "cod_amount", // コレクト代金引換額（税込）
  "cod_tax", // コレクト内消費税額等

  // --- その他 ---
  "stop_flag", // 営業所止置き
  "office_code", // 営業所コード
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  // 住所：あなたの orders が pref + address 形式なので合成
  const receiver_addr1 = `${order.pref || ""}${order.address || ""}`;

  return {
    ship_date: shipDateStr(),
    order_no: order.id ?? "",
    invoice_type: cod ? 2 : 0,
    cool_type: 0,

    receiver_code: "",
    receiver_tel: order.phone ?? "",
    receiver_tel_branch: "",
    receiver_name: order.name ?? "",
    receiver_zip: order.zip ?? "",
    receiver_addr1,
    receiver_addr2: order.address2 ?? "",

    receiver_company1: "",
    receiver_company2: "",
    receiver_kana: order.kana ?? "",
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

    cod_amount: cod ? (order.total ?? "") : "",
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

  // orders の列はあなたの現状に合わせた（必要なら SELECT/列名は調整）
  const sql = `
    SELECT
      id, user_id, status, payment_method,
      name, kana, phone, zip, pref, address, address2,
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

  // ヘッダーなし、CRLF
  let out = lines.join("\r\n");
  if (out && !out.endsWith("\r\n")) out += "\r\n";

  // SJISが必要なら（iconv-lite が入っている時だけ）
  if (process.env.SHIFT_JIS === "1") {
    try {
      const iconv = await import("iconv-lite");
      const buf = iconv.default.encode(out, "Shift_JIS");
      process.stdout.write(buf);
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
