// send_blast_once.js — お試しセット配信用（IDは fukubako-2026 のまま）
// 特徴:
// - 商品IDは変更しない（購入制御は従来どおり）
// - 配信履歴だけ trial 系で分離
// - Cron 実行前提
//
// Run example:
//   SEGMENT_KEY=trial_3d \
//   MESSAGE_FILE=./messages/flex.json \
//   TRIAL_ID=fukubako-2026 \
//   AUTO_ROSTER_3D=1 FIRST_SEEN_DAYS=3 \
//   ONCE_ONLY=1 ONCE_PREFIX=trial \
//   DRY_RUN=0 \
//   node send_blast_once.js
//
// Requires: DATABASE_URL, LINE_CHANNEL_ACCESS_TOKEN

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const SEGMENT_KEY = (process.env.SEGMENT_KEY || "trial_3d").trim();
const TOKEN       = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DBURL       = process.env.DATABASE_URL;

const MESSAGE_FILE = (process.env.MESSAGE_FILE || "./messages/flex.json").trim();
const DRY_RUN      = String(process.env.DRY_RUN || "").trim() === "1";

// 友だち追加からN日後
const AUTO_ROSTER_3D  = String(process.env.AUTO_ROSTER_3D || "").trim() === "1";
const FIRST_SEEN_DAYS = Number(process.env.FIRST_SEEN_DAYS || 3);

// ✅ 商品IDは変更しない
const TRIAL_ID = (process.env.TRIAL_ID || "fukubako-2026").trim();

// 配信は trial として1回のみ
const ONCE_ONLY   = String(process.env.ONCE_ONLY || "1").trim() !== "0";
const ONCE_PREFIX = (process.env.ONCE_PREFIX || "trial").trim(); // trial%

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!TRIAL_ID) throw new Error("TRIAL_ID is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

// -------------------- LINE --------------------
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
}

// -------------------- utils --------------------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function isValidLineUserId(uid) {
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
}

// -------------------- message loader --------------------
function loadMessages() {
  const fp = path.resolve(process.cwd(), MESSAGE_FILE);
  if (!fs.existsSync(fp)) throw new Error(`MESSAGE_FILE not found: ${fp}`);

  const json = JSON.parse(fs.readFileSync(fp, "utf8"));
  const msgs = Array.isArray(json) ? json : json?.messages;

  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error("MESSAGE_FILE format invalid");
  }
  return msgs;
}

// -------------------- SQL builders --------------------

// ✅ 購入済み判定（IDは fukubako-2026 のまま）
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
               WHEN jsonb_typeof(o.items) = 'object'
                    AND jsonb_typeof(o.items->'items') = 'array'
                 THEN o.items->'items'
               ELSE '[]'::jsonb
             END
           ) elem
          WHERE (elem->>'id') = $1
       )
  `;
}

// 過去に trial 配信した人を除外
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
  return new Set(rows.map(r => r.user_id));
}

// 友だち追加からN日経過 → 名簿へ
async function autoRosterByFirstSeen(days) {
  const r = await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, su.user_id, NOW()
      FROM segment_users su
     WHERE su.user_id IS NOT NULL
       AND su.user_id <> ''
       AND su.first_seen <= NOW() - ($2::text || ' days')::interval
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [SEGMENT_KEY, String(days)]
  );
  return r.rowCount || 0;
}

// -------------------- main --------------------
(async () => {
  const messages = loadMessages();

  console.log("=== TRIAL BLAST ===");
  console.log("SEGMENT_KEY =", SEGMENT_KEY);
  console.log("TRIAL_ID    =", TRIAL_ID);
  console.log("ONCE_PREFIX =", ONCE_PREFIX);
  console.log("DRY_RUN     =", DRY_RUN ? 1 : 0);

  if (AUTO_ROSTER_3D) {
    const n = await autoRosterByFirstSeen(FIRST_SEEN_DAYS);
    console.log("roster_inserted =", n);
  }

  // 購入済み除外
  const bought = await pool.query(buildAlreadyBoughtSQL(), [TRIAL_ID]);
  const boughtSet = new Set(bought.rows.map(r => r.user_id));
  console.log("already_bought_users =", boughtSet.size);

  // trial 配信済み除外
  let everSentSet = new Set();
  if (ONCE_ONLY) {
    everSentSet = await loadEverSentSet(ONCE_PREFIX);
    console.log("ever_sent_trial =", everSentSet.size);
  }

  // 未送信抽出
  const { rows } = await pool.query(
    `
    SELECT user_id
      FROM segment_blast
     WHERE segment_key = $1
       AND sent_at IS NULL
     LIMIT 20000
    `,
    [SEGMENT_KEY]
  );

  let targets = rows.map(r => r.user_id);
  targets = targets.filter(uid => !boughtSet.has(uid));
  if (ONCE_ONLY) targets = targets.filter(uid => !everSentSet.has(uid));
  targets = targets.filter(isValidLineUserId);

  console.log("eligible_targets =", targets.length);

  if (targets.length === 0) {
    console.log("Nothing to send.");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN only. not sending.");
    await pool.end();
    return;
  }

  for (const batch of chunk(targets, 500)) {
    await lineMulticast(batch, messages);
    await pool.query(
      `
      UPDATE segment_blast
         SET sent_at = NOW(), last_error = NULL
       WHERE segment_key = $1
         AND user_id = ANY($2::text[])
      `,
      [SEGMENT_KEY, batch]
    );
  }

  console.log("DONE sent =", targets.length);
  await pool.end();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
