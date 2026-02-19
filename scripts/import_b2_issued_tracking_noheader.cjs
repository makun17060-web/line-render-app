/**
 * scripts/import_b2_issued_tracking_noheader.cjs
 * ヤマトB2 発行済データCSV（ヘッダー無し）から
 * 1列目=お客様管理番号（orders.id想定）, 4列目=伝票番号 を取り出して tracking_no 更新
 *
 * 使い方:
 *   DRY_RUN=1 CSV_PATH=C:\temp\b2\result.csv node scripts/import_b2_issued_tracking_noheader.cjs
 *   DRY_RUN=0 CSV_PATH=C:\temp\b2\result.csv node scripts/import_b2_issued_tracking_noheader.cjs
 */

const fs = require("fs");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");
const pg = require("pg");
const { Client } = pg;

const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const CSV_PATH = process.env.CSV_PATH ?? "C:\\temp\\b2\\result.csv";

// ヘッダー無しの列位置（0始まり）
const COL_ORDER_ID = 0; // お客様管理番号
const COL_TRACKING = 3; // 伝票番号

function digitsOnly(s) {
  return String(s ?? "").replace(/[^\d]/g, "");
}

function readFileSmart(p) {
  const buf = fs.readFileSync(p);
  const utf8 = buf.toString("utf8");
  const hasManyReplacement = (utf8.match(/\uFFFD/g) || []).length >= 5;
  if (!hasManyReplacement) return { text: utf8, encoding: "utf8" };
  const sjis = iconv.decode(buf, "Shift_JIS");
  return { text: sjis, encoding: "shift_jis" };
}

(async () => {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSVが見つかりません: ${CSV_PATH}`);
    process.exit(1);
  }

  const { text, encoding } = readFileSmart(CSV_PATH);

  // ヘッダー無し＝配列で取る
  const rows = parse(text, {
    columns: false,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!rows.length) {
    console.error("CSVに行がありません");
    process.exit(1);
  }

  console.log("=== CSV PATH ===");
  console.log(CSV_PATH);
  console.log("=== encoding guess ===");
  console.log(encoding);
  console.log("");

  // 先頭5件プレビュー
  console.log("=== preview (first 5) ===");
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    const orderId = digitsOnly(row[COL_ORDER_ID]);
    const trackingNo = digitsOnly(row[COL_TRACKING]);
    console.log({ i, orderId: orderId || row[COL_ORDER_ID], trackingNo: trackingNo || row[COL_TRACKING] });
  }
  console.log("");

  const pairs = [];
  const bad = [];

  for (const row of rows) {
    const orderId = Number(digitsOnly(row[COL_ORDER_ID]));
    const trackingNo = digitsOnly(row[COL_TRACKING]);

    if (!Number.isFinite(orderId) || orderId <= 0 || trackingNo.length < 8) {
      bad.push({ orderIdRaw: row[COL_ORDER_ID], trackingRaw: row[COL_TRACKING] });
      continue;
    }
    pairs.push({ orderId, trackingNo });
  }

  console.log(`rows=${rows.length}, pairs(valid)=${pairs.length}, bad=${bad.length}`);
  if (bad.length) {
    console.log("=== bad samples (up to 5) ===");
    console.log(bad.slice(0, 5));
    console.log("");
  }

  if (!pairs.length) {
    console.error("更新できる行がありません。列位置やCSV内容を確認してください。");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 事故防止：サンプル存在チェック
  const sampleIds = pairs.slice(0, 20).map((p) => p.orderId);
  const q = await client.query(`select id from orders where id = any($1::int[])`, [sampleIds]);
  console.log(`db sample exists: ${q.rowCount}/${sampleIds.length}`);
  if (q.rowCount === 0) {
    console.error("orders.id と お客様管理番号（1列目）が一致してない可能性が高いです。");
    await client.end();
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 なので更新しません。OKなら DRY_RUN=0 で実行してください。");
    await client.end();
    return;
  }

  let updated = 0;
  await client.query("begin");
  try {
    for (const p of pairs) {
      const res = await client.query(
        `update orders
           set tracking_no = $1,
               tracking_updated_at = now()
         where id = $2`,
        [p.trackingNo, p.orderId]
      );
      updated += res.rowCount;
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    await client.end();
  }

  console.log(`DONE updated_rows=${updated}`);
})().catch((e) => {
  console.error("ERROR:", e?.stack || e);
  process.exit(1);
});
