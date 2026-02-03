/**
 * prepare_buyers_30d_roster.js
 *
 * - SEGMENT_KEY（例: buyers_30d_2026-01-04）を受け取る
 * - その日付(JST)に購入したユーザーを抽出
 * - user_segments に名簿投入（重複は NOT EXISTS で回避）
 * - segment_blast に送信対象の器を作成（sent_at=NULL）
 */

import pg from "pg";
const { Pool } = pg;

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const pool = new Pool({
  connectionString: must("DATABASE_URL"),
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

const SEGMENT_KEY = must("SEGMENT_KEY");

async function main() {
  const m = SEGMENT_KEY.match(/buyers_30d_(\d{4}-\d{2}-\d{2})/);
  if (!m) throw new Error(`SEGMENT_KEY format invalid: ${SEGMENT_KEY}`);
  const targetDate = m[1]; // 'YYYY-MM-DD' (JSTの購入日)

  // 1) user_segments 名簿投入
  const sqlRoster = `
    INSERT INTO user_segments (segment_key, user_id, added_at, source, candidate_since, updated_at)
    SELECT
      $1::text AS segment_key,
      o.user_id,
      CURRENT_TIMESTAMP AS added_at,
      'buyers_30d'      AS source,
      CURRENT_TIMESTAMP AS candidate_since,
      CURRENT_TIMESTAMP AS updated_at
    FROM (
      SELECT DISTINCT user_id
      FROM orders
      WHERE created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Tokyo')
        AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo')
    ) o
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_segments us
      WHERE us.segment_key = $1::text
        AND us.user_id = o.user_id
    );
  `;
  const r1 = await pool.query(sqlRoster, [SEGMENT_KEY, targetDate]);

  // 2) segment_blast 器投入（sent_at=NULL / last_error=NULL）
  const sqlBlast = `
    INSERT INTO segment_blast (segment_key, user_id, created_at, sent_at, last_error)
    SELECT
      $1::text AS segment_key,
      us.user_id,
      CURRENT_TIMESTAMP AS created_at,
      NULL::timestamptz AS sent_at,
      NULL::text AS last_error
    FROM user_segments us
    WHERE us.segment_key = $1::text
      AND NOT EXISTS (
        SELECT 1
        FROM segment_blast sb
        WHERE sb.segment_key = $1::text
          AND sb.user_id = us.user_id
      );
  `;
  const r2 = await pool.query(sqlBlast, [SEGMENT_KEY]);

  // 3) カウント表示
  const c1 = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM user_segments WHERE segment_key=$1`,
    [SEGMENT_KEY]
  );
  const c2 = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM segment_blast WHERE segment_key=$1`,
    [SEGMENT_KEY]
  );
  const c3 = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM segment_blast WHERE segment_key=$1 AND sent_at IS NULL`,
    [SEGMENT_KEY]
  );

  console.log("[prepare_buyers_30d_roster] SEGMENT_KEY=", SEGMENT_KEY);
  console.log("[prepare_buyers_30d_roster] inserted user_segments rows=", r1.rowCount);
  console.log("[prepare_buyers_30d_roster] inserted segment_blast rows=", r2.rowCount);
  console.log("[prepare_buyers_30d_roster] roster_count(user_segments)=", c1.rows[0].cnt);
  console.log("[prepare_buyers_30d_roster] blast_total(segment_blast)=", c2.rows[0].cnt);
  console.log("[prepare_buyers_30d_roster] blast_unsent(sent_at is null)=", c3.rows[0].cnt);
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("[prepare_buyers_30d_roster] ERROR:", e?.message || e);
    try { await pool.end(); } catch {}
    process.exit(1);
  });
