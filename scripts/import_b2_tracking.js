/**
 * scripts/import_b2_tracking.js
 * ヤマトB2「発行済データ（外部ファイルに出力）」CSV から
 * 送り状番号(伝票番号) を orders.id（お客様管理番号）に紐付けて更新する。
 *
 * ✅ 想定（あなたのCSV）
 * - 1列目: お客様管理番号（= orders.id）
 * - 4列目: 送り状番号（例: 489804159832 / 4898-0415-9832 等）
 *
 * Run:
 *   FILE=./tmp/20260217153717.csv DRY_RUN=1 FORCE_B2_ISSUED=1 node scripts/import_b2_tracking.js
 *   FILE=./tmp/20260217153717.csv FORCE_B2_ISSUED=1 node scripts/import_b2_tracking.js
 *
 * Options:
 *   DRY_RUN=1                 更新せずプレビュー
 *   SET_SHIPPED_AT=1          shipped_at を now() で埋める（未設定のみ）
 *   FORCE_B2_ISSUED=1         B2「発行済データCSV」用に列を固定（customer=0, tracking=3）
 *
 *   (汎用) FORCE_CUSTOMER_COL=0   お客様管理番号の列（0始まり）
 *   (汎用) FORCE_TRACKING_COL=3   送り状番号の列（0始まり）
 *
 * Dependencies:
 *   npm i csv-parse iconv-lite
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");

const FILE = process.env.FILE;
if (!FILE) {
  console.error(
    "ERROR: FILE=... を指定してね 例) FILE=./tmp/20260217153717.csv FORCE_B2_ISSUED=1 node scripts/import_b2_tracking.js"
  );
  process.exit(1);
}

const DRY_RUN = process.env.DRY_RUN === "1";
const SET_SHIPPED_AT = process.env.SET_SHIPPED_AT === "1";

// 強制列指定（0始まり）
const FORCE_B2_ISSUED = process.env.FORCE_B2_ISSUED === "1";
const FORCE_CUSTOMER_COL =
  process.env.FORCE_CUSTOMER_COL != null ? Number(process.env.FORCE_CUSTOMER_COL) : null;
const FORCE_TRACKING_COL =
  process.env.FORCE_TRACKING_COL != null ? Number(process.env.FORCE_TRACKING_COL) : null;

function detectAndDecode(buf) {
  // B2は Shift_JIS が多いのでまずSJISを試す
  const sjis = iconv.decode(buf, "Shift_JIS");
  if (sjis.includes("送り状") || sjis.includes("お客様管理番号") || sjis.includes("発行済")) {
    return sjis;
  }
  // それでもダメならUTF-8
  return buf.toString("utf8");
}

function toIntSafe(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^"|"$/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanTracking(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  // 両端のクォート剥がし
  s = s.replace(/^"|"$/g, "");
  // 空白除去
  s = s.replace(/\s+/g, "");
  if (!s) return null;

  // B2の「4898-0415-9832」も「489804159832」も受けたいので、見た目はそのまま保存
  // ただし "0" みたいなのは弾く（今回の事故対策）
  if (s === "0") return null;
  return s;
}

function isNonEmptyString(v) {
  if (v == null) return false;
  const s = String(v).trim().replace(/^"|"$/g, "");
  return s.length > 0;
}

(async () => {
  const abs = path.resolve(FILE);
  if (!fs.existsSync(abs)) {
    console.error("ERROR: file not found:", abs);
    process.exit(1);
  }

  const buf = fs.readFileSync(abs);
  const text = detectAndDecode(buf);

  const records = parse(text, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  if (!records || records.length === 0) {
    console.error("ERROR: CSVが空");
    process.exit(1);
  }

  // 1行目がヘッダーか判定（日本語ヘッダっぽい文字が含まれていればヘッダー扱い）
  const header = records[0].map((x) => String(x ?? "").trim());
  const hasHeader = header.some((h) => h.includes("送り状") || h.includes("お客様管理番号"));

  let rows = records;
  let idxTracking = null;
  let idxCustomer = null;

  if (hasHeader) {
    // ヘッダー名から列位置を探す（環境差あるので「含む」で拾う）
    idxTracking = header.findIndex((h) => h === "送り状番号" || h.includes("送り状番号"));
    if (idxTracking < 0) idxTracking = header.findIndex((h) => h.includes("送り状"));

    idxCustomer = header.findIndex((h) => h === "お客様管理番号" || h.includes("お客様管理番号"));
    if (idxCustomer < 0) idxCustomer = header.findIndex((h) => h.includes("管理番号"));

    rows = records.slice(1);
  } else {
    // ヘッダー無しの場合の推測（保険）
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

  // ✅ 強制列指定（優先度高）
  if (FORCE_B2_ISSUED) {
    idxCustomer = 0; // 1列目
    idxTracking = 3; // 4列目
  }
  if (Number.isFinite(FORCE_CUSTOMER_COL)) idxCustomer = FORCE_CUSTOMER_COL;
  if (Number.isFinite(FORCE_TRACKING_COL)) idxTracking = FORCE_TRACKING_COL;

  if (idxTracking == null || idxCustomer == null || idxTracking < 0 || idxCustomer < 0) {
    console.error("ERROR: 列位置を特定できなかった");
    console.error("  idxTracking=", idxTracking, "idxCustomer=", idxCustomer);
    console.error("  1行目=", records[0]);
    process.exit(1);
  }

  // (order_id, tracking_no) のペアを作る
  const pairs = [];
  for (const row of rows) {
    const orderId = toIntSafe(row[idxCustomer]);
    const tracking = cleanTracking(row[idxTracking]);

    if (!orderId) continue;
    if (!tracking) continue;

    pairs.push({ orderId, tracking });
  }

  // 重複除去（最後を優先）
  const map = new Map();
  for (const p of pairs) map.set(p.orderId, p.tracking);
  const unique = [...map.entries()].map(([orderId, tracking]) => ({ orderId, tracking }));

  console.log("FILE=", abs);
  console.log("hasHeader=", hasHeader, "idxTracking=", idxTracking, "idxCustomer=", idxCustomer);
  console.log("rows=", rows.length, "pairs=", pairs.length, "unique_orders=", unique.length);

  console.log("sample:");
  unique.slice(0, 10).forEach((p) => console.log(`  order_id=${p.orderId} tracking=${p.tracking}`));

  // もし tracking が全部 "0" とかになったら早期に気付けるように警告
  if (unique.length === 0 && rows.length > 0) {
    console.warn("WARN: 取り込み対象が0件。列指定がズレてる可能性あり。");
    console.warn("      FORCE_B2_ISSUED=1 / FORCE_TRACKING_COL / FORCE_CUSTOMER_COL を確認してね。");
  }

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

    // 列がない場合に備えて（安全）
    await client.query(`
      alter table orders
        add column if not exists tracking_no text,
        add column if not exists shipped_at timestamptz;
    `);

    // 一時テーブルで一括更新
    await client.query(`
      create temporary table tmp_b2_tracking (
        order_id bigint primary key,
        tracking_no text
      ) on commit drop;
    `);

    if (unique.length > 0) {
      const values = [];
      const params = [];
      let i = 1;
      for (const p of unique) {
        params.push(`($${i++}, $${i++})`);
        values.push(p.orderId, p.tracking);
      }

      await client.query(
        `insert into tmp_b2_tracking(order_id, tracking_no) values ${params.join(",")}
         on conflict (order_id) do update set tracking_no = excluded.tracking_no`,
        values
      );
    }

    // orders更新（tracking_no はB2が正なので上書きOK）
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
