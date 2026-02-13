/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2（画像テンプレの列順に完全一致）CSV（ヘッダーなし / CRLF）
 *
 * ✅この版の目的
 * - あなたのテンプレ画像で見えている列順（A〜O）に 100% 合わせる
 * - 余計な列を出さない（ズレ＝赤地獄の原因を根絶）
 *
 * ✅テンプレ（画像）A〜Oの列順
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
 *   export SHIFT_JIS=1   # Excel/B2向け（推奨）
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
 *
 * 任意:
 *   export DELIVERY_TIME=""   # 0812/1416/1618/1820/1921 など。空は指定なし
 *   export COOL_TYPE=0        # 0:通常 1:冷凍 2:冷蔵（テンプレ記載の定義に従う）
 *   export RECEIVER_CODE=""   # 固定で入れたい時
 *   export SLIP_NO=""         # 伝票番号（通常は空でOK）
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
  if (v && v !== "today") return v; // "YYYY/MM/DD" を想定
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
  // 4703412 / 470-3412 / 470 3412 などを "470-3412" に寄せる
  const s = String(z).trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return s;
}

/**
 * 住所分割（超重要）
 * orders は pref と address を持っている前提
 * - pref: "愛知県"
 * - address: "知多郡南知多町豊浜字清水谷25-5" など
 *
 * テンプレは「都道府県」「市区郡町村」「町・番地」に分かれているので
 * address をざっくり先頭で切る（確実に通すための実用寄せ）
 */
function splitCityAndAddr(address) {
  const a = String(address || "").trim();
  if (!a) return { city: "", addr: "" };

  // よくある形: "○○市..." / "○○郡○○町..." / "○○区..." / "○○町..."
  // まず「市」「区」「郡」「町」「村」の最初の出現位置を探し、
  // そこから先の連続を市区郡町村として扱い、残りを町番地にする
  // 例: "知多郡南知多町豊浜字清水谷25-5"
  //      city = "知多郡南知多町"
  //      addr = "豊浜字清水谷25-5"
  const m = a.match(/^(.+?[市区郡])(.+)$/);
  if (m) {
    // m[1] が "知多郡" などで止まる場合があるので、後続を町村まで伸ばす
    const rest = m[2];
    const m2 = rest.match(/^(.+?[町村])(.+)$/);
    if (m2) {
      return { city: m[1] + m2[1], addr: m2[2].trim() };
    }
    // 町村が見つからないなら、区/市で分けて残りを addr
    return { city: m[1].trim(), addr: m[2].trim() };
  }

  // fallback: 分けられないなら全部を addr に入れる（赤を減らす目的）
  return { city: "", addr: a };
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

/**
 * ✅画像テンプレ（A〜O）に完全一致する列順
 */
const COLUMNS = [
  "customer_no",     // A お客様管理番号
  "invoice_type",    // B 送り状種類
  "cool_type",       // C クール区分
  "slip_no",         // D 伝票番号
  "ship_date",       // E 出荷予定日
  "delivery_date",   // F お届け予定日
  "delivery_time",   // G 配達時間帯
  "receiver_code",   // H お届け先コード
  "receiver_tel",    // I お届け先電話番号
  "receiver_tel2",   // J お届け先電話番号枝番
  "receiver_name",   // K お届け先名
  "receiver_zip",    // L お届け先郵便番号
  "receiver_pref",   // M 都道府県
  "receiver_city",   // N 市区郡町村
  "receiver_addr",   // O 町・番地
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = (order.pref || "").trim();
  const address = (order.address || "").trim();
  const { city, addr } = splitCityAndAddr(address);

  // 送り状種類（B列）
  // テンプレ注記: 0:発払い / 2:コレクト / 3:クロネコゆうメール ... 等
  // ここはカード(発払い=0) / 代引(コレクト=2) の最低限でまず100%通す
  const invoice_type = cod ? "2" : "0";

  return {
    customer_no: order.id != null ? String(order.id) : "",
    invoice_type,
    cool_type: COOL_TYPE || "0",
    slip_no: SLIP_NO, // 空でOK（B2で採番/付与する運用なら空）
    ship_date: shipDateStr(),
    delivery_date: "",               // 指定なしでOK
    delivery_time: DELIVERY_TIME,    // envで指定できる。空なら指定なし
    receiver_code: RECEIVER_CODE,    // 固定で入れたい時だけ

    receiver_tel: order.phone || "",
    receiver_tel2: "",
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

  // ✅必要最小限だけ SELECT（列ズレを防ぐ）
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
