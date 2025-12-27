// send_blast_once.js
// Run: SEGMENT_KEY=... node send_blast_once.js
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN
"use strict";

const { Pool } = require("pg");

const SEGMENT_KEY = process.env.SEGMENT_KEY || "liff_200_blast_20251223";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL = process.env.DATABASE_URL;

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");

// Node 18+ 推奨（fetchあり）
if (typeof fetch !== "function") {
  throw new Error("fetch is not available. Use Node 18+ or switch to undici.");
}

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

async function lineMulticast(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`LINE multicast failed: ${res.status} ${text}`);
  return text;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

(async () => {
  // 未送信だけ取得（最大500）
  const { rows } = await pool.query(
    `SELECT user_id
       FROM segment_blast
      WHERE segment_key = $1
        AND sent_at IS NULL
      ORDER BY user_id
      LIMIT 500`,
    [SEGMENT_KEY]
  );

  const ids = rows.map((r) => r.user_id).filter(Boolean);
  console.log(`SEGMENT_KEY=${SEGMENT_KEY} unsent targets = ${ids.length}`);

  if (ids.length === 0) {
    console.log("Nothing to send.");
    await pool.end();
    return;
  }

  // ★文面（テキスト）※URLは短縮推奨
  const messages = [
    {
      type: "text",
      text:
`ミニアプリをご利用ありがとうございます😊
本格派えびせんべいをぜひご賞味ください
👇 https://liff.line.me/2008406620-G5j1gjzM`,
    },
  ];

  // multicast は 500 までだが、失敗切り分けのため小分け推奨
  const CHUNK_SIZE = 150;
  const parts = chunk(ids, CHUNK_SIZE);

  let sentTotal = 0;
  let failedTotal = 0;

  for (const partIds of parts) {
    try {
      await lineMulticast(partIds, messages);

      await pool.query(
        `UPDATE segment_blast
            SET sent_at = NOW(), last_error = NULL
          WHERE segment_key = $1
            AND user_id = ANY($2::text[])`,
        [SEGMENT_KEY, partIds]
      );

      sentTotal += partIds.length;
      console.log(`✅ sent ${partIds.length} (total ${sentTotal})`);
    } catch (e) {
      failedTotal += partIds.length;
      const msg = String(e.message || e).slice(0, 500);
      console.error(`❌ chunk failed (${partIds.length}):`, msg);

      await pool.query(
        `UPDATE segment_blast
            SET last_error = $3
          WHERE segment_key = $1
            AND user_id = ANY($2::text[])`,
        [SEGMENT_KEY, partIds, msg]
      );

      console.log("Recorded last_error for this chunk. (sent_at not updated)");
    }
  }

  console.log(`DONE. sent=${sentTotal}, failedChunksUsers=${failedTotal}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
