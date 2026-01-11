// send_blast_once.js — 福箱向け（名簿自動追加 + 未送信 + 未購入 + 「一人1回のみ」永久除外）Text/Flex 切替版
// Run:
//   SEGMENT_KEY=... MESSAGE_FILE=... FUKUBAKO_ID=fukubako-2026 node send_blast_once.js
// Optional:
//   FUKUBAKO_URL="https://.../fukubako.html"   (Flex内リンク作成に使いたい場合)
//   DRY_RUN=1  (送信せず対象件数だけ表示)
//   AUTO_ROSTER_3D=1 FIRST_SEEN_DAYS=3  (3日経過した友だちを名簿に入れる)
//   ONCE_ONLY=1  (デフォルト1。fukubako%に sent_at が1回でもあれば永久除外＝再送なし)
//   ONCE_PREFIX=fukubako  (デフォルトfukubako。過去送信の判定に使うプレフィックス)
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

const SEGMENT_KEY   = (process.env.SEGMENT_KEY || "fukubako_3d").trim();
const TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL         = process.env.DATABASE_URL;

const MESSAGE_FILE  = (process.env.MESSAGE_FILE || "./messages/flex.json").trim(); // 既定：flex.json
const DRY_RUN       = String(process.env.DRY_RUN || "").trim() === "1";

const AUTO_ROSTER_3D = String(process.env.AUTO_ROSTER_3D || "").trim() === "1";
const FIRST_SEEN_DAYS = Number(process.env.FIRST_SEEN_DAYS || 3);

const FUKUBAKO_ID   = (process.env.FUKUBAKO_ID || "fukubako-2026").trim();
const FUKUBAKO_URL  = (process.env.FUKUBAKO_URL || "").trim();

