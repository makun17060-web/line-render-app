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
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
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

    const rosterTotalRes = await db.query(
      `
      select count(distinct user_id) as cnt
      from segment_users
      where segment_key = $1
      `,
      [SEGMENT_KEY]
    );
    console.log(`roster_total=${rosterTotalRes.rows[0].cnt}`);

    const rosterRes = await db.query(
      `
      with roster as (
        select distinct su.user_id
        from segment_users su
        where su.segment_key = $1
      )
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
      order by r.user_id
      offset $3
      limit $4
      `,
      [SEGMENT_KEY, INCLUDE_BOUGHT, BLAST_OFFSET, BLAST_LIMIT]
    );

    const eligibleTargets = rosterRes.rows.map(r => r.user_id);
    console.log(`eligible_targets=${eligibleTargets.length}`);
    console.log(`valid_targets=${eligibleTargets.length}`);
    console.log(`invalid_targets=0`);
    console.log(`would_send_batches=${Math.ceil(eligibleTargets.length / 500)} (batch_size=500)`);

    let sent = 0;
    let failed = 0;

    for (const userId of eligibleTargets) {
      try {
        if (DRY_RUN) {
          console.log(`[DRY_RUN] would send to ${userId}`);
          continue;
        }

        await pushLineMessage(userId, messages);
        sent += 1;
        console.log(`[OK] sent to ${userId}`);
      } catch (err) {
        failed += 1;
        console.error(`[NG] ${userId}: ${err.message}`);
      }
    }

    console.log(`sent=${sent} failed=${failed}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});