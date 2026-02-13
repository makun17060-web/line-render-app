/**
 * scripts/export_b2_isoya_csv.js
 * Postgres(orders) → ヤマトB2「磯屋発送」CSV（ヘッダーなし / CRLF / 100%通すための列順固定）
 *
 * ✅ 目的
 * - B2画面の「お届け先」：郵便番号/都道府県/市区郡町村/町・番地 を分割して入れる（ここがズレ原因だった）
 * - 代引きは 送り状種類=2（宅急便コレクト想定）+ 代引金額 を入れる
 * - CRLFで出力、必要なら Shift_JIS 出力も可能
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *   export SHIP_DATE="today" or "2026/02/13"
 *   export SHIFT_JIS=1            # 1ならShift_JIS出力（iconv-lite必要）
 *
 *   # ご依頼主（磯屋）
 *   export SHIPPER_NAME="磯屋"
 *   export SHIPPER_TEL="0569-65-0955"
 *   export SHIPPER_ZIP="470-3412"
 *   export SHIPPER_PREF="愛知県"
 *   export SHIPPER_CITY="知多郡南知多町"
 *   export SHIPPER_ADDR="豊浜字清水谷25-5"
 *
 *   # お届け先 敬称
 *   export RECEIVER_TITLE="様"
 *
 * 実行:
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
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
const SHIPPER_PREF = process.env.SHIPPER_PREF || "";
const SHIPPER_CITY = process.env.SHIPPER_CITY || "";
const SHIPPER_ADDR = process.env.SHIPPER_ADDR || "";

const RECEIVER_TITLE = process.env.RECEIVER_TITLE || "様";

function pad2(n) {
  return String(n).padStart(2, "0");
}
function shipDateStr() {
  const v = process.env.SHIP_DATE || "today";
  if (v !== "today") return v;
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function normalizeTel(s) {
  if (!s) return "";
  // B2はハイフンあり/なしどっちでも動くことが多いが、念のためそのまま（必要なら置換）
  return String(s).trim();
}
function normalizeZip(s) {
  if (!s) return "";
  const t = String(s).trim();
  // 1234567 -> 123-4567
  if (/^\d{7}$/.test(t)) return `${t.slice(0, 3)}-${t.slice(3)}`;
  return t;
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function isCodPayment(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引") || pm.includes("collect");
}

/**
 * 住所分割（都道府県/市区郡町村/町番地）
 * - order.pref がある前提（例: "愛知県"）
 * - order.address は「市区郡町村 + 町番地」想定でもOK
 * - prefが address に重複して入ってきても潰す
 */
function splitAddressJP(pref, address) {
  const p = (pref || "").trim();
  const a = (address || "").trim();

  // まず address の先頭に pref が入っていたら削る
  let rest = a;
  if (p && rest.startsWith(p)) rest = rest.slice(p.length).trim();

  // 市区郡町村で切る（知多郡/南知多町/豊浜… 等）
  // 「○○市」「○○区」「○○町」「○○村」「○○郡」までを city に寄せる
  // ただし 郡の場合は "○○郡○○町" みたいになるので、できるだけ長く取る
  // 例: "知多郡南知多町豊浜字清水谷25-5"
  //     city="知多郡南知多町" addr="豊浜字清水谷25-5"
  const m =
    rest.match(/^(.+?郡.+?[町村])(.*)$/) || // 〜郡〜町/村
    rest.match(/^(.+?[市区町村])(.*)$/);   // 〜市/区/町/村

  if (m) {
    return {
      pref: p,
      city: (m[1] || "").trim(),
      addr: (m[2] || "").trim(),
    };
  }

  return { pref: p, city: "", addr: rest };
}

function buildItemName(order) {
  let items = [];
  try {
    const obj = typeof order.items === "string" ? JSON.parse(order.items) : order.items;
    if (Array.isArray(obj)) items = obj;
  } catch {}

  const names = items
    .map((it) =>
      it && (it.name || it.title || it.product_name)
        ? (it.name || it.title || it.product_name)
        : ""
    )
    .filter(Boolean);

  const s = names.length ? names.join(" / ") : "磯屋えびせん";
  // B2の品名は長すぎると弾かれることがあるので短めに
  return s.length > 30 ? s.slice(0, 30) : s;
}

