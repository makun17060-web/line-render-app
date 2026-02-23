/**
 * scripts/import_b2_issued_tracking_unified.cjs  — 統合丸ごと版（ヘッダー有無自動判定 / 事故らないSSL自動判定）
 *
 * ヤマトB2「発行済データ」CSVから 伝票番号を取り出し orders.tracking_no を更新
 *
 * ✅ 1本で両対応
 * - ヘッダー無し: 1列目=お客様管理番号（orders.id想定）, 4列目=伝票番号（index 0 / 3）
 * - ヘッダーあり: 列名候補から抽出（列ズレ事故を回避）
 *
 * ✅ DRY_RUN=1 で更新せずプレビューのみ
 * ✅ 文字コード自動推定（UTF-8 / Shift_JIS）
 * ✅ Render内部(dpg-...-a のようなドメイン無し) / ローカル → SSL OFF
 * ✅ 外部URL（ドメイン付き） → SSL ON(relax)
 *
 * 使い方:
 *   # Windows例
 *   DRY_RUN=1 CSV_PATH=C:\temp\b2\result.csv node scripts/import_b2_issued_tracking_unified.cjs
 *   DRY_RUN=0 CSV_PATH=C:\temp\b2\result.csv node scripts/import_b2_issued_tracking_unified.cjs
 *
 *   # Render例
 *   DRY_RUN=1 CSV_PATH=/opt/render/project/src/tmp/result.csv node scripts/import_b2_issued_tracking_unified.cjs
 *   DRY_RUN=0 CSV_PATH=/opt/render/project/src/tmp/result.csv node scripts/import_b2_issued_tracking_unified.cjs
 *
 * 必要ENV:
 *   DATABASE_URL
 */

const fs = require("fs");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");
const { Client } = require("pg");

// dotenv はあれば読む（無くてもOK）
try {
  require("dotenv").config();
} catch (_) {}

const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";
const CSV_PATH =
  process.env.CSV_PATH ??
  (process.platform === "win32"
    ? "C:\\temp\\b2\\result.csv"
    : "/opt/render/project/src/tmp/result.csv");

// ヘッダー無しの列位置（0始まり）
const COL_ORDER_ID = 0; // お客様管理番号
const COL_TRACKING = 3; // 伝票番号

// ヘッダーありの列名候補（必要に応じて増やしてOK）
const ORDER_ID_CANDIDATES = ["お客様管理番号", "お客様管理番号(入力)"];
const TRACKING_CANDIDATES = ["伝票番号", "送り状番号", "送り状No", "送り状Ｎｏ"];

function digitsOnly(s) {
  return String(s ?? "").replace(/[^\d]/g, "");
}

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

function buildHeaderMapFromRecord(record) {
  const headerMap = new Map();
  for (const k of Object.keys(record || {})) {
    headerMap.set(normalizeHeader(k), k);
  }
  return headerMap;
}

function pickColumn(record, headerMap, candidates) {
  for (const name of candidates) {
    const key = headerMap.get(name);
    if (key) return record[key];
  }
  return undefined;
}

/**
 * SSL自動判定
 * - Render内部: host が "dpg-..." かつ "." を含まない → SSL OFF
 * - ローカル: localhost/127.0.0.1/host.docker.internal → SSL OFF
 * - 外部: それ以外 → SSL ON(relax)
 */
function buildPgConfig() {
  const cs = process.env.DATABASE_URL || "";
  if (!cs) throw new Error("DATABASE_URL is empty");

  const u = new URL(cs);
  const host = u.hostname;

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "host.docker.internal";

  const isRenderInternal = host.startsWith("dpg-") && !host.includes(".");

  const ssl = (isLocal || isRenderInternal) ? false : { rejectUnauthorized: false };

  return {
    connectionString: cs,
    ssl,
    __meta: { host, sslMode: ssl === false ? "off" : "on(relax)" },
  };
}

/**
 * CSVが「ヘッダーあり」か「ヘッダーなし」かを自動判定して pairs を作る
 */
