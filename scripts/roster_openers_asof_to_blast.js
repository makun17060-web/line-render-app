#!/usr/bin/env node
/**
 * 3/20時点（ASOF未満）の起動者を「segment_blast」に名簿として投入する
 *
 * env:
 *   DATABASE_URL (required)
 *   SEGMENT_KEY  (required) 例: ohanami_2026_openers_0320
 *   ASOF_ISO     (optional) 例: 2026-03-21T00:00:00+09:00  ※この時刻「未満」
 */
'use strict';

const { Pool } = require('pg');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

(async () => {
  const databaseUrl = mustEnv('DATABASE_URL');
  const segmentKey = mustEnv('SEGMENT_KEY');
  const asofIso = process.env.ASOF_ISO || '2026-03-21T00:00:00+09:00';

  const asof = new Date(asofIso);
  if (Number.isNaN(asof.getTime())) {
    console.error(`❌ invalid ASOF_ISO: ${asofIso}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // 起動者母数（重複なし）
    const base = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) AS cnt
      FROM public.liff_open_logs
      WHERE opened_at < $1
      `,
      [asof]
    );
    const baseCnt = Number(base.rows?.[0]?.cnt || 0);

    // 名簿投入：segment_blast に入れる
    // sent_at は null のまま（未送信）
    // 既に入ってる user は重複投入しない（ユニーク制約がある前提。無ければ後でNOT EXISTS版にする）
    const ins = await pool.query(
      `
      INSERT INTO public.segment_blast (segment_key, user_id)
      SELECT $2 AS segment_key, t.user_id
      FROM (
        SELECT DISTINCT user_id
        FROM public.liff_open_logs
        WHERE opened_at < $1
      ) t
      ON CONFLICT DO NOTHING
      RETURNING user_id
      `,
      [asof, segmentKey]
    );

    const inserted = ins.rowCount || 0;

    // 現在の名簿サイズ（segment_blast の件数）
    const nowSize = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE sent_at IS NULL)::int AS unsent,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent
      FROM public.segment_blast
      WHERE segment_key = $1
      `,
      [segmentKey]
    );

    const row = nowSize.rows?.[0] || {};
    console.log('=== roster_openers_asof_to_blast ===');
    console.log(`SEGMENT_KEY=${segmentKey}`);
    console.log(`ASOF_ISO=${asofIso}`);
    console.log(`base_openers_distinct=${baseCnt}`);
    console.log(`inserted_new_rows=${inserted}`);
    console.log(`segment_blast_total=${row.total ?? 0} unsent=${row.unsent ?? 0} sent=${row.sent ?? 0}`);
    console.log('done.');
  } finally {
    await pool.end().catch(() => {});
  }
})().catch((e) => {
  console.error('❌ fatal', e);
  process.exit(1);
});
