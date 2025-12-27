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
  // 未送信だけ取得（最大20000とかにしてもOKだが、LINEは1回500上限なので分割する）
  const { rows } = await pool.query(
    `
    SELECT user_id
      FROM segment_blast
     WHERE segment_key = $1
       AND sent_at IS NULL
     ORDER BY user_id
     LIMIT 20000
    `,
    [SEGMENT_KEY]
  );

  const ids = rows.map((r) => r.user_id).filter(Boolean);
  console.log(`SEGMENT_KEY=${SEGMENT_KEY} unsent targets=${ids.length}`);

  if (ids.length === 0) {
    console.log("Nothing to send.");
    await pool.end();
    return;
  }

  // ★文面（まずは text が安全）
  const messages = [
    {
      type: "text",
      text:
        "ミニアプリをご利用ありがとうございます😊\n" +
        "本格派えびせんべいをぜひご賞味ください\n" +
        "👇\n" +
        "https://liff.line.me/2008406620-G5j1gjzM",
    },
  ];

  const batches = chunk(ids, 500); // multicastは最大500
  let sent = 0;
  let failed = 0;

  for (const part of batches) {
    try {
      await lineMulticast(part, messages);

      await pool.query(
        `
        UPDATE segment_blast
           SET sent_at = NOW(), last_error = NULL
         WHERE segment_key = $1
           AND user_id = ANY($2::text[])
        `,
        [SEGMENT_KEY, part]
      );

      sent += part.length;
      console.log(`OK batch: ${part.length} (total sent=${sent})`);
    } catch (e) {
      failed += part.length;
      console.error(`NG batch: ${part.length}`, e.message);

      await pool.query(
        `
        UPDATE segment_blast
           SET last_error = $3
         WHERE segment_key = $1
           AND user_id = ANY($2::text[])
        `,
        [SEGMENT_KEY, part, String(e.message).slice(0, 500)]
      );

      // 連続失敗を避けるならここで break でもOK
      // break;
    }

    // レート対策（軽く間隔）
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`DONE sent=${sent} failed=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
