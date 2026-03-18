/**
 * scripts/notify_shipped.js
 * orders.tracking_no が入った注文に「発送通知」を一括送信し、
 * 送信できたら orders.shipped_notified_at を更新する。
 *
 * 重要:
 * - notified_kind / notified_user_at は再送判定に使わない
 * - 発送通知は shipped_notified_at だけで管理する
 *
 * Env:
 *  - DATABASE_URL (required)
 *  - LINE_CHANNEL_ACCESS_TOKEN (required)
 *  - DRY_RUN=1            => 送信しない（表示だけ）
 *  - LIMIT=50             => 最大送信件数（デフォ 50）
 *  - STATUS_LIST="confirmed,paid,pickup"  => 対象ステータス（デフォこれ）
 *  - ONLY_ORDER_ID=123    => 1件だけ（検証用）
 *  - SAFE_USER_ID=Uxxxx   => この user_id 以外は送らない（事故防止）
 */
require("dotenv").config();

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");

const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
const LIMIT = parseInt(process.env.LIMIT || "50", 10);

const STATUS_LIST = (process.env.STATUS_LIST || "confirmed,paid,pickup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ONLY_ORDER_ID = process.env.ONLY_ORDER_ID
  ? String(process.env.ONLY_ORDER_ID).trim()
  : null;

const SAFE_USER_ID = process.env.SAFE_USER_ID || null;

function buildTrackingUrl(trackingNo) {
  return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=${encodeURIComponent(trackingNo)}`;
}

function buildTextMessage({ name, trackingNo }) {
  const url = buildTrackingUrl(trackingNo);
  const n = name && String(name).trim() ? `${String(name).trim()}さん` : "お客さま";
  return `${n}

📦 ご注文商品を発送しました！
伝票番号：${trackingNo}

配送状況はこちら👇
${url}

到着まで少々お待ちください🙏
（磯屋）`;
}

async function linePush(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE push failed: ${res.status} ${res.statusText} ${text}`.slice(0, 500));
  }
}

async function markShippedNotified(client, orderId) {
  await client.query(
    `
    UPDATE orders
    SET shipped_notified_at = NOW()
    WHERE id = $1
    `,
    [orderId]
  );
}

async function main() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const where = [];
    const params = [];

    // tracking_no が入ってる
    where.push(`tracking_no IS NOT NULL`);
    where.push(`BTRIM(tracking_no) <> ''`);

    // 発送通知未送信
    where.push(`shipped_notified_at IS NULL`);

    // 対象ステータス
    if (STATUS_LIST.length > 0) {
      params.push(STATUS_LIST);
      where.push(`status = ANY($${params.length})`);
    }

    // 1件だけ
    if (ONLY_ORDER_ID) {
      params.push(ONLY_ORDER_ID);
      where.push(`CAST(id AS text) = $${params.length}`);
    }

    // SAFE_USER_ID
    if (SAFE_USER_ID) {
      params.push(SAFE_USER_ID);
      where.push(`user_id = $${params.length}`);
    }

    params.push(LIMIT);

    const sql = `
      SELECT
        id,
        user_id,
        tracking_no,
        status,
        COALESCE(name, '') AS name,
        shipped_notified_at
      FROM orders
      WHERE ${where.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT $${params.length}
    `;

    const { rows } = await client.query(sql, params);

    console.log(`[notify_shipped] targets=${rows.length} DRY_RUN=${DRY_RUN} LIMIT=${LIMIT}`);
    if (rows.length === 0) return;

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const r of rows) {
      const orderId = r.id;
      const userId = String(r.user_id || "").trim();
      const trackingNo = String(r.tracking_no || "").trim();
      const name = r.name || "";

      if (!userId || !trackingNo) {
        skipped += 1;
        console.log(`[SKIP_INVALID] order_id=${orderId} user_id=${userId || "(null)"} tracking_no=${trackingNo || "(null)"}`);
        continue;
      }

      const text = buildTextMessage({ name, trackingNo });
      console.log(`[TARGET_SHIPPED] order_id=${orderId} user_id=${userId} tracking_no=${trackingNo}`);

      if (DRY_RUN) {
        console.log(`[DRY_RUN_SHIPPED] order_id=${orderId}`);
        continue;
      }

      try {
        await linePush(userId, [{ type: "text", text }]);
        console.log(`[SENT_SHIPPED_OK] order_id=${orderId}`);

        await markShippedNotified(client, orderId);
        console.log(`[DB_UPDATED_SHIPPED] order_id=${orderId}`);

        sent += 1;
      } catch (e) {
        failed += 1;
        console.error(`[SENT_SHIPPED_NG] order_id=${orderId} ${e.message}`);
      }
    }

    console.log(
      `[notify_shipped] done sent=${sent} failed=${failed} skipped=${skipped} total=${rows.length}`
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});