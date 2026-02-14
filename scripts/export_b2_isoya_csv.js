/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF）
 *
 * ✅この版（安定版）の目的
 * - まず「出荷予定日ズレ」を確実に潰す（あなたのログで 286,0,0,,,2026/02/14… になっていた）
 * - 列順を固定： 286,0,0,,2026/02/14,... になる（0,0 の後の空欄は slip_no 1個だけ）
 * - 代引(COD)のときだけ「コレクト金額」を出力（カード等は空欄）
 * - SHIFT_JIS=1 でShift_JIS出力（Excel/B2向け）
 * - STATUS_LIST=""（空文字 or 空白）で status 絞り込み無しにできる
 * - ONLY_ID=286 のように単発検証できる
 *
 * ✅列数：17列（カンマ16個）
 *
 * ✅列順（これをB2レイアウトでこの順に紐付け）
 *  1 お客様管理番号
 *  2 送り状種類               (0:発払い / 2:コレクト)  ※JSがpayment_methodで判定
 *  3 クール区分               (固定 env COOL_TYPE, 既定 0)
 *  4 伝票番号                 (固定 env SLIP_NO, 既定 空)
 *  5 出荷予定日               (env SHIP_DATE or today)  ★ズレ潰し：ここを必ず5列目
 *  6 コレクト金額（代引金額） (代引のとき total+shipping_fee、それ以外は空)
 *  7 お届け予定日             (空)
 *  8 配達時間帯               (env DELIVERY_TIME or 空)
 *  9 お届け先コード           (env RECEIVER_CODE or 空)
 * 10 お届け先電話番号
 * 11 お届け先電話番号枝番     (空)
 * 12 お届け先名
 * 13 お届け先郵便番号
 * 14 都道府県
 * 15 市区郡町村
 * 16 町・番地
 * 17 建物名                   (DBになければ空)
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export STATUS_LIST="confirmed,paid,pickup"   # 未設定時の既定
 *   export LIMIT=200
 *   export SHIP_DATE="today" or "2026/02/14"
 *   export SHIFT_JIS=1        # 推奨
 *   node scripts/export_b2_isoya_csv.js > ./b2.csv
 *
 * 単発検証:
 *   STATUS_LIST=" " ONLY_ID=286 LIMIT=5 SHIFT_JIS=0 node scripts/export_b2_isoya_csv.js | cat -A
 *   → 期待: 286,0,0,,2026/02/14,<金額or空>,...
 *
 * 固定値:
 *   export COOL_TYPE=0
 *   export DELIVERY_TIME=""   # 0812/1416/1618/1820/1921 など。空は指定なし
 *   export RECEIVER_CODE=""   # お届け先コードを固定で入れたいとき
 *   export SLIP_NO=""         # 伝票番号（通常は空でOK）
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}

const LIMIT = parseInt(process.env.LIMIT || "200", 10);
const ONLY_ID = (process.env.ONLY_ID || "").trim();

// ✅ STATUS_LIST: 未設定なら既定 "confirmed,paid,pickup"
// ✅ 空文字/空白だけなら「絞り込み無し」
const STATUS_LIST_RAW =
  process.env.STATUS_LIST === undefined ? "confirmed,paid,pickup" : process.env.STATUS_LIST;

const STATUS_LIST = String(STATUS_LIST_RAW)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SHIFT_JIS = process.env.SHIFT_JIS === "1";

const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim(); // 0812/1416/...
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();   // 0/1/2
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
  return pm.includes("cod") || pm.includes("代引") || pm.includes("collect");
}

function toIntYen(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/**
 * 住所分割（pref + address から市区郡町村 / 番地を雑に切る）
 * - pref が address 先頭に入ってたら除去
 * - 最初に「市/区/郡/町/村」で切る（実用寄せ）
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
 * ✅B2に合わせた列順（17列）
 * ★重要：出荷予定日が 5列目になるように固定（あなたのズレ原因を根絶）
 */
const COLUMNS = [
  "customer_no",       // 1
  "invoice_type",      // 2
  "cool_type",         // 3
  "slip_no",           // 4
  "ship_date",         // 5 ★ここ
  "collect_amount",    // 6 ★代引のみ
  "delivery_date",     // 7
  "delivery_time",     // 8
  "receiver_code",     // 9
  "receiver_tel",      // 10
  "receiver_tel2",     // 11
  "receiver_name",     // 12
  "receiver_zip",      // 13
  "receiver_pref",     // 14
  "receiver_city",     // 15
  "receiver_addr",     // 16
  "receiver_building", // 17
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = String(order.pref || "").trim();
  const address = String(order.address || "").trim();

  // DBに分割列があるなら優先（無ければフォールバック）
  let city = String(order.addr_city || "").trim();
  let addr = String(order.addr_line1 || "").trim();

  if (!city || !addr) {
    const fb = splitCityAndAddr(pref, address);
    if (!city) city = fb.city;
    if (!addr) addr = fb.addr || address;
  }

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
    slip_no: SLIP_NO,          // 空でOK
    ship_date: shipDateStr(),  // ★必ずここで出す
    collect_amount,
    delivery_date: "",         // 指定なし
    delivery_time: DELIVERY_TIME,
    receiver_code: RECEIVER_CODE,

    receiver_tel: String(order.phone || "").trim(),
    receiver_tel2: "", // 枝番は空でOK（列は必須）
    receiver_name: String(order.name || "").trim(),
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: addr,
    receiver_building: "", // 建物名はDBになければ空（必要なら列追加で対応）
  };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const whereParts = [];
  const params = [];

  // ✅ ONLY_ID で絞る（検証用）
  if (ONLY_ID) {
    params.push(Number(ONLY_ID));
    whereParts.push(`id = $${params.length}`);
  }

  // ✅ status 絞り込み（空なら無し）
  if (STATUS_LIST.length) {
    params.push(STATUS_LIST);
    whereParts.push(`status = ANY($${params.length})`);
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  // ✅必要最小限 SELECT（列ズレ防止）
  const sql = `
    SELECT
      id, status, payment_method,
      name, phone, zip, pref, address,
      addr_city, addr_line1,
      total, shipping_fee,
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
