#!/usr/bin/env node
/**
 * 3/20時点（= 3/21 00:00 JST 未満）の起動者を segment_users にスナップショット投入する
 *
 * env:
 *   DATABASE_URL (required)
 *   SEGMENT_KEY (required) 例: ohanami_2026_openers_0320
 *   ASOF_ISO (optional)    例: 2026-03-21T00:00:00+09:00  ※この時刻「未満」を対象
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

  // Date は "2026-03-21T00:00:00+09:00" をUTCに変換して保持してくれる
  const asof = new Date(asofIso);
  if (Number.isNaN(asof.getTime())) {
    console.error(`❌ invalid ASOF_ISO: ${asofIso}`);
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // まず母数（起動者数）を確認
    const base = await pool.query(
      `
      SELECT COUNT(DISTINCT user_id) AS cnt
      FROM public.liff_open_logs
      WHERE opened_at < $1
      `,
      [asof]
    );
    const baseCnt = Number(base.rows?.[0]?.cnt || 0);

    // スナップショット投入（重複は ON CONFLICT DO NOTHING）
    // RETURNING で「今回新規に入った件数」だけ数えられる
    const ins = await pool.query(
      `
      INSERT INTO public.segment_users (segment_key, user_id)
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

    // 現在の名簿サイズ
    const nowSize = await pool.query(
      `SELECT COUNT(*) AS cnt FROM public.segment_users WHERE segment_key = $1`,
      [segmentKey]
    );
    const sizeCnt = Number(nowSize.rows?.[0]?.cnt || 0);

    console.log('=== roster_openers_asof ===');
    console.log(`SEGMENT_KEY=${segmentKey}`);
    console.log(`ASOF_ISO=${asofIso}`);
    console.log(`base_openers_distinct=${baseCnt}`);
    console.log(`inserted_new_rows=${inserted}`);
    console.log(`segment_size_now=${sizeCnt}`);
    console.log('done.');
  } finally {
    await pool.end().catch(() => {});
  }
})().catch((e) => {
  console.error('❌ fatal', e);
  process.exit(1);
});
