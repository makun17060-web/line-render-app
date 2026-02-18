/**
 * scripts/import_b2_issued_tracking.cjs
 * ヤマトB2「発行済データ」CSV(result.csv) から 伝票番号を取り出し orders.tracking_no を更新
 *
 * ✅ CommonJS版（Renderの現状に合わせる）
 * ✅ ヘッダー名で取得（列ズレ事故を回避）
 * ✅ DRY_RUN=1 で更新せずプレビューのみ
 *
 * 使い方:
 *   DRY_RUN=1 CSV_PATH=/opt/render/project/src/tmp/result.csv node scripts/import_b2_issued_tracking.cjs
 *   DRY_RUN=0 CSV_PATH=/opt/render/project/src/tmp/result.csv node scripts/import_b2_issued_tracking.cjs
 *
 * 必要ENV:
 *   DATABASE_URL
 */

const fs = require("fs");
const path = require("path");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");
const pg = require("pg");
const { Client } = pg;

const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const CSV_PATH =
  process.env.CSV_PATH ??
  (process.platform === "win32"
    ? "C:\\temp\\b2\\result.csv"
    : "/opt/render/project/src/tmp/result.csv");

function assertFileExists(p) {
  if (!fs.existsSync(p)) {
    console.error(`CSVが見つかりません: ${p}`);
    process.exit(1);
  }
}

function readFileSmart(p) {
  const buf = fs.readFileSync(p);
  const utf8 = buf.toString("utf8");
  const hasManyReplacement = (utf8.match(/\uFFFD/g) || []).length >= 5;
  if (!hasManyReplacement) return { text: utf8, encoding: "utf8" };
  const sjis = iconv.decode(buf, "Shift_JIS");
  return { text: sjis, encoding: "shift_jis" };
}

function normalizeHeader(s) {
  return String(s ?? "").trim().replace(/\u3000/g, " ");
}

function digitsOnly(s) {
  return String(s ?? "").replace(/[^\d]/g, "");
}

function pickColumn(row, headerMap, candidates) {
  for (const name of candidates) {
    const key = headerMap.get(name);
    if (key) return row[key];
  }
  return undefined;
}

(async () => {
  assertFileExists(CSV_PATH);

  const { text, encoding } = readFileSmart(CSV_PATH);

  const records = parse(text, {
    columns: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!records.length) {
    console.error("CSVにレコードがありません（ヘッダーだけの可能性）");
    process.exit(1);
  }

  const headerMap = new Map();
  for (const k of Object.keys(records[0])) {
    headerMap.set(normalizeHeader(k), k);
  }
  const headers = Array.from(headerMap.keys());

  const orderIdCandidates = ["お客様管理番号", "お客様管理番号(入力)"];
  const trackingCandidates = ["伝票番号", "送り状番号"];

  const hasOrderCol = orderIdCandidates.some((h) => headerMap.has(h));
  const hasTrackCol = trackingCandidates.some((h) => headerMap.has(h));

  console.log("=== CSV PATH ===");
  console.log(CSV_PATH);
  console.log("=== encoding guess ===");
  console.log(encoding);
  console.log("=== headers(sample) ===");
  console.log(headers.slice(0, 40).join(" / "));
  console.log("");

  if (!hasOrderCol || !hasTrackCol) {
    console.error("必要な列が見つかりません。必要列候補:");
    console.error(`- 注文ID: ${orderIdCandidates.join(", ")}`);
    console.error(`- 伝票番号: ${trackingCandidates.join(", ")}`);
    process.exit(1);
  }

  console.log("=== preview (first 5) ===");
  for (let i = 0; i < Math.min(5, records.length); i++) {
    const r = records[i];
    const rawOrder = pickColumn(r, headerMap, orderIdCandidates);
    const rawTrack = pickColumn(r, headerMap, trackingCandidates);
    console.log({
      i,
      orderId: digitsOnly(rawOrder) || rawOrder,
      trackingNo: digitsOnly(rawTrack) || rawTrack,
    });
  }
  console.log("");

  const pairs = [];
  const bad = [];

  for (const r of records) {
    const rawOrder = pickColumn(r, headerMap, orderIdCandidates);
    const rawTrack = pickColumn(r, headerMap, trackingCandidates);
    const orderId = digitsOnly(rawOrder);
    const trackingNo = digitsOnly(rawTrack);

    const okOrder = orderId.length >= 1;
    const okTrack = trackingNo.length >= 8;

    if (!okOrder || !okTrack) {
      bad.push({ rawOrder, rawTrack });
      continue;
    }
    pairs.push({ orderId: Number(orderId), trackingNo });
  }

  console.log(`records=${records.length}, pairs(valid)=${pairs.length}, bad=${bad.length}`);
  if (bad.length) {
    console.log("=== bad samples (up to 5) ===");
    console.log(bad.slice(0, 5));
    console.log("");
  }

  if (!pairs.length) {
    console.error("更新できる行がありません。CSV内容を確認してください。");
    process.exit(1);
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 事故防止：サンプルの orderId がDBに存在するか
  const sampleIds = pairs.slice(0, 20).map((p) => p.orderId).filter(Number.isFinite);
  if (sampleIds.length) {
    const q = await client.query(`select id from orders where id = any($1::int[])`, [sampleIds]);
    console.log(`db sample exists: ${q.rowCount}/${sampleIds.length}`);
    if (q.rowCount === 0) {
      console.error("orders.id と お客様管理番号 が一致してない可能性が高いです。");
      await client.end();
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 なので更新しません（プレビューのみ）。OKなら DRY_RUN=0 で実行。");
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
