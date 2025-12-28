// send_blast_once.js — コマンドだけで Text/Flex 切替版
// Run:
//   SEGMENT_KEY=... MESSAGE_FILE=... node send_blast_once.js
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

const SEGMENT_KEY = process.env.SEGMENT_KEY || "liff_200_blast_20251223";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL = process.env.DATABASE_URL;
const MESSAGE_FILE = process.env.MESSAGE_FILE || ""; // ここが切替のキー

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");

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

// messages を外部JSONから読み込む（JS固定で切替）
function loadMessages() {
  // MESSAGE_FILE 未指定ならデフォルト（テキスト）
  if (!MESSAGE_FILE) {
    return [
      {
        type: "text",
        text: "（デフォルト）テスト配信です。MESSAGE_FILEを指定すると内容を切替できます。",
      },
    ];
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
      // 必要なら他のtypeも許可してOK。今は安全重視で拒否
      throw new Error(`Unsupported message type: ${type} (allowed: text, flex, image)`);
    }
  }

  return msgs;
}

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

(async () => {
  // ✅ messages を確定（ここでファイル読み込み）
  const messages = loadMessages();
  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE || "(default)"}`);
  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // 未送信だけ取得（最大20000→500ずつ分割）
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
  console.log(`unsent targets=${ids.length}`);

  if (ids.length === 0) {
    console.log("Nothing to send.");
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
