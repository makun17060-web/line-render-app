/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2 CSV（ヘッダーなし / CRLF / Shift_JIS任意）
 *
 * ✅この「丸ごと版」の目的
 * - B2は「列名」じゃなく「列位置」で取り込むので、ズレ原因を100%潰す
 * - まず PROBE=1 で「B2側テンプレの本当の列順」を確定できる
 * - 通常時は orders の addr_city / addr_line1 を優先しつつ、未埋めはフォールバックで落ちない
 *
 * ✅使い方（ふだんのCSV）
 *   export DATABASE_URL="..."
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   export SHIP_DATE="today" or "2026/02/13"
 *   export SHIFT_JIS=1
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
 *
 * ✅使い方（列順確定用：探査CSV）
 *   SHIFT_JIS=1 PROBE=1 node scripts/export_b2_isoya_csv.js > /tmp/probe.csv
 *   → B2に取り込むと各セルに "__A_customer_no__" みたいな文字が入る
 *   → その結果のスクショを見れば「B2の列順」が確定し、ズレが終わる
 *
 * 任意:
 *   export DELIVERY_TIME=""    # 0812/1416/1618/1820/1921 など。空は指定なし
 *   export COOL_TYPE=0         # 0:通常 1:冷凍 2:冷蔵
 *   export RECEIVER_CODE=""    # 固定で入れたい時
 *   export SLIP_NO=""          # 伝票番号（通常空でOK）
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const PROBE = process.env.PROBE === "1";
const SHIFT_JIS = process.env.SHIFT_JIS === "1";

const LIMIT = parseInt(process.env.LIMIT || "200", 10);
const STATUS_LIST = (process.env.STATUS_LIST || "confirmed,paid,pickup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DELIVERY_TIME = (process.env.DELIVERY_TIME || "").trim();
const COOL_TYPE = String(process.env.COOL_TYPE ?? "0").trim();
const RECEIVER_CODE = (process.env.RECEIVER_CODE || "").trim();
const SLIP_NO = (process.env.SLIP_NO || "").trim();

if (!PROBE && !DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required (unless PROBE=1)");
  process.exit(1);
}

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
 * フォールバック住所分割（DBに addr_city/addr_line1 が無い/空の時だけ使う）
 * - pref が address 先頭に付いてたら除去してから分割
 * - 市/区/町/村 で city を確定
 */
function splitCityAndAddrFallback(pref, address) {
  const p = String(pref || "").trim();
  let a = String(address || "").trim();
  if (!a) return { city: "", line1: "" };

  if (p && a.startsWith(p)) a = a.slice(p.length).trim();

  const m = a.match(/^(.+?(市|区|町|村))(.+)$/);
  if (m) {
    return { city: (m[1] || "").trim(), line1: (m[3] || "").trim() };
  }
  return { city: "", line1: a };
}

/**
 * ✅ここが “列順” の心臓部
 * いまは「あなたが想定しているB2テンプレ(A〜O / 15列 / 枝番あり)」の並びで置いてある。
 *
 * もしB2側テンプレの実列順が違うなら、
 * 1) PROBE=1 で探査CSVを取り込む
 * 2) B2画面で各列に入った "__X_key__" を見て
 * 3) ここ(COLUMNS)の並びを B2の実順に並べ替える
 *
 * それで100%ズレが消える。
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
  "receiver_tel2",   // J お届け先電話番号枝番（★ある前提）
  "receiver_name",   // K お届け先名
  "receiver_zip",    // L お届け先郵便番号
  "receiver_pref",   // M 都道府県
  "receiver_city",   // N 市区郡町村
  "receiver_addr",   // O 町・番地
];

function probeValue(key, idx) {
  const col = String.fromCharCode("A".charCodeAt(0) + idx);
  return `__${col}_${key}__`;
}

function encodeAndWrite(out) {
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
}

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const pref = String(order.pref || "").trim();
  const address = String(order.address || "").trim();

  // DB列優先（安定）
  let city = String(order.addr_city || "").trim();
  let line1 = String(order.addr_line1 || "").trim();

  // 未埋めはフォールバック（落ちないため）
  if (!city || !line1) {
    const fb = splitCityAndAddrFallback(pref, address);
    if (!city) city = fb.city;
    if (!line1) line1 = fb.line1 || address;
  }

  return {
    customer_no: order.id != null ? String(order.id) : "",
    invoice_type: cod ? "2" : "0",
    cool_type: COOL_TYPE || "0",
    slip_no: SLIP_NO,
    ship_date: shipDateStr(),
    delivery_date: "",
    delivery_time: DELIVERY_TIME,
    receiver_code: RECEIVER_CODE,

    receiver_tel: String(order.phone || "").trim(),
    receiver_tel2: "", // 枝番は空でOK。ただし列は必ず出す

    receiver_name: String(order.name || "").trim(),
    receiver_zip: normalizeZip(order.zip),

    receiver_pref: pref,
    receiver_city: city,
    receiver_addr: line1,
  };
}

async function main() {
  // ✅探査モード：DB不要で「列順確定」できる1行CSVを出す
  if (PROBE) {
    const dict = {};
    COLUMNS.forEach((k, i) => (dict[k] = probeValue(k, i)));
    const line = COLUMNS.map((k) => csvEscape(dict[k])).join(",");
    encodeAndWrite(line + "\r\n");
    return;
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const params = [];
  let where = "";
  if (STATUS_LIST.length) {
    params.push(STATUS_LIST);
    where = `WHERE status = ANY($1)`;
  }

  // ✅DB列 addr_city / addr_line1 を読む（ALTER済み前提）
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

  encodeAndWrite(out);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