/**
 * ✅「完全一致の列順（確定版）」：あなたのB2画面に合わせるための最小・安定列
 * ※ B2側が要求する列だけを、順番固定で入れる（余計な列は出さない）
 *
 * 0:送り状種類
 * 1:クール区分
 * 2:お客様管理番号
 * 3:出荷予定日
 * 4:お届け先電話番号
 * 5:お届け先郵便番号
 * 6:お届け先都道府県
 * 7:お届け先市区郡町村
 * 8:お届け先町・番地
 * 9:お届け先名
 * 10:お届け先名(カナ)
 * 11:敬称
 * 12:ご依頼主名
 * 13:ご依頼主電話番号
 * 14:ご依頼主郵便番号
 * 15:ご依頼主都道府県
 * 16:ご依頼主市区郡町村
 * 17:ご依頼主町・番地
 * 18:品名1
 * 19:品名2
 * 20:備考
 * 21:代引金額
 */
const COLUMNS = [
  "invoice_type",
  "cool_type",
  "customer_no",
  "ship_date",

  "receiver_tel",
  "receiver_zip",
  "receiver_pref",
  "receiver_city",
  "receiver_addr",
  "receiver_name",
  "receiver_kana",
  "receiver_title",

  "shipper_name",
  "shipper_tel",
  "shipper_zip",
  "shipper_pref",
  "shipper_city",
  "shipper_addr",

  "item_name_1",
  "item_name_2",

  "note",
  "cod_amount",
];

function mapOrderToDict(order) {
  const cod = isCodPayment(order);

  const recvTel = normalizeTel(order.phone);
  const recvZip = normalizeZip(order.zip);
  const recvName = (order.name || "").trim();

  // order.pref は DBにある前提（例: "愛知県"）
  // order.address は「知多郡南知多町豊浜字清水谷25-5」みたいな想定
  const recvAddr = splitAddressJP(order.pref, order.address);

  // お客様管理番号（B2で検索に使いやすい）：order.id を入れる
  const customerNo = order.id != null ? String(order.id) : "";

  const dict = {
    // 送り状種類：代引=2（宅急便コレクト）/ 通常=0（通常宅急便）
    invoice_type: cod ? 2 : 0,

    // クール区分：0=なし（必要なら env で差し替え可能）
    cool_type: 0,

    customer_no: customerNo,
    ship_date: shipDateStr(),

    receiver_tel: recvTel,
    receiver_zip: recvZip,
    receiver_pref: recvAddr.pref,
    receiver_city: recvAddr.city,
    receiver_addr: recvAddr.addr,
    receiver_name: recvName,
    receiver_kana: "",
    receiver_title: RECEIVER_TITLE,

    shipper_name: SHIPPER_NAME,
    shipper_tel: normalizeTel(SHIPPER_TEL),
    shipper_zip: normalizeZip(SHIPPER_ZIP),
    shipper_pref: SHIPPER_PREF,
    shipper_city: SHIPPER_CITY,
    shipper_addr: SHIPPER_ADDR,

    // 品名
    item_name_1: "手造りえびせんべい　磯屋",
    item_name_2: buildItemName(order),

    note: "",

    // 代引金額：代引のみ total
    cod_amount: cod ? (order.total != null ? String(order.total) : "") : "",
  };

  // 空欄のままになるのが怖い必須系の最終保険（B2は都道府県空で弾くことが多い）
  if (!dict.receiver_pref && order.pref) dict.receiver_pref = order.pref;

  return dict;
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

  // ✅ address2 / kana など存在しない列は SELECT しない
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

  const lines = res.rows.map((order) => {
    const dict = mapOrderToDict(order);
    return COLUMNS.map((k) => csvEscape(dict[k])).join(",");
  });

  let out = lines.join("\r\n");
  if (out && !out.endsWith("\r\n")) out += "\r\n";

  if (process.env.SHIFT_JIS === "1") {
    try {
      const iconv = require("iconv-lite");
      process.stdout.write(iconv.encode(out, "Shift_JIS"));
    } catch {
      // iconv-lite無いならUTF-8のまま出す（最悪B2で開けることもある）
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
