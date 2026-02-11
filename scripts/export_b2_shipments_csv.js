/**
 * scripts/export_b2_shipments_csv.js
 *
 * ✅ 目的
 *   orders（status='paid'）から B2クラウド取り込み用CSVを生成する（新規レイアウト前提）
 *   代引（payment_method='cod'）の場合は「コレクト」で出せるようにする（送り状種類=2 + 代金引換額）
 *
 * ✅ Run
 *   node scripts/export_b2_shipments_csv.js > b2_shipments.csv
 *
 * ✅ Options
 *   DRY_RUN=1            : 更新せず対象件数だけ確認
 *   LIMIT=200            : 最大件数
 *   DAYS=30              : 何日前まで遡るか（created_at 기준）
 *   MARK_EXPORTED=1      : CSVに出した注文へ b2_exported_at を付けて二重出力を防ぐ（推奨）
 *
 * ✅ 必要 ENV（B2必須系）
 *   YAMATO_B2_CUSTOMER_CODE  : ご請求先顧客コード
 *   YAMATO_B2_CLASS_CODE     : ご請求先分類コード
 *   YAMATO_B2_FARE_NO        : 運賃管理番号
 *
 * ✅ 必要 ENV（ご依頼主＝磯屋）
 *   SHIPPER_NAME
 *   SHIPPER_TEL
 *   SHIPPER_ZIP
 *   SHIPPER_ADDR1
 *   SHIPPER_ADDR2 (任意)
 *
 * ✅ DB 前提
 *   orders に以下がある想定：
 *     id, status, payment_method, total, shipping_fee, items,
 *     name, phone, zip, pref, address, member_code, created_at
 *
 *   ※ b2_exported_at が無い場合は、下の「ALTER SQL」を1回実行して追加してね
 *     ALTER TABLE orders ADD COLUMN IF NOT EXISTS b2_exported_at timestamptz;
 */

const { Client } = require("pg");

const LIMIT = Number(process.env.LIMIT || 200);
const DAYS = Number(process.env.DAYS || 30);
const DRY_RUN = process.env.DRY_RUN === "1";
const MARK_EXPORTED = process.env.MARK_EXPORTED === "1";

