// send_address_registered.js
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");

const SEGMENT_KEY = process.env.SEGMENT_KEY || "address_registered";
const MESSAGE_FILE = process.env.MESSAGE_FILE || "./messages/omise_intro.json";
const DRY_RUN = String(process.env.DRY_RUN || "1") === "1";
const BLAST_LIMIT = Number(process.env.BLAST_LIMIT || "50");
const BLAST_OFFSET = Number(process.env.BLAST_OFFSET || "0");
const INCLUDE_BOUGHT = String(process.env.INCLUDE_BOUGHT || "0") === "1";
const SKIP_GLOBAL_EVER_SENT = String(process.env.SKIP_GLOBAL_EVER_SENT || "0") === "1";

function loadMessages(filePath) {
  const full = path.resolve(filePath);
  const raw = fs.readFileSync(full, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function pushLineMessage(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LINE push failed: ${res.status} ${text}`);
  }
}

async function main() {
  const db = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await db.connect();

  try {
    const messages = loadMessages(MESSAGE_FILE);
    console.log(`SEGMENT_KEY=${SEGMENT_KEY}`);
    console.log(`MESSAGE_FILE=${MESSAGE_FILE}`);
    console.log(`DRY_RUN=${DRY_RUN ? 1 : 0}`);
    console.log(`BLAST_LIMIT=${BLAST_LIMIT}`);
    console.log(`BLAST_OFFSET=${BLAST_OFFSET}`);
    console.log(`INCLUDE_BOUGHT=${INCLUDE_BOUGHT ? 1 : 0}`);
    console.log(`SKIP_GLOBAL_EVER_SENT=${SKIP_GLOBAL_EVER_SENT ? 1 : 0}`);
    console.log(`messages_count=${messages.length}, first_type=${messages[0]?.type || "(unknown)"}`);

    const boughtUsersRes = await db.query(`
      select count(distinct user_id) as cnt
      from orders
      where user_id is not null
        and user_id <> ''
        and status in ('confirmed','paid','pickup','shipped','delivered')
    `);
    console.log(`already_bought_users=${boughtUsersRes.rows[0].cnt}`);

    const sameKeySentRes = await db.query(
      `
      select count(*) as cnt
      from segment_users
      where segment_key = $1
        and sent_at is not null
      `,
      [SEGMENT_KEY]
    );
    console.log(`sent_same_key_users=${sameKeySentRes.rows[0].cnt} (segment_key=${SEGMENT_KEY}, sent_at not null)`);

    let everSentExcludedUsers = 0;
    if (!SKIP_GLOBAL_EVER_SENT) {
      const everSentRes = await db.query(`
        select count(distinct user_id) as cnt
        from segment_users
        where sent_at is not null
      `);
      everSentExcludedUsers = Number(everSentRes.rows[0].cnt || 0);
    }
    console.log(`ever_sent_excluded_users=${everSentExcludedUsers} (global all keys)`);

    const rosterRes = await db.query(
      `
      with roster as (
        select distinct su.user_id
        from segment_users su
        where su.segment_key = $1
      ),
      filtered as (
        select r.user_id
        from roster r
        where r.user_id is not null
          and r.user_id <> ''
          and (
            $2::boolean = true
            or not exists (
              select 1
              from orders o
              where o.user_id = r.user_id
                and o.status in ('confirmed','paid','pickup','shipped','delivered')
            )
          )
          and not exists (
            select 1
            from segment_users s2
            where s2.segment_key = $1
              and s2.user_id = r.user_id
              and s2.sent_at is not null
          )
          and (
            $3::boolean = true
            or not exists (
              select 1
              from segment_users s3
              where s3.user_id = r.user_id
                and s3.sent_at is not null
            )
          )
      )
      select user_id
      from filtered
      order by user_id
      offset $4
      limit $5
      `,
      [SEGMENT_KEY, INCLUDE_BOUGHT, SKIP_GLOBAL_EVER_SENT, BLAST_OFFSET, BLAST_LIMIT]
    );

    const rosterTotalRes = await db.query(
      `
      select count(distinct user_id) as cnt
      from segment_users
      where segment_key = $1
      `,
      [SEGMENT_KEY]
    );
    console.log(`roster_total=${rosterTotalRes.rows[0].cnt}`);

    const eligibleTargets = rosterRes.rows.map(r => r.user_id);
    console.log(`eligible_targets=${eligibleTargets.length}`);

    let sent = 0;
    let failed = 0;

    for (const userId of eligibleTargets) {
      try {
        if (DRY_RUN) {
          console.log(`[DRY_RUN] would send to ${userId}`);
          continue;
        }

        await pushLineMessage(userId, messages);

        await db.query(
          `
          update segment_users
          set sent_at = now(),
              updated_at = now()
          where segment_key = $1
            and user_id = $2
          `,
          [SEGMENT_KEY, userId]
        );

        sent += 1;
        console.log(`[OK] sent to ${userId}`);
      } catch (err) {
        failed += 1;
        console.error(`[NG] ${userId}: ${err.message}`);
      }
    }

    console.log(`valid_targets=${eligibleTargets.length}`);
    console.log(`would_send_batches=${Math.ceil(eligibleTargets.length / 500)} (batch_size=500)`);
    console.log(`sent=${sent} failed=${failed}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});