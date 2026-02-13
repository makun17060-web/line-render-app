/**
 * scripts/export_b2_isoya_csv.js
 * Postgres → ヤマトB2「磯屋発送」完全一致CSV（最終版）
 *
 * 使い方:
 *   export DATABASE_URL="..."
 *   export STATUS_LIST="confirmed,paid,pickup"
 *   export LIMIT=200
 *
 *   export SHIPPER_NAME="磯屋"
 *   export SHIPPER_TEL="0569650955"
 *   export SHIPPER_ZIP="470-3412"
 *   export SHIPPER_PREF="愛知県"
 *   export SHIPPER_CITY="知多郡南知多町"
 *   export SHIPPER_ADDR="豊浜字清水谷25-5"
 *
 *   node scripts/export_b2_isoya_csv.js > /tmp/b2.csv
 */

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL required");
  process.exit(1);
}

const LIMIT = parseInt(process.env.LIMIT || "200", 10);
const STATUS_LIST = (process.env.STATUS_LIST || "confirmed,paid,pickup")
  .split(",").map(s => s.trim());

const SHIPPER_NAME = process.env.SHIPPER_NAME || "磯屋";
const SHIPPER_TEL = process.env.SHIPPER_TEL || "";
const SHIPPER_ZIP = process.env.SHIPPER_ZIP || "";
const SHIPPER_PREF = process.env.SHIPPER_PREF || "";
const SHIPPER_CITY = process.env.SHIPPER_CITY || "";
const SHIPPER_ADDR = process.env.SHIPPER_ADDR || "";

function pad2(n) { return String(n).padStart(2, "0"); }
function today() {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth()+1)}/${pad2(d.getDate())}`;
}

function normalizeZip(z) {
  if (!z) return "";
  const s = String(z);
  if (/^\d{7}$/.test(s)) return s.slice(0,3) + "-" + s.slice(3);
  return s;
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
  return s;
}

function isCod(order) {
  const pm = (order.payment_method || "").toLowerCase();
  return pm.includes("cod") || pm.includes("代引");
}

// 🔥 住所分割（最重要）
function splitAddress(pref, address) {
  const p = pref || "";
  let rest = (address || "").replace(p, "");

  const m =
    rest.match(/^(.+?郡.+?[町村])(.*)$/) ||
    rest.match(/^(.+?[市区町村])(.*)$/);

  if (m) {
    return {
      pref: p,
      city: m[1],
      addr: m[2],
    };
  }

  return { pref: p, city: "", addr: rest };
}

// 🔥 列順（完全一致）
const COLUMNS = [
  "invoice_type",
  "cool_type",
  "customer_no",
  "ship_date",

  "receiver_tel",
  "receiver_tel2",
  "receiver_name",
  "receiver_zip",
  "receiver_pref",
  "receiver_city",
  "receiver_addr",

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

function map(order) {
  const cod = isCod(order);
  const addr = splitAddress(order.pref, order.address);

  return {
    invoice_type: cod ? 2 : 0,
    cool_type: 0,
    customer_no: order.id,
    ship_date: today(),

    receiver_tel: order.phone || "",
    receiver_tel2: "",
    receiver_name: order.name || "",
    receiver_zip: normalizeZip(order.zip),
    receiver_pref: addr.pref,
    receiver_city: addr.city,
    receiver_addr: addr.addr,

    receiver_kana: "",
    receiver_title: "様",

    shipper_name: SHIPPER_NAME,
    shipper_tel: SHIPPER_TEL,
    shipper_zip: SHIPPER_ZIP,
    shipper_pref: SHIPPER_PREF,
    shipper_city: SHIPPER_CITY,
    shipper_addr: SHIPPER_ADDR,

    item_name_1: "手造りえびせんべい　磯屋",
    item_name_2: "磯屋オリジナルセット",

    note: "",
    cod_amount: cod ? order.total : "",
  };
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const res = await client.query(`
    SELECT id, status, payment_method,
           name, phone, zip, pref, address,
           items, total
    FROM orders
    WHERE status = ANY($1)
    ORDER BY created_at ASC
    LIMIT $2
  `, [STATUS_LIST, LIMIT]);

  const lines = res.rows.map(o => {
    const d = map(o);
    return COLUMNS.map(k => csvEscape(d[k])).join(",");
  });

  let out = lines.join("\r\n") + "\r\n";
  process.stdout.write(out);

  await client.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
