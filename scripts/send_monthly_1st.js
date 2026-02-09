#!/usr/bin/env node
/**
 * send_monthly_1st.js（@line/bot-sdk 旧式 Client 対応 + Postgres型エラー回避版）
 *
 * 毎月1日 定期配信（友だち追加から21日以上）
 * - 直近24hに何か送ってたらスキップ（簡易ガード）
 * - DRY_RUN対応
 * - LIMIT対応
 *
 * 必要ENV:
 *   DATABASE_URL
 *   LINE_CHANNEL_ACCESS_TOKEN
 *
 * 任意ENV:
 *   DRY_RUN=1|0 (default 1)
 *   LIMIT=20000
 *   MIN_FOLLOW_DAYS=21
 *   COOLDOWN_HOURS=24
 *   MESSAGE_FILE=./messages/monthly_1st.txt
 *   NOTIFIED_KIND=monthly_1st
 *   PRIORITY=10
 *   ONLY_OPENERS=1|0 (default 0)
 *   OPENED_WITHIN_DAYS=365
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const line = require("@line/bot-sdk");

const DRY_RUN = String(process.env.DRY_RUN ?? "1") === "1";
const LIMIT = Number(process.env.LIMIT ?? 20000);
const MIN_FOLLOW_DAYS = Number(process.env.MIN_FOLLOW_DAYS ?? 21);
const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS ?? 24);

const MESSAGE_FILE = process.env.MESSAGE_FILE ?? "./messages/monthly_1st.txt";
const NOTIFIED_KIND = process.env.NOTIFIED_KIND ?? "monthly_1st";
const PRIORITY = Number(process.env.PRIORITY ?? 10);

const ONLY_OPENERS = String(process.env.ONLY_OPENERS ?? "0") === "1";
const OPENED_WITHIN_DAYS = Number(process.env.OPENED_WITHIN_DAYS ?? 365);

const DATABASE_URL = process.env.DATABASE_URL;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required");
  process.exit(1);
}
if (!LINE_CHANNEL_ACCESS_TOKEN) {
  console.error("ERROR: LINE_CHANNEL_ACCESS_TOKEN is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false },
});

// ✅ 旧式 @line/bot-sdk: new line.Client({ channelAccessToken })
const lineClient = new line.Client({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

function resolveTextMessage(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, "utf8").trim();
  if (!text) throw new Error(`MESSAGE_FILE is empty: ${filePath}`);
  return { type: "text", text };
}

async function ensureSendLogTable() {
  const sql = `
  CREATE TABLE IF NOT EXISTS message_send_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 10,
    segment_key TEXT NULL,
    order_id BIGINT NULL,
    message_file TEXT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS message_send_logs_user_sent_at_idx
    ON message_send_logs (user_id, sent_at DESC);
  `;
  await pool.query(sql);
}

async function sentWithinCooldown(userId) {
  const q = `
    SELECT sent_at, kind
    FROM message_send_logs
    WHERE user_id = $1
    ORDER BY sent_at DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [userId]);
  if (rows.length === 0) return { ok: true, last: null };

  const last = rows[0];
  const lastTs = new Date(last.sent_at).getTime();
  const now = Date.now();
  const diffMs = now - lastTs;
  const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;

  if (diffMs < cooldownMs) {
    return { ok: false, last };
  }
  return { ok: true, last };
}

async function logSent({ userId }) {
  const q = `
    INSERT INTO message_send_logs (user_id, kind, priority, message_file)
    VALUES ($1, $2, $3, $4)
  `;
  await pool.query(q, [userId, NOTIFIED_KIND, PRIORITY, MESSAGE_FILE]);
}

/**
 * 対象抽出：
 * - follow_events の最新followed_at（ユーザーごと）
 * - followed_at から MIN_FOLLOW_DAYS 以上経過
 * - ONLY_OPENERS=1 の場合は liff_open_logs を直近OPENED_WITHIN_DAYSで起動した人だけ
 *
 * ✅ Postgresの型推論エラー(42P18)を避けるため、
 *    intervalの生成は「param::int * interval '1 day'」方式に統一。
 */