function buildPairsFromCsvText(text) {
  // まずは “ヘッダーあり” としてトライ
  try {
    const records = parse(text, {
      columns: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (records && records.length) {
      const headerMap = buildHeaderMapFromRecord(records[0]);

      const hasOrder = ORDER_ID_CANDIDATES.some((h) => headerMap.has(h));
      const hasTrack = TRACKING_CANDIDATES.some((h) => headerMap.has(h));

      if (hasOrder && hasTrack) {
        // ヘッダーあり確定
        const pairs = [];
        const bad = [];

        for (const r of records) {
          const rawOrder = pickColumn(r, headerMap, ORDER_ID_CANDIDATES);
          const rawTrack = pickColumn(r, headerMap, TRACKING_CANDIDATES);

          const orderId = digitsOnly(rawOrder);
          const trackingNo = digitsOnly(rawTrack);

          const okOrder = orderId.length >= 1;
          const okTrack = trackingNo.length >= 8;

          if (!okOrder || !okTrack) {
            bad.push({ orderIdRaw: rawOrder, trackingRaw: rawTrack });
            continue;
          }
          pairs.push({ orderId: Number(orderId), trackingNo });
        }

        return {
          mode: "header",
          preview: records.slice(0, 5).map((r, i) => {
            const rawOrder = pickColumn(r, headerMap, ORDER_ID_CANDIDATES);
            const rawTrack = pickColumn(r, headerMap, TRACKING_CANDIDATES);
            return {
              i,
              orderId: digitsOnly(rawOrder) || rawOrder,
              trackingNo: digitsOnly(rawTrack) || rawTrack,
            };
          }),
          headers: Array.from(headerMap.keys()),
          rows: records.length,
          pairs,
          bad,
        };
      }
    }
  } catch (_) {
    // ヘッダーありとしてパースできなくても、後でヘッダー無しで試す
  }

  // ヘッダー無しとしてパース
  const rows = parse(text, {
    columns: false,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  });

  if (!rows || !rows.length) {
    throw new Error("CSVに行がありません");
  }

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

  return {
    mode: "noheader",
    preview: rows.slice(0, 5).map((row, i) => ({
      i,
      orderId: digitsOnly(row[COL_ORDER_ID]) || row[COL_ORDER_ID],
      trackingNo: digitsOnly(row[COL_TRACKING]) || row[COL_TRACKING],
    })),
    headers: [],
    rows: rows.length,
    pairs,
    bad,
  };
}

(async () => {
  assertFileExists(CSV_PATH);

  const { text, encoding } = readFileSmart(CSV_PATH);

  const built = buildPairsFromCsvText(text);

  console.log("=== CSV PATH ===");
  console.log(CSV_PATH);
  console.log("=== encoding guess ===");
  console.log(encoding);
  console.log("=== mode ===");
  console.log(built.mode);
  if (built.mode === "header") {
    console.log("=== headers(sample) ===");
    console.log(built.headers.slice(0, 40).join(" / "));
  }
  console.log("");

  console.log("=== preview (first 5) ===");
  for (const p of built.preview) console.log(p);
  console.log("");

  console.log(`rows=${built.rows}, pairs(valid)=${built.pairs.length}, bad=${built.bad.length}`);
  if (built.bad.length) {
    console.log("=== bad samples (up to 5) ===");
    console.log(built.bad.slice(0, 5));
    console.log("");
  }

  if (!built.pairs.length) {
    console.error("更新できる行がありません。列位置/列名候補/CSV内容を確認してください。");
    process.exit(1);
  }

  // DB接続（SSL自動判定）
  const cfg = buildPgConfig();
  console.log("=== DB target (safe) ===");
  console.log({ host: cfg.__meta.host, ssl: cfg.__meta.sslMode });
  console.log("");

  const client = new Client({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
  });

  await client.connect();

  // 事故防止：サンプル存在チェック
  const sampleIds = built.pairs.slice(0, 20).map((p) => p.orderId).filter(Number.isFinite);
  const q = await client.query(`select id from orders where id = any($1::int[])`, [sampleIds]);
  console.log(`db sample exists: ${q.rowCount}/${sampleIds.length}`);
  if (q.rowCount === 0) {
    console.error("orders.id と お客様管理番号 が一致してない可能性が高いです。");
    await client.end();
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 なので更新しません（プレビューのみ）。OKなら DRY_RUN=0 で実行。");
    await client.end();
    return;
  }

  let updated = 0;
  await client.query("begin");
  try {
    for (const p of built.pairs) {
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