function jstYmd(date = new Date()) {
  const jst = new Date(date.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const y = jst.getFullYear();
  const m = String(jst.getMonth() + 1).padStart(2, "0");
  const d = String(jst.getDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

function csvEscape(v) {
  const s = (v ?? "").toString();
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function normalizeZip(zip) {
  return (zip || "").toString().replace(/[^\d]/g, "").slice(0, 7);
}

function normalizeTel(tel) {
  return (tel || "").toString().trim();
}

function buildDestAddr(pref, addr) {
  return `${pref || ""}${addr || ""}`.trim();
}

function buildItemName(items, fallback = "磯屋 えびせん") {
  try {
    const obj = typeof items === "string" ? JSON.parse(items) : items;
    if (Array.isArray(obj) && obj.length) {
      const head = obj[0];
      const name = head?.name || head?.title || fallback;
      const qty = head?.qty || head?.quantity;
      return qty ? `${name} x${qty}` : `${name}`;
    }
  } catch (_) {}
  return fallback;
}

function toInt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : 0;
}

async function main() {
  const {
    DATABASE_URL,
    YAMATO_B2_CUSTOMER_CODE,
    YAMATO_B2_CLASS_CODE,
    YAMATO_B2_FARE_NO,
    SHIPPER_NAME,
    SHIPPER_TEL,
    SHIPPER_ZIP,
    SHIPPER_ADDR1,
    SHIPPER_ADDR2,
  } = process.env;

  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (!YAMATO_B2_CUSTOMER_CODE || !YAMATO_B2_CLASS_CODE || !YAMATO_B2_FARE_NO) {
    throw new Error("Missing YAMATO_B2_* (CUSTOMER_CODE / CLASS_CODE / FARE_NO)");
  }
  if (!SHIPPER_NAME || !SHIPPER_TEL || !SHIPPER_ZIP || !SHIPPER_ADDR1) {
    throw new Error("Missing SHIPPER_* (NAME/TEL/ZIP/ADDR1). ADDR2 is optional.");
  }

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // status='paid' が出荷対象（あなたの実データに合わせて確定）
  // b2_exported_at が NULL のものだけ（再出力防止）
  const sql = `
    SELECT
      o.id,
      o.status,
      o.payment_method,
      o.total,
      o.shipping_fee,
      o.items,
      o.name        AS dest_name,
      o.phone       AS dest_tel,
      o.zip         AS dest_zip,
      o.pref        AS dest_pref,
      o.address     AS dest_addr,
      o.member_code AS member_code,
      o.created_at,
      o.b2_exported_at
    FROM orders o
    WHERE
      o.status = 'paid'
      AND (o.b2_exported_at IS NULL)
      AND o.created_at >= (NOW() - ($1 || ' days')::interval)
    ORDER BY o.created_at ASC
    LIMIT $2
  `;

  const { rows } = await client.query(sql, [DAYS, LIMIT]);

  if (DRY_RUN) {
    console.error(`[export_b2] DRY_RUN=1 rows=${rows.length}`);
    await client.end();
    process.exit(0);
  }

  // ✅ B2クラウド「新規レイアウト」で紐付けする前提
  // 必須：出荷予定日／送り状種類／宛先TEL/名/郵便/住所／依頼主TEL/名/郵便/住所／品名1
  // 必須：ご請求先顧客コード／ご請求先分類コード／運賃管理番号
  // 代引（コレクト）のため：代金引換額 を追加
  const header = [
    "出荷予定日",
    "送り状種類",
    "お届け先電話番号",
    "お届け先名",
    "お届け先郵便番号",
    "お届け先住所",
    "ご依頼主電話番号",
    "ご依頼主名",
    "ご依頼主郵便番号",
    "ご依頼主住所",
    "品名1",
    "ご請求先顧客コード",
    "ご請求先分類コード",
    "運賃管理番号",
    "代金引換額",      // ✅ コレクト用
    "お客様管理番号",  // 任意：member_code を入れて突合が楽
    "記事",            // 任意：自由メモ
  ];

  const lines = [];
  lines.push(header.map(csvEscape).join(","));

  const shipDate = jstYmd(new Date());

  for (const r of rows) {
    const pm = (r.payment_method || "").toLowerCase();
    const isCod = pm === "cod"; // ✅ あなたのDBでは代引=cod

    // 送り状種類：0=発払い、2=コレクト(代引)
    const slipType = isCod ? "2" : "0";

    const destZip = normalizeZip(r.dest_zip);
    const destAddr = buildDestAddr(r.dest_pref, r.dest_addr);
    const item1 = buildItemName(r.items, "磯屋 えびせん");

    // ✅ 代金引換額：まずは total + shipping_fee
    // （代引手数料を別で取ってる場合は、ここに足す）
    const collectAmount = isCod ? String(toInt(r.total) + toInt(r.shipping_fee)) : "";

    const row = {
      "出荷予定日": shipDate,
      "送り状種類": slipType,
      "お届け先電話番号": normalizeTel(r.dest_tel),
      "お届け先名": (r.dest_name || "").toString().trim(),
      "お届け先郵便番号": destZip,
      "お届け先住所": destAddr,

      "ご依頼主電話番号": normalizeTel(SHIPPER_TEL),
      "ご依頼主名": SHIPPER_NAME,
      "ご依頼主郵便番号": normalizeZip(SHIPPER_ZIP),
      "ご依頼主住所": `${SHIPPER_ADDR1}${SHIPPER_ADDR2 ? " " + SHIPPER_ADDR2 : ""}`.trim(),

      "品名1": item1,

      "ご請求先顧客コード": YAMATO_B2_CUSTOMER_CODE,
      "ご請求先分類コード": YAMATO_B2_CLASS_CODE,
      "運賃管理番号": YAMATO_B2_FARE_NO,

      "代金引換額": collectAmount,
      "お客様管理番号": (r.member_code || `order-${r.id}`).toString(),
      "記事": "磯屋ミニアプリ",
    };

    lines.push(header.map((k) => csvEscape(row[k])).join(","));
  }

  process.stdout.write(lines.join("\n") + "\n");

  if (MARK_EXPORTED && rows.length) {
    const ids = rows.map((r) => r.id);
    await client.query(
      `UPDATE orders SET b2_exported_at = NOW() WHERE id = ANY($1::int[])`,
      [ids]
    );
    console.error(`[export_b2] marked exported: ${ids.length}`);
  }

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