// ✅ 一人1回のみ（再送なし）
// - デフォルトON（ONCE_ONLY=1）
const ONCE_ONLY = String(process.env.ONCE_ONLY || "1").trim() !== "0";
const ONCE_PREFIX = (process.env.ONCE_PREFIX || "fukubako").trim(); // fukubako%

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!FUKUBAKO_ID) throw new Error("FUKUBAKO_ID is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

// Node 18+ は fetch あり。無い環境なら node-fetch を入れる必要あり。
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

function mustString(x, name) {
  if (typeof x !== "string" || x.trim() === "") throw new Error(`${name} must be a non-empty string`);
  return x.trim();
}

// ✅ LINE userId 妥当性チェック（事故防止）
function isValidLineUserId(uid) {
  // LINE userId は通常 "U" + 32桁hex（計33文字）
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
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

// ✅ 福箱購入済み判定（orders.items が jsonb）
// - items が配列: [{id, qty, ...}, ...] でも
// - items がオブジェクト: {items:[{id..}], ...} でも
// 両方拾えるようにする
function buildAlreadyBoughtSQL() {
  return `
    SELECT DISTINCT o.user_id
      FROM orders o
     WHERE o.user_id IS NOT NULL
       AND o.user_id <> ''
       AND EXISTS (
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
  `;
}

// ✅ 「福箱を過去に1回でも送った人」永久除外（再送なし）
async function loadEverSentSet(prefix) {
  const { rows } = await pool.query(
    `
    SELECT DISTINCT user_id
      FROM segment_blast
     WHERE user_id IS NOT NULL
       AND user_id <> ''
       AND segment_key ILIKE $1
       AND sent_at IS NOT NULL
    `,
    [`${prefix}%`]
  );
  return new Set(rows.map(r => r.user_id).filter(Boolean));
}

// ✅ 3日経過した友だちを名簿に入れる（送信は別）
async function autoRosterByFirstSeen(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`FIRST_SEEN_DAYS invalid: ${days}`);

  // segment_users.first_seen を基準に、未追加の人だけ segment_blast に入れる
  const r = await pool.query(
    `
    WITH cand AS (
      SELECT su.user_id
      FROM segment_users su
      WHERE su.user_id IS NOT NULL
        AND su.user_id <> ''
        AND su.first_seen <= NOW() - ($2::text || ' days')::interval
    )
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, c.user_id, NOW()
    FROM cand c
    ON CONFLICT (segment_key, user_id) DO NOTHING
    RETURNING user_id
    `,
    [SEGMENT_KEY, String(d)]
  );

  return r.rowCount || 0;
}

(async () => {
  const messages = loadMessages();

  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE || "(default)"}`);
  console.log(`FUKUBAKO_ID=${FUKUBAKO_ID}`);
  console.log(`FUKUBAKO_URL=${FUKUBAKO_URL || "(none)"}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);

  console.log(`AUTO_ROSTER_3D=${AUTO_ROSTER_3D ? "1" : "0"} FIRST_SEEN_DAYS=${FIRST_SEEN_DAYS}`);
  console.log(`ONCE_ONLY=${ONCE_ONLY ? "1" : "0"} ONCE_PREFIX=${ONCE_PREFIX}`);
  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // 0) AUTO_ROSTER（3日経過を名簿へ）
  if (AUTO_ROSTER_3D) {
    const cand = await pool.query(
      `SELECT COUNT(*)::int AS n FROM segment_users su WHERE su.first_seen <= NOW() - ($1::text || ' days')::interval`,
      [String(FIRST_SEEN_DAYS)]
    );
    console.log(`roster_candidates_by_first_seen=${cand.rows?.[0]?.n ?? "?"} (days=${FIRST_SEEN_DAYS})`);

    const inserted = await autoRosterByFirstSeen(FIRST_SEEN_DAYS);
    console.log(`roster_inserted=${inserted} (segment_key=${SEGMENT_KEY})`);
  }

  // 1) 福箱購入済み user を取得（除外用）
  const boughtSql = buildAlreadyBoughtSQL();
  const bought = await pool.query(boughtSql, [FUKUBAKO_ID]);
  const boughtSet = new Set(bought.rows.map(r => r.user_id).filter(Boolean));
  console.log(`already_bought_users=${boughtSet.size}`);

  // 2) 一人1回のみ：過去に福箱（ONCE_PREFIX%）を送った user を取得（永久除外）
  let everSentSet = new Set();
  if (ONCE_ONLY) {
    everSentSet = await loadEverSentSet(ONCE_PREFIX);
    console.log(`ever_sent_excluded_users=${everSentSet.size}`);
  }

  // 3) segment_blast から「未送信」を取得（最大20000）
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

  // 4) 既購入者・既送信者（永久）を除外
  let ids = allTargets.filter(uid => !boughtSet.has(uid));
  if (ONCE_ONLY) ids = ids.filter(uid => !everSentSet.has(uid));

  // 5) 不正userId（TEST_USERなど）を除外して落ちないようにする
  const invalid = ids.filter(uid => !isValidLineUserId(String(uid).trim()));
  const valid = ids.filter(uid => isValidLineUserId(String(uid).trim()));

  console.log(`eligible_targets (exclude bought${ONCE_ONLY ? " + ever_sent" : ""})=${ids.length}`);
  console.log(`valid_targets=${valid.length} invalid_targets=${invalid.length}`);
  if (invalid.length) {
    console.log(`invalid_sample=${invalid.slice(0, 5).join(",")}`);

    // DBに記録（次回以降も原因追跡できる）
    await pool.query(
      `
      UPDATE segment_blast
         SET last_error = $3
       WHERE segment_key = $1
         AND user_id = ANY($2::text[])
      `,
      [SEGMENT_KEY, invalid, "INVALID_LINE_USER_ID (filtered before multicast)"]
    );
  }

  if (valid.length === 0) {
    console.log("Nothing to send (no valid targets after filters).");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    await pool.end();
    return;
  }

  const batches = chunk(valid, 500); // multicastは最大500
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
