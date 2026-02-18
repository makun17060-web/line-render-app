/**
 * scripts/import_b2_issued_tracking.js
 * ヤマトB2「発行済データ.csv」(result.csv) から 伝票番号を取り出し orders.tracking_no を更新
 *
 * ✅ 列ズレ防止：ヘッダー名で取得（列番号に依存しない）
 * ✅ Shift_JIS/UTF-8 両対応（自動判定っぽく動く）
 * ✅ DRY_RUN=1 で更新せずプレビュー/検証だけ
 *
 * 使い方:
 *   DRY_RUN=1 node scripts/import_b2_issued_tracking.js
 *   DRY_RUN=0 node scripts/import_b2_issued_tracking.js
 *
 * 環境:
 *   DATABASE_URL 必須
 *   CSV_PATH 省略時: C:\temp\b2\result.csv（Windows） or /tmp/result.csv（Linux想定）
 */

import fs from "fs";
import path from "path";
import iconv from "iconv-lite";
import { parse } from "csv-parse/sync";
import pg from "pg";

const { Client } = pg;

const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const CSV_PATH =
  process.env.CSV_PATH ??
  (process.platform === "win32"
    ? "C:\\temp\\b2\\result.csv"
    : "/opt/render/project/src/result.csv");

function readFileSmart(p) {
  const buf = fs.readFileSync(p);
  // まず UTF-8 としてデコードしてみて、文字化けが強ければ Shift_JIS で読む
  const utf8 = buf.toString("utf8");
  const hasManyReplacement = (utf8.match(/\uFFFD/g) || []).length >= 5;
  if (!hasManyReplacement) return { text: utf8, encoding: "utf8" };

  const sjis = iconv.decode(buf, "Shift_JIS");
  return { text: sjis, encoding: "shift_jis" };
}

function normalizeHeader(s) {
  return String(s ?? "")
    .trim()
    .replace(/\u3000/g, " "); // 全角スペース
}

function pickColumn(row, headerMap, candidates) {
  for (const name of candidates) {
    const key = headerMap.get(name);
    if (key) return row[key];
  }
  return undefined;
}

function digitsOnly(s) {
  return String(s ?? "").replace(/[^\d]/g, "");
}

function assertFileExists(p) {
  if (!fs.existsSync(p)) {
    console.error(`CSVが見つかりません: ${p}`);
    process.exit(1);
  }
}

(async () => {
  assertFileExists(CSV_PATH);

  const { text, encoding } = readFileSmart(CSV_PATH);

  // CSVとしてパース（ヘッダーあり前提）
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

  // 実際に存在するヘッダー一覧
  const headers = Object.keys(records[0]).map(normalizeHeader);
  const headerMap = new Map(); // 正規化ヘッダー名 -> 実際のキー名
  for (const k of Object.keys(records[0])) {
    headerMap.set(normalizeHeader(k), k);
  }

  // B2でよくある列名候補
  const orderIdCandidates = ["お客様管理番号", "お客様管理番号(入力)"];
  const trackingCandidates = ["伝票番号", "送り状番号"];
  const shipDateCandidates = ["出荷予定日", "発送日", "出荷日"];

  // ヘッダー存在チェック
  const hasOrderCol = orderIdCandidates.some((h) => headerMap.has(h));
  const hasTrackCol = trackingCandidates.some((h) => headerMap.has(h));

  console.log("=== CSV PATH ===");
  console.log(CSV_PATH);
  console.log("=== encoding guess ===");
  console.log(encoding);
  console.log("=== headers(sample) ===");
  console.log(headers.slice(0, 30).join(" / "));
  console.log("");

  if (!hasOrderCol || !hasTrackCol) {
    console.error("必要な列が見つかりません。以下が必要です:");
    console.error(`- 注文ID列候補: ${orderIdCandidates.join(", ")}`);
    console.error(`- 伝票番号列候補: ${trackingCandidates.join(", ")}`);
    console.error("CSVヘッダーを見直してください（B2の出力種別が違う可能性）");
    process.exit(1);
  }

  // まずプレビュー（先頭5件）
  console.log("=== preview (first 5) ===");
  for (let i = 0; i < Math.min(5, records.length); i++) {
    const r = records[i];
    const rawOrder = pickColumn(r, headerMap, orderIdCandidates);
    const rawTrack = pickColumn(r, headerMap, trackingCandidates);
    const rawShip = pickColumn(r, headerMap, shipDateCandidates);

    const orderId = digitsOnly(rawOrder);
    const trackingNo = digitsOnly(rawTrack);

    console.log({
      i,
      orderId: orderId || rawOrder,
      trackingNo: trackingNo || rawTrack,
      shipDate: rawShip,
    });
  }
  console.log("");

  // 更新対象抽出
  const pairs = [];
  const bad = [];

  for (const r of records) {
    const rawOrder = pickColumn(r, headerMap, orderIdCandidates);
    const rawTrack = pickColumn(r, headerMap, trackingCandidates);

    const orderId = digitsOnly(rawOrder);
    const trackingNo = digitsOnly(rawTrack);

    // 最低限のバリデーション
    const okOrder = orderId.length >= 1; // orders.id想定なら数値1桁以上
    const okTrack = trackingNo.length >= 8; // 伝票番号は8〜12桁くらいが多い
    if (!okOrder || !okTrack) {
      bad.push({ rawOrder, rawTrack });
      continue;
    }
    pairs.push({ orderId, trackingNo });
  }

  console.log(`records=${records.length}, pairs(valid)=${pairs.length}, bad=${bad.length}`);
  if (bad.length) {
    console.log("=== bad samples (up to 5) ===");
    console.log(bad.slice(0, 5));
    console.log("");
  }

  if (!pairs.length) {
    console.error("更新できる行がありません。列や内容を確認してください。");
    process.exit(1);
  }

  // DB更新（DRY_RUN対応）
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // 事故防止：存在しない orderId が混じってないか軽くチェック（先頭20件）
  const sampleIds = pairs.slice(0, 20).map((p) => Number(p.orderId)).filter(Number.isFinite);
  if (sampleIds.length) {
    const q = await client.query(
      `select id from orders where id = any($1::int[])`,
      [sampleIds]
    );
    console.log(`db sample exists: ${q.rowCount}/${sampleIds.length}`);
    if (q.rowCount === 0) {
      console.error("orders.id と お客様管理番号 が一致してない可能性が高いです。");
      console.error("（お客様管理番号に orders.id を入れてない場合など）");
      process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 なので更新しません。ここまでのプレビューでOKなら DRY_RUN=0 で実行してください。");
    await client.end();
    return;
  }

  let updated = 0;

  // まとめて更新（1件ずつでもOKだが安全にトランザクション）
  await client.query("begin");
  try {
    for (const p of pairs) {
      const res = await client.query(
        `update orders
           set tracking_no = $1,
               tracking_updated_at = now()
         where id = $2`,
        [p.trackingNo, Number(p.orderId)]
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
})();