async function fetchTargets() {
  // ✅ ONLY_OPENERS=0 の場合は OPENED_WITHIN_DAYS を params に入れない
  // （未使用パラメータがあると Postgres が型推論できず 42P18 になる）

  if (!ONLY_OPENERS) {
    const params = [];
    let p = 1;

    params.push(MIN_FOLLOW_DAYS);
    const minFollowParam = `$${p++}`;

    params.push(LIMIT);
    const limitParam = `$${p++}`;

    const sql = `
      WITH latest_follow AS (
        SELECT DISTINCT ON (user_id)
          user_id,
          followed_at
        FROM follow_events
        WHERE followed_at IS NOT NULL
        ORDER BY user_id, followed_at DESC
      )
      SELECT
        fe.user_id,
        fe.followed_at
      FROM latest_follow fe
      WHERE fe.followed_at <= now() - (${minFollowParam}::int * interval '1 day')
      ORDER BY fe.followed_at ASC
      LIMIT ${limitParam}::int;
    `;

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  // ✅ ONLY_OPENERS=1 の場合（$2をちゃんとSQLで使う）
  {
    const params = [];
    let p = 1;

    params.push(MIN_FOLLOW_DAYS);
    const minFollowParam = `$${p++}`;

    params.push(OPENED_WITHIN_DAYS);
    const openedWithinParam = `$${p++}`;

    params.push(LIMIT);
    const limitParam = `$${p++}`;

    const sql = `
      WITH latest_follow AS (
        SELECT DISTINCT ON (user_id)
          user_id,
          followed_at
        FROM follow_events
        WHERE followed_at IS NOT NULL
        ORDER BY user_id, followed_at DESC
      ),
      openers AS (
        SELECT DISTINCT user_id
        FROM liff_open_logs
        WHERE opened_at >= now() - (${openedWithinParam}::int * interval '1 day')
      )
      SELECT
        fe.user_id,
        fe.followed_at
      FROM latest_follow fe
      INNER JOIN openers op ON op.user_id = fe.user_id
      WHERE fe.followed_at <= now() - (${minFollowParam}::int * interval '1 day')
      ORDER BY fe.followed_at ASC
      LIMIT ${limitParam}::int;
    `;

    const { rows } = await pool.query(sql, params);
    return rows;
  }
}

async function main() {
  console.log("=== send_monthly_1st ===");
  console.log("DRY_RUN=", DRY_RUN ? 1 : 0);
  console.log("MIN_FOLLOW_DAYS=", MIN_FOLLOW_DAYS);
  console.log("ONLY_OPENERS=", ONLY_OPENERS ? 1 : 0, "OPENED_WITHIN_DAYS=", OPENED_WITHIN_DAYS);
  console.log("COOLDOWN_HOURS=", COOLDOWN_HOURS);
  console.log("LIMIT=", LIMIT);
  console.log("NOTIFIED_KIND=", NOTIFIED_KIND, "PRIORITY=", PRIORITY);
  console.log("MESSAGE_FILE=", MESSAGE_FILE);

  await ensureSendLogTable();

  const msg = resolveTextMessage(MESSAGE_FILE);
  const targets = await fetchTargets();

  console.log("targets=", targets.length);

  let wouldSend = 0;
  let sent = 0;
  let skippedCooldown = 0;
  let failed = 0;

  for (const t of targets) {
    const userId = t.user_id;

    const g = await sentWithinCooldown(userId);
    if (!g.ok) {
      skippedCooldown++;
      continue;
    }

    if (DRY_RUN) {
      wouldSend++;
      continue;
    }

    try {
      // ✅ 旧式 pushMessage(to, messages)
      await lineClient.pushMessage(userId, [msg]);

      await logSent({ userId });
      sent++;
    } catch (e) {
      failed++;
      console.error("push failed:", userId, e?.message ?? e);
    }
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=1 so not sending.");
    console.log("wouldSend=", wouldSend, "skippedCooldown=", skippedCooldown);
  } else {
    console.log("DONE sent=", sent, "skippedCooldown=", skippedCooldown, "failed=", failed);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
