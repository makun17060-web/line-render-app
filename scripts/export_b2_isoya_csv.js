/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF）
 *
 * 使い方:
 *   DATABASE_URL=... \
 *   SHIPPER_TEL=... SHIPPER_ZIP=... SHIPPER_ADDR1="..." \
 *   node scripts/export_b2_isoya_csv.js > /tmp/isoya.csv
 *
 * 任意env:
 *   LIMIT=200
 *   STATUS_LIST="confirmed,paid,pickup"   // 対象ステータス
 *   SHIP_DATE="today" or "2026/02/13"    // 出荷予定日
 *   SHIFT_JIS=1                          // iconv-lite が入っていればSJIS出力
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
  .map(s => s.trim())
  .filter(Boolean);

const SHIPPER_TEL = process.env.SHIPPER_TEL || "";
const SHIPPER_ZIP = process.env.SHIPPER_ZIP || "";
const SHIPPER_ADDR1 = process.env.SHIPPER_ADDR1 || "";
const SHIPPER_NAME = process.env.SHIPPER_NAME || "磯屋";

function pad2(n) { return String(n).padStart(2, "0"); }
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

function parseItems(items) {
  try {
    const obj = typeof items === "string" ? JSON.parse(items) : items;
    return Array.isArray(obj) ? obj : [];
  } catch {
    return [];
  }
}

/** 品名：長すぎると弾かれやすいので短くまとめる */
function buildItemName(order) {
  const items = parseItems(order.items);
  const names = items
    .map(it => it?.name || it?.title || it?.product_name || "")
    .filter(Boolean);

  const s = names.length ? names.join(" / ") : "磯屋えびせん";
  // ざっくり30文字目安に切る（必要なら調整）
  return s.length > 30 ? s.slice(0, 30) : s;
}

/** 代引金額：代引きだけ total を入れる（カードは空） */
function buildCodAmount(order) {
  const pm = (order.payment_method || "").toLowerCase();
  const isCod = pm.includes("cod") || pm.includes("代引");
  return isCod ? (order.total ?? "") : "";
}

/** 送り状種類：代引き=2、それ以外=0（発払い） */
function buildInvoiceType(order) {
  const pm = (order.payment_method || "").toLowerCase();
  const isCod = pm.includes("cod") || pm.includes("代引");
  return isCod ? 2 : 0;
}

/**
 * ★ここが「磯屋発送」列順
 * 画像で確認できた範囲に合わせて並べています。
 * B2側でこの後ろに「品名」「代引金額」などの項目が “存在する” 場合は、
 * B2画面の項目名の順にこの配列の末尾へ追加してください。
 */
const COLUMNS = [
  // ---- 基本（あなたの画面で見えてた）----
  "ship_date",              // 出荷予定日
  "order_no",               // お客様管理番号
  "invoice_type",           // 送り状種類
  "cool_type",              // クール区分

  // ---- お届け先 ----
  "receiver_code",          // お届け先コード
  "receiver_tel",           // お届け先電話番号
  "receiver_tel_branch",    // お届け先電話番号枝番
  "receiver_name",          // お届け先名
  "receiver_zip",           // お届け先郵便番号
  "receiver_addr1",         // お届け先住所
  "receiver_addr2",         // お届け先建物名
  "receiver_company1",      // お届け先会社・部門1
  "receiver_company2",      // お届け先会社・部門2
  "receiver_kana",          // お届け先名略称カナ
  "receiver_title",         // 敬称

  // ---- ご依頼主 ----
  "shipper_code",           // ご依頼主コード
  "shipper_tel",            // ご依頼主電話番号
  "shipper_tel_branch",     // ご依頼主電話番号枝番
  "shipper_name",           // ご依頼主名
  "shipper_zip",            // ご依頼主郵便番号
  "shipper_addr1",          // ご依頼主住所
  "shipper_addr2",          // ご依頼主建物名
  "shipper_kana",           // ご依頼主名略称カナ

  // ---- 追加（品名/代引金額）----
  // ※B2「磯屋発送」のレイアウト項目一覧で、ここに相当項目がある場合に効きます。
  "item_name",              // 品名
  "cod_amount",             // 代引金額
];

function mapOrderToDict(order) {
  // 住所：pref と address が分かれている前提（あなたのorders構造）
  const receiver_addr1 = `${order.pref || ""}${order.address || ""}`;

  return {
    ship_date: shipDateStr(),
    order_no: order.id ?? "",

    invoice_type: buildInvoiceType(order),
    cool_type: 0,

    receiver_code: "",
    receiver_tel: order.phone ?? "",
    receiver_tel_branch: "",
    receiver_name: order.name ?? "",
    receiver_zip: order.zip ?? "",
    receiver_addr1,
    receiver_addr2: "",

    receiver_company1: "",
    receiver_company2: "",
    receiver_kana: "",
    receiver_title: "様",

    shipper_code: "",
    shipper_tel: SHIPPER_TEL,
    shipper_tel_branch: "",
    shipper_name: SHIPPER_NAME,
    shipper_zip: SHIPPER_ZIP,
    shipper_addr1: SHIPPER_ADDR1,
    shipper_addr2: "",
    shipper_kana: "",

    item_name: buildItemName(order),
    cod_amount: buildCodAmount(order),
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

  // あなたの orders から必要列だけ取る
  const sql = `
    SELECT id, name, phone, zip, pref, address, items, total, payment_method, status, created_at
    FROM orders
    ${where}
    ORDER BY created_at ASC
    LIMIT ${LIMIT}
  `;

  const res = await client.query(sql, params);

  const lines = res.rows.map(order => {
    const dict = mapOrderToDict(order);
    return COLUMNS.map(k => csvEscape(dict[k])).join(",");
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
      // iconv-lite が無ければUTF-8のまま
      process.stdout.write(out);
    }
  } else {
    process.stdout.write(out);
  }

  await client.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
