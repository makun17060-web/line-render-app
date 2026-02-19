/**
 * scripts/notify_shipped.js
 * orders.tracking_no が入った注文に「発送通知」を一括送信し、
 * 送信できたら orders.notified_kind='shipped' / notified_user_at を更新する。
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

const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");

const DRY_RUN = String(process.env.DRY_RUN || "0") === "1";
const LIMIT = parseInt(process.env.LIMIT || "50", 10);

const STATUS_LIST = (process.env.STATUS_LIST || "confirmed,paid,pickup")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ONLY_ORDER_ID = process.env.ONLY_ORDER_ID ? parseInt(process.env.ONLY_ORDER_ID, 10) : null;
const SAFE_USER_ID = process.env.SAFE_USER_ID || null;

function buildTrackingUrl(trackingNo) {
  // ヤマトの追跡（番号を埋めてお客さんがすぐ見れるように）
  // ※仕様変更される可能性あるので、あなたの運用URLがあれば差し替え推奨
  return `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number00=${encodeURIComponent(trackingNo)}`;
}

function buildTextMessage({ name, trackingNo }) {
  const url = buildTrackingUrl(trackingNo);
  const n = (name && name.trim()) ? `${name}さん` : "お客さま";
  return `${n}\n\n📦 ご注文商品を発送しました！\n伝票番号：${trackingNo}\n\n配送状況はこちら👇\n${url}\n\n到着まで少々お待ちください🙏\n（磯屋）`;
}

async function linePush(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`LINE push failed: ${res.status} ${res.statusText} ${text}`.slice(0, 500));
  }
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
    where.push(`tracking_no IS NOT NULL AND tracking_no <> ''`);

    // 未通知（shippedとして送ってない）
    where.push(`(notified_kind IS DISTINCT FROM 'shipped' OR notified_user_at IS NULL)`);

    // 対象ステータス
    if (STATUS_LIST.length > 0) {
      params.push(STATUS_LIST);
      where.push(`status = ANY($${params.length})`);
    }

    // 1件だけ
    if (ONLY_ORDER_ID) {
      params.push(ONLY_ORDER_ID);
      where.push(`id = $${params.length}`);
    }

    // SAFE_USER_ID
    if (SAFE_USER_ID) {
      params.push(SAFE_USER_ID);
      where.push(`user_id = $${params.length}`);
    }

    // LIMIT
    params.push(LIMIT);

    const sql = `
      SELECT
        id,
        user_id,
        tracking_no,
        status,
        -- 名前は addresses か orders にある想定が分からないので、
        -- まず orders.name があればそれ、無ければ addresses.name を使うなどに調整してください。
        COALESCE(o.name, a.name, '') AS name
      FROM orders o
      LEFT JOIN addresses a ON a.id = o.address_id
      WHERE ${where.join(" AND ")}
      ORDER BY id ASC
      LIMIT $${params.length}
    `;

    const { rows } = await client.query(sql, params);

    console.log(`[notify_shipped] targets=${rows.length} DRY_RUN=${DRY_RUN} LIMIT=${LIMIT}`);
    if (rows.length === 0) return;

    let sent = 0;
    for (const r of rows) {
      const orderId = r.id;
      const userId = r.user_id;
      const trackingNo = String(r.tracking_no || "").trim();
      const name = r.name || "";

      if (!userId || !trackingNo) {
        console.log(`[skip] order_id=${orderId} user_id=${userId} tracking_no=${trackingNo}`);
        continue;
      }

      const text = buildTextMessage({ name, trackingNo });
      console.log(`[WILL_SEND] order_id=${orderId} user_id=${userId} tracking_no=${trackingNo}`);

      if (!DRY_RUN) {
        try {
          await linePush(userId, [{ type: "text", text }]);

          await client.query(
            `UPDATE orders
             SET notified_kind='shipped',
                 notified_user_at=NOW()
             WHERE id=$1`,
            [orderId]
          );

          sent += 1;
          console.log(`[SENT] order_id=${orderId}`);
        } catch (e) {
          console.error(`[FAILED] order_id=${orderId} ${e.message}`);
        }
      }
    }

    console.log(`[notify_shipped] done sent=${sent}/${rows.length}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
