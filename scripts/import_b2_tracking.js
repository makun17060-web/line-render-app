/**
 * scripts/import_b2_tracking.js
 * ヤマトB2「外部ファイルに出力」CSV から
 * 送り状番号(伝票番号) を orders.id（お客様管理番号）に紐付けて更新
 *
 * Run:
 *   FILE=./VMINxxxx.csv node scripts/import_b2_tracking.js
 *
 * Options:
 *   DRY_RUN=1                  更新せずプレビュー
 *   SET_SHIPPED_AT=1           shipped_at も now() で埋める（未設定のみ）
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const iconv = require("iconv-lite");

// 依存： npm i csv-parse iconv-lite
const { parse } = require("csv-parse/sync");

const FILE = process.env.FILE;
if (!FILE) {
  console.error("ERROR: FILE=... を指定してね 例) FILE=./b2_export.csv node scripts/import_b2_tracking.js");
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === "1";
const SET_SHIPPED_AT = process.env.SET_SHIPPED_AT === "1";

function detectAndDecode(buf) {
  // B2は Shift_JIS のことが多いので、まず SJIS を試し、ダメそうならUTF-8に逃げる
  // （厳密判定は難しいので、ここは実務寄り）
  const sjis = iconv.decode(buf, "Shift_JIS");
  // 日本語ヘッダっぽい文字が含まれていればSJIS採用
  if (sjis.includes("送り状") || sjis.includes("お客様管理番号") || sjis.includes("外部ファイル")) {
    return sjis;
  }
  // UTF-8でも読めるならUTF-8にする
  const utf8 = buf.toString("utf8");
  return utf8;
}

function toIntSafe(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanTracking(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 送り状番号はハイフン付きで来るのでそのまま保存（空白だけ除去）
  return s.replace(/\s+/g, "");
}

(async () => {
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) {
    console.error("ERROR: file not found:", abs);
    process.exit(1);
  }

  const buf = fs.readFileSync(abs);
  const text = detectAndDecode(buf);

  // CSV解析（B2はカンマ区切りが基本。クォートあり得る）
  const records = parse(text, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (!records || records.length === 0) {
    console.error("ERROR: CSVが空");
    process.exit(1);
  }

  // 1行目がヘッダーか判定（日本語ヘッダを含むか）
  const header = records[0].map((x) => String(x ?? "").trim());
  const hasHeader =
    header.some((h) => h.includes("送り状番号") || h.includes("送り状") || h.includes("お客様管理番号"));

  let rows = records;
  let idxTracking = null;
  let idxCustomer = null;

  if (hasHeader) {
    // ヘッダー名から列位置を探す
    idxTracking = header.findIndex((h) => h === "送り状番号" || h.includes("送り状番号"));
    if (idxTracking < 0) idxTracking = header.findIndex((h) => h.includes("送り状"));

    idxCustomer = header.findIndex((h) => h === "お客様管理番号" || h.includes("お客様管理番号"));
    if (idxCustomer < 0) idxCustomer = header.findIndex((h) => h.includes("管理番号"));

    rows = records.slice(1);
  } else {
    // ヘッダー無しの可能性もあるので、その場合は
    // 「左の方に送り状番号」「どこかにお客様管理番号」がある想定で推測する。
    // ※ここが不安なら、ヘッダー有りで出力する設定にしておくのが安定。
    // 推測ルール：
    // - ハイフン付きの長い番号（####-####-####）を tracking とみなす
    // - 数字だけの比較的小さい値（注文ID）を customer とみなす
    for (let r = 0; r < Math.min(rows.length, 20); r++) {
      const line = rows[r].map((x) => String(x ?? "").trim());
      for (let c = 0; c < line.length; c++) {
        if (idxTracking == null && /^\d{4}-\d{4}-\d{4}$/.test(line[c])) idxTracking = c;
      }
      for (let c = 0; c < line.length; c++) {
        if (idxCustomer == null && /^\d{1,9}$/.test(line[c])) idxCustomer = c;
      }
      if (idxTracking != null && idxCustomer != null) break;
    }
  }

  if (idxTracking == null || idxCustomer == null || idxTracking < 0 || idxCustomer < 0) {
    console.error("ERROR: 列位置を特定できなかった");
    console.error("  idxTracking=", idxTracking, "idxCustomer=", idxCustomer);
    console.error("  1行目=", records[0]);
    process.exit(1);
  }

  // (order_id, tracking_no) のペアを作る
  const pairs = [];
  for (const row of rows) {
    const tracking = cleanTracking(row[idxTracking]);
    const orderId = toIntSafe(row[idxCustomer]);
    if (!tracking || !orderId) continue;
    pairs.push({ orderId, tracking });
  }

  // 重複除去（最後を優先）
  const map = new Map();
  for (const p of pairs) map.set(p.orderId, p.tracking);
  const unique = [...map.entries()].map(([orderId, tracking]) => ({ orderId, tracking }));

  console.log("FILE=", abs);
  console.log("hasHeader=", hasHeader, "idxTracking=", idxTracking, "idxCustomer=", idxCustomer);
  console.log("rows=", rows.length, "pairs=", pairs.length, "unique_orders=", unique.length);

  // プレビュー
  console.log("sample:");
  unique.slice(0, 10).forEach((p) => console.log(`  order_id=${p.orderId} tracking=${p.tracking}`));

  if (DRY_RUN) {
    console.log("DRY_RUN=1 なので更新しません");
    process.exit(0);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  try {
    await client.query("begin");

    // 一時テーブルに入れて一括更新（速い＆安全）
    await client.query(`
      create temporary table tmp_b2_tracking (
        order_id bigint primary key,
        tracking_no text
      ) on commit drop;
    `);

    // COPY相当のバルクinsert
    const values = [];
    const params = [];
    let i = 1;
    for (const p of unique) {
      params.push(`($${i++}, $${i++})`);
      values.push(p.orderId, p.tracking);
    }

    if (params.length > 0) {
      await client.query(
        `insert into tmp_b2_tracking(order_id, tracking_no) values ${params.join(",")}
         on conflict (order_id) do update set tracking_no = excluded.tracking_no`,
        values
      );
    }

    // orders更新：tracking_no をセット（既に入ってるものは上書きするか？）
    // 方針：B2が正なので上書きOK（不安なら coalesce で未設定のみ）
    const updateSql = SET_SHIPPED_AT
      ? `
        update orders o
        set tracking_no = t.tracking_no,
            shipped_at = coalesce(o.shipped_at, now())
        from tmp_b2_tracking t
        where o.id = t.order_id;
      `
      : `
        update orders o
        set tracking_no = t.tracking_no
        from tmp_b2_tracking t
        where o.id = t.order_id;
      `;

    const res = await client.query(updateSql);
    console.log("updated_orders=", res.rowCount);

    await client.query("commit");
    console.log("DONE");
  } catch (e) {
    await client.query("rollback");
    console.error("ERROR:", e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
