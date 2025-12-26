// One-shot blast sender (multicast) using segment_blast
// Run: SEGMENT_KEY=... node send_blast_once.js
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN

const { Pool } = require("pg");

const SEGMENT_KEY = process.env.SEGMENT_KEY || "liff_200_blast_20251223";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL = process.env.DATABASE_URL;

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false } });

async function lineMulticast(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LINE multicast failed: ${res.status} ${text}`);
  return text;
}

(async () => {
  // 未送信だけ取得（最大500まで。今回は200）
  const { rows } = await pool.query(
    `SELECT user_id
       FROM segment_blast
      WHERE segment_key = $1
        AND sent_at IS NULL
      ORDER BY user_id
      LIMIT 500`,
    [SEGMENT_KEY]
  );

  const ids = rows.map(r => r.user_id).filter(Boolean);
  console.log(`SEGMENT_KEY=${SEGMENT_KEY} unsent targets = ${ids.length}`);

  if (ids.length === 0) {
    console.log("Nothing to send.");
    await pool.end();
    return;
  }

  // ★ここを好きな文面に変更OK（まずはテキストで確実に）
  const messages = [
    {
      type: "text",
      text:
`ミニアプリをご利用ありがとうございます😊
本格派えびせんべいをぜひご賞味ください
👇https://liff.line.me/2008406620-G5j1gjzM
    }
  ];

  try {
    await lineMulticast(ids, messages);

    await pool.query(
      `UPDATE segment_blast
          SET sent_at = NOW(), last_error = NULL
        WHERE segment_key = $1
          AND user_id = ANY($2::text[])`,
      [SEGMENT_KEY, ids]
    );

    console.log("Multicast success. Marked sent_at.");
  } catch (e) {
    console.error(e.message);

    // 失敗時はエラーだけ記録（sent_atは立てない）
    await pool.query(
      `UPDATE segment_blast
          SET last_error = $3
        WHERE segment_key = $1
          AND user_id = ANY($2::text[])`,
      [SEGMENT_KEY, ids, String(e.message).slice(0, 500)]
    );

    console.log("Recorded last_error. (sent_at not updated)");
  } finally {
    await pool.end();
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
