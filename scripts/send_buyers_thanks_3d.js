/**
 * scripts/send_buyers_thanks_3d.js  — 購入後3日「お礼」専用（丸ごと版）
 *
 * ✅ 目的（このJSはこれだけやる）
 *  1) orders から「購入3日後」の user_id を抽出（paid/confirmed/pickup）
 *  2) segment_blast に台帳行を作る（segment_key = buyers_thanks_3d）
 *  3) 未送信（sent_at IS NULL）だけに送る
 *  4) 成功→sent_at更新 / 失敗→last_error更新
 *
 * ✅ “やらないこと”
 *  - 未購入除外（bought除外）しない
 *  - ever_sent(global) 除外しない
 *  - AUTO_ROSTER しない
 *  - segment_users を触らない
 *
 * -----
 * 必須ENV:
 *   DATABASE_URL
 *   LINE_CHANNEL_ACCESS_TOKEN
 *
 * 任意ENV:
 *   SEGMENT_KEY=buyers_thanks_3d        (既定)
 *   MESSAGE_FILE=./messages/buyers_thanks_3d.json  (既定)
 *   DRY_RUN=1                          (送信しないで件数だけ)
 *   WINDOW_START_DAYS=4                (既定: 4日前から)
 *   WINDOW_END_DAYS=3                  (既定: 3日前まで)
 *   LIMIT=20000                        (既定)
 *   BATCH_SIZE=500                     (既定: LINE multicast上限)
 *   SLEEP_MS=200                       (既定: レート対策)
 *   FORCE_USER_ID=Uxxxxxxxx...          (この人だけ送る・テスト用。抽出/台帳/窓条件を無視)
 *
 * 実行例（Render / Linux）:
 *   node scripts/send_buyers_thanks_3d.js
 *
 * DRY RUN:
 *   DRY_RUN=1 node scripts/send_buyers_thanks_3d.js
 *
 * ローカル（PowerShell）:
 *   $env:DRY_RUN="1"; node scripts/send_buyers_thanks_3d.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const DBURL = (process.env.DATABASE_URL || "").trim();

const SEGMENT_KEY = (process.env.SEGMENT_KEY || "buyers_thanks_3d").trim();
const MESSAGE_FILE = (process.env.MESSAGE_FILE || "./messages/buyers_thanks_3d.json").trim();

const DRY_RUN = String(process.env.DRY_RUN || "").trim() === "1";

const WINDOW_START_DAYS = Number(process.env.WINDOW_START_DAYS || 4); // 4日前
const WINDOW_END_DAYS = Number(process.env.WINDOW_END_DAYS || 3);     // 3日前
const LIMIT = Number(process.env.LIMIT || 20000);

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 500);
const SLEEP_MS = Number(process.env.SLEEP_MS || 200);

const FORCE_USER_ID = (process.env.FORCE_USER_ID || "").trim();

if (!TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
if (!DBURL) throw new Error("DATABASE_URL is required");
if (!SEGMENT_KEY) throw new Error("SEGMENT_KEY is required");
if (!MESSAGE_FILE) throw new Error("MESSAGE_FILE is required");

const pool = new Pool({
  connectionString: DBURL,
  ssl: { rejectUnauthorized: false },
});

// Node 18+ なら fetch あり
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

function isValidLineUserId(uid) {
  return typeof uid === "string" && /^U[0-9a-f]{32}$/i.test(uid.trim());
}

// MESSAGE_FILE（配列 or {messages:[]}）を読み込んで返す
function loadMessages() {
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

// 購入3日後の候補 user_id を抽出
async function loadBuyerIdsByWindow(startDays, endDays, limit) {
  if (!(Number.isFinite(startDays) && startDays > 0)) throw new Error(`WINDOW_START_DAYS invalid: ${startDays}`);
  if (!(Number.isFinite(endDays) && endDays >= 0)) throw new Error(`WINDOW_END_DAYS invalid: ${endDays}`);
  if (startDays <= endDays) throw new Error(`WINDOW_START_DAYS must be > WINDOW_END_DAYS (start=${startDays}, end=${endDays})`);

  const sql = `
    SELECT DISTINCT o.user_id
    FROM orders o
    WHERE o.user_id IS NOT NULL
      AND o.user_id <> ''
      AND o.status IN ('paid','confirmed','pickup')
      AND o.created_at >= NOW() - ($1::text || ' days')::interval
      AND o.created_at <  NOW() - ($2::text || ' days')::interval
    ORDER BY o.user_id
    LIMIT $3
  `;

  const { rows } = await pool.query(sql, [String(startDays), String(endDays), limit]);
  return rows.map(r => r.user_id).filter(Boolean);
}

// 台帳行を作る（未送信管理）
async function ensureBlastRows(segmentKey, userIds) {
  if (!userIds || userIds.length === 0) return 0;

  const { rowCount } = await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    SELECT $1, x, NOW()
    FROM unnest($2::text[]) AS x
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [segmentKey, userIds]
  );

  return rowCount || 0;
}

// 未送信ターゲットを台帳から取得
async function loadUnsentTargets(segmentKey, limit) {
  const { rows } = await pool.query(
    `
    SELECT user_id
    FROM segment_blast
    WHERE segment_key = $1
      AND sent_at IS NULL
    ORDER BY user_id
    LIMIT $2
    `,
    [segmentKey, limit]
  );

  return rows.map(r => r.user_id).filter(Boolean);
}

// 送信結果更新（成功）
async function markSent(segmentKey, userIds) {
  if (!userIds || userIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `
    UPDATE segment_blast
       SET sent_at = NOW(), last_error = NULL
     WHERE segment_key = $1
       AND user_id = ANY($2::text[])
    `,
    [segmentKey, userIds]
  );
  return rowCount || 0;
}

// 送信結果更新（失敗）
async function markFailed(segmentKey, userIds, errMsg) {
  if (!userIds || userIds.length === 0) return 0;
  const msg = String(errMsg || "SEND_FAILED").slice(0, 500);

  const { rowCount } = await pool.query(
    `
    UPDATE segment_blast
       SET last_error = $3
     WHERE segment_key = $1
       AND user_id = ANY($2::text[])
    `,
    [segmentKey, userIds, msg]
  );
  return rowCount || 0;
}

// FORCE_USER_ID 用：台帳を必ず作って送る（テスト用）
async function ensureRowIfMissing(segmentKey, userId) {
  await pool.query(
    `
    INSERT INTO segment_blast (segment_key, user_id, created_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (segment_key, user_id) DO NOTHING
    `,
    [segmentKey, userId]
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  const messages = loadMessages();

  console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
  console.log(`MESSAGE_FILE=${MESSAGE_FILE}`);
  console.log(`DRY_RUN=${DRY_RUN ? "1" : "0"}`);
  console.log(`WINDOW_START_DAYS=${WINDOW_START_DAYS} WINDOW_END_DAYS=${WINDOW_END_DAYS}`);
  console.log(`LIMIT=${LIMIT} BATCH_SIZE=${BATCH_SIZE} SLEEP_MS=${SLEEP_MS}`);
  console.log(`FORCE_USER_ID=${FORCE_USER_ID || "(none)"}`);
  console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type}`);
  console.log();

  // 0) FORCEモード（この人だけ送る）
  if (FORCE_USER_ID) {
    if (!isValidLineUserId(FORCE_USER_ID)) throw new Error(`FORCE_USER_ID invalid: ${FORCE_USER_ID}`);

    console.log("=== FORCE MODE ===");
    console.log(`force_targets=1 (${FORCE_USER_ID})`);

    await ensureRowIfMissing(SEGMENT_KEY, FORCE_USER_ID);

    if (DRY_RUN) {
      console.log("DRY_RUN=1 so not sending (FORCE MODE).");
      await pool.end();
      return;
    }

    try {
      await lineMulticast([FORCE_USER_ID], messages);
      await markSent(SEGMENT_KEY, [FORCE_USER_ID]);
      console.log("OK force send: 1");
    } catch (e) {
      await markFailed(SEGMENT_KEY, [FORCE_USER_ID], e?.message || e);
      console.error("NG force send:", e?.message || e);
      throw e;
    }

    await pool.end();
    return;
  }

  // 1) orders から「購入3日後」候補を抽出
  const buyerIds = await loadBuyerIdsByWindow(WINDOW_START_DAYS, WINDOW_END_DAYS, LIMIT);
  console.log(`buyer_candidates=${buyerIds.length} (orders window)`);

  // 2) 台帳行を作る（未送信管理）
  const created = await ensureBlastRows(SEGMENT_KEY, buyerIds);
  console.log(`segment_blast_rows_created=${created} (if missing)`);

  // 3) 台帳から未送信だけ取得
  const unsent = await loadUnsentTargets(SEGMENT_KEY, LIMIT);
  console.log(`unsent_targets=${unsent.length}`);

  // 4) userId妥当性で分ける
  const invalid = unsent.filter(uid => !isValidLineUserId(String(uid).trim()));
  const valid = unsent.filter(uid => isValidLineUserId(String(uid).trim()));

  console.log(`valid_targets=${valid.length} invalid_targets=${invalid.length}`);
  console.log(`would_send_batches=${Math.ceil(valid.length / BATCH_SIZE)} (batch_size=${BATCH_SIZE})`);
  console.log();

  // invalid は last_error を残して台帳更新
  if (invalid.length) {
    console.log(`invalid_sample=${invalid.slice(0, 5).join(",")}`);
    await markFailed(SEGMENT_KEY, invalid, "INVALID_LINE_USER_ID (filtered before multicast)");
  }

  if (valid.length === 0) {
    console.log("Nothing to send (no valid targets).");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    await pool.end();
    return;
  }

  // 5) 送信（multicast 500件ずつ）
  const batches = chunk(valid, BATCH_SIZE);
  let sent = 0;
  let failed = 0;

  for (const part of batches) {
    try {
      await lineMulticast(part, messages);
      await markSent(SEGMENT_KEY, part);
      sent += part.length;
      console.log(`OK batch: ${part.length} (total sent=${sent})`);
    } catch (e) {
      failed += part.length;
      console.error(`NG batch: ${part.length}`, e?.message || e);
      await markFailed(SEGMENT_KEY, part, e?.message || e);
    }

    await sleep(SLEEP_MS);
  }

  console.log(`DONE sent=${sent} failed=${failed}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
