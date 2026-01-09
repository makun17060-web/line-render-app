// send_blast_once.js — 福箱向け（未送信 + 未購入者だけ配信）Text/Flex 切替版
// Run:
//   SEGMENT_KEY=... MESSAGE_FILE=... FUKUBAKO_ID=fukubako-2026 node send_blast_once.js
// Optional:
//   FUKUBAKO_URL="https://.../fukubako.html"   (Flex内リンク作成に使いたい場合)
//   DRY_RUN=1  (送信せず対象件数だけ表示)
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN
//
// MESSAGE_FILE の形式：
//   - JSON配列: [ {message}, {message} ... ]
//   - または: { "messages": [ ... ] }
//
// 例:
//   MESSAGE_FILE=./messages/text.json
//   MESSAGE_FILE=./messages/flex.json

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SEGMENT_KEY   = process.env.SEGMENT_KEY || "fukubako_blast_20260109";
const TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL         = process.env.DATABASE_URL;
const MESSAGE_FILE  = process.env.MESSAGE_FILE || ""; // 外部JSON切替
const DRY_RUN       = String(process.env.DRY_RUN || "").trim() === "1";

// 福箱判定（商品ID）
const FUKUBAKO_ID   = (process.env.FUKUBAKO_ID || "fukubako-2026").trim();
// 使うなら（Flexのリンク埋め込みなど）
const FUKUBAKO_URL  = (process.env.FUKUBAKO_URL || "").trim();

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!FUKUBAKO_ID) throw new Error("FUKUBAKO_ID is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function mustString(x, name) {
  if (typeof x !== "string" || x.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return x.trim();
}

// messages を外部JSONから読み込む
function loadMessages() {
  // MESSAGE_FILE 未指定ならデフォルト（テキスト）
  if (!MESSAGE_FILE) {
    const text =
`【福箱（数量限定）ご案内】
お一人様1回限りの限定福箱です🎁
こちらから購入できます👇
${FUKUBAKO_URL || "（URL未設定：FUKUBAKO_URLを指定してください）"}`;

    return [{ type: "text", text }];
  }

  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) throw new Error(`MESSAGE_FILE not found: ${fp}`);

  const raw = fs.readFileSync(fp, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`MESSAGE_FILE JSON parse failed: ${e.message}`);
  }

  const msgs = Array.isArray(json) ? json : json?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error(`MESSAGE_FILE format invalid. Use: [..] or {"messages":[..]}`);
  }

  // 軽いバリデーション（事故防止）
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== "object") throw new Error(`messages[${i}] must be an object`);
    const type = mustString(m.type, `messages[${i}].type`);

    if (type === "text") {
      mustString(m.text, `messages[${i}].text`);
    } else if (type === "flex") {
      mustString(m.altText, `messages[${i}].altText`);
      if (!m.contents || typeof m.contents !== "object") throw new Error(`messages[${i}].contents is required`);
    } else if (type === "image") {
      mustString(m.originalContentUrl, `messages[${i}].originalContentUrl`);
      mustString(m.previewImageUrl, `messages[${i}].previewImageUrl`);
    } else {
      throw new Error(`Unsupported message type: ${type} (allowed: text, flex, image)`);
    }
  }

  return msgs;
}

async function lineMulticast(to, messages) {
  // Node 18+ は fetch あり。無い環境なら node-fetch を入れる必要あり。
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

// ✅ 福箱購入済み判定（orders.items が jsonb）
// - items が配列: [{id, qty, ...}, ...] でも
// - items がオブジェクト: {items:[{id..}], ...} でも
// 両方拾えるようにする
function buildAlreadyBoughtSQL() {
  // items が配列の場合：jsonb_array_elements(items)
// items が {items:[...]} の場合：jsonb_array_elements(items->'items')
  return `
    SELECT DISTINCT o.user_id
      FROM orders o
     WHERE o.user_id IS NOT NULL
       AND o.user_id <> ''
       AND (
         EXISTS (
           SELECT 1
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(o.items) = 'array' THEN o.items
                 WHEN jsonb_typeof(o.items) = 'object' AND jsonb_typeof(o.items->'items') = 'array' THEN o.items->'items'
                 ELSE '[]'::jsonb
               END
             ) elem
            WHERE (elem->>'id') = $1
         )
       )
  `;
}

(async () => {
  const messages = loadMessages();

  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE || "(default)"}`);
  console.log(`FUKUBAKO_ID=${FUKUBAKO_ID}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);
  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // ① まず「福箱を買ったことがある user_id」を取得
  //    ※ ここで除外するので「2回目の人には配信されない」
  const boughtSql = buildAlreadyBoughtSQL();
  const bought = await pool.query(boughtSql, [FUKUBAKO_ID]);
  const boughtSet = new Set(bought.rows.map(r => r.user_id).filter(Boolean));
  console.log(`already_bought_users=${boughtSet.size}`);

  // ② segment_blast から「未送信」を取得（最大20000）
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

  const allTargets = rows.map(r => r.user_id).filter(Boolean);
  console.log(`unsent_targets=${allTargets.length}`);

  // ③ 既購入者を除外（福箱用）
  const ids = allTargets.filter(uid => !boughtSet.has(uid));
  console.log(`eligible_targets (exclude bought)=${ids.length}`);

  if (ids.length === 0) {
    console.log("Nothing to send (all unsent are already bought or empty).");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    await pool.end();
    return;
  }

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
