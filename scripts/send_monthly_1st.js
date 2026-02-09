#!/usr/bin/env node
/**
 * send_monthly_1st.js
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
 *   ONLY_OPENERS=1|0 (default 0)  ※起動者だけにしたいなら1
 *   OPENED_WITHIN_DAYS=365        ※起動者の定義（直近N日でLIFF起動）
 *
 *   TZはRender/cron側で合わせる（ここはDBのnow()を使う）
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

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

function resolveTextMessage(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(abs, "utf8").trim();
  if (!text) throw new Error(`MESSAGE_FILE is empty: ${filePath}`);
  return { type: "text", text };
}

async function ensureSendLogTable() {
  // 24hガード用の共通ログ（なければ作る）
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
 * - follow_events がある前提（あなたのDBには存在してる）
 * - 友だち追加（followed_at）から MIN_FOLLOW_DAYS 以上経過
 * - ONLY_OPENERS=1 の場合は liff_open_logs にも存在するユーザーだけ
 */
async function fetchTargets() {
  const params = [];
  let p = 1;

  // MIN_FOLLOW_DAYS
  params.push(MIN_FOLLOW_DAYS);
  const minFollowParam = `$${p++}`;

  // OPENED_WITHIN_DAYS
  params.push(OPENED_WITHIN_DAYS);
  const openedWithinParam = `$${p++}`;

  // LIMIT
  params.push(LIMIT);
  const limitParam = `$${p++}`;

  const openerJoin = ONLY_OPENERS
    ? `
      INNER JOIN (
        SELECT DISTINCT user_id
        FROM liff_open_logs
        WHERE opened_at >= now() - (${openedWithinParam} || ' days')::interval
      ) op ON op.user_id = fe.user_id
    `
    : "";

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
    ${openerJoin}
    WHERE fe.followed_at <= now() - (${minFollowParam} || ' days')::interval
    ORDER BY fe.followed_at ASC
    LIMIT ${limitParam};
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
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

  let sent = 0;
  let skippedCooldown = 0;
  let failed = 0;

  for (const t of targets) {
    const userId = t.user_id;

    // 24hガード
    const g = await sentWithinCooldown(userId);
    if (!g.ok) {
      skippedCooldown++;
      continue;
    }

    if (DRY_RUN) {
      sent++;
      continue;
    }

    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [msg],
      });

      await logSent({ userId });
      sent++;
    } catch (e) {
      failed++;
      console.error("push failed:", userId, e?.message ?? e);
    }
  }

  console.log("DONE sent=", sent, "skippedCooldown=", skippedCooldown, "failed=", failed);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
