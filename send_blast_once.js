// send_blast_once.js — 福箱向け（未送信 + 未購入者だけ配信）Text/Flex 切替版 + 3日後自動名簿追加
// Run (cron想定):
//   SEGMENT_KEY=fukubako_3d AUTO_ROSTER_3D=1 node send_blast_once.js
//
// 従来どおり手動でもOK:
//   SEGMENT_KEY=... MESSAGE_FILE=... FUKUBAKO_ID=fukubako-2026 node send_blast_once.js
//
// Optional:
//   FUKUBAKO_URL="https://.../fukubako.html"   (Flex内リンク作成に使いたい場合)
//   DRY_RUN=1  (送信せず対象件数だけ表示)
//   AUTO_ROSTER_3D=1  (友だち追加3日後を自動で名簿追加する)
//   FIRST_SEEN_DAYS=3 (デフォルト3日。4にしたければ4)
//   ROSTER_LIMIT=50000 (名簿追加の上限：保険)
//
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SEGMENT_KEY   = process.env.SEGMENT_KEY || "fukubako_3d";
const TOKEN         = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL         = process.env.DATABASE_URL;
const MESSAGE_FILE  = process.env.MESSAGE_FILE || ""; // 外部JSON切替
const DRY_RUN       = String(process.env.DRY_RUN || "").trim() === "1";

// ✅ 友だち追加3日後の名簿追加をこのJSでやる
const AUTO_ROSTER_3D = String(process.env.AUTO_ROSTER_3D || "").trim() === "1";
const FIRST_SEEN_DAYS = Number(process.env.FIRST_SEEN_DAYS || 3);
const ROSTER_LIMIT = Number(process.env.ROSTER_LIMIT || 50000);

// 福箱判定（商品ID）
const FUKUBAKO_ID   = (process.env.FUKUBAKO_ID || "fukubako-2026").trim();
// 使うなら（Flexのリンク埋め込みなど）
const FUKUBAKO_URL  = (process.env.FUKUBAKO_URL || "").trim();

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!FUKUBAKO_ID) throw new Error("FUKUBAKO_ID is required");
if (!SEGMENT_KEY) throw new Error("SEGMENT_KEY is required");
if (!Number.isFinite(FIRST_SEEN_DAYS) || FIRST_SEEN_DAYS <= 0) throw new Error("FIRST_SEEN_DAYS must be a positive number");
if (!Number.isFinite(ROSTER_LIMIT) || ROSTER_LIMIT <= 0) throw new Error("ROSTER_LIMIT must be a positive number");

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
function buildAlreadyBoughtSQL() {
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

// ✅ 友だち追加から N 日経過した人を名簿（segment_blast）へ追加
async function backfillRosterByFirstSeenDays() {
  // segment_users.first_seen がある前提（あなたのSQLと同じ）
  // 既に segment_blast に存在する人は ON CONFLICT で無視
  const sql = `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, su.user_id, NOW()
      FROM segment_users su
     WHERE su.user_id IS NOT NULL
       AND su.user_id <> ''
       AND su.first_seen <= NOW() - ($2 || ' days')::interval
    ON CONFLICT (segment_key, user_id) DO NOTHING
  `;

  // 上限（爆増保険）: 追加件数を見たいので、追加前に候補数を数える
  const cnt = await pool.query(
    `
    SELECT COUNT(*)::int AS n
      FROM segment_users su
     WHERE su.user_id IS NOT NULL
       AND su.user_id <> ''
       AND su.first_seen <= NOW() - ($1 || ' days')::interval
    `,
    [String(FIRST_SEEN_DAYS)]
  );

  const n = cnt.rows?.[0]?.n ?? 0;
  console.log(`roster_candidates_by_first_seen=${n} (days=${FIRST_SEEN_DAYS})`);

  if (n > ROSTER_LIMIT) {
    throw new Error(`Roster candidates too many: ${n} > ROSTER_LIMIT=${ROSTER_LIMIT} (safety stop)`);
  }

  const r = await pool.query(sql, [SEGMENT_KEY, String(FIRST_SEEN_DAYS)]);
  // pg は INSERT の件数を rowCount で返す
  console.log(`roster_inserted=${r.rowCount} (segment_key=${SEGMENT_KEY})`);
}

(async () => {
  const messages = loadMessages();

  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE || "(default)"}`);
  console.log(`FUKUBAKO_ID=${FUKUBAKO_ID}`);
  console.log(`FUKUBAKO_URL=${FUKUBAKO_URL || "(none)"}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);
  console.log(`AUTO_ROSTER_3D=${AUTO_ROSTER_3D ? "1" : "0"} FIRST_SEEN_DAYS=${FIRST_SEEN_DAYS}`);
  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);

  // 0) ✅ 先に名簿追加（必要なときだけ）
  if (AUTO_ROSTER_3D) {
    await backfillRosterByFirstSeenDays();
  }

  // ① まず「福箱を買ったことがある user_id」を取得
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

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`DONE sent=${sent} failed=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
