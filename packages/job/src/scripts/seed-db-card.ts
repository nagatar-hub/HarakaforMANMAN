/**
 * db_card テーブルにDBシートのデータを投入するスタンドアロンスクリプト
 *
 * Usage: JOB_NAME=seed-db-card npx tsx packages/job/src/scripts/seed-db-card.ts
 */

import { createSupabaseClient } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { batchUpsert } from '../lib/batch.js';
import { buildDbCardRows } from '../lib/db-card-sync.js';

async function main() {
  console.log('[seed-db-card] 開始...');

  const supabase = createSupabaseClient();
  const accessToken = await getAccessToken();
  console.log('[seed-db-card] Access token 取得完了');

  const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
  if (!harakaDbSpreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID が未設定です');

  // DBタブ取得
  const allDbRows = await fetchSheetValues({
    accessToken,
    spreadsheetId: harakaDbSpreadsheetId,
    range: 'DB',
  });

  const dbDataRows = allDbRows.slice(1); // ヘッダスキップ
  console.log(`[seed-db-card] DBタブ: ${dbDataRows.length}行取得`);

  // db_card 用データに変換
  const dbCardRows = buildDbCardRows(dbDataRows);
  console.log(`[seed-db-card] 変換: ${dbCardRows.length}件`);

  if (dbCardRows.length > 0) {
    await batchUpsert(
      supabase,
      'db_card',
      dbCardRows as unknown as Record<string, unknown>[],
      'franchise,card_name,grade,list_no',
    );
    console.log(`[seed-db-card] upsert 完了: ${dbCardRows.length}件`);
  }

  // 確認クエリ
  const { count } = await supabase
    .from('db_card')
    .select('*', { count: 'exact', head: true });
  console.log(`[seed-db-card] db_card テーブル: ${count}件`);

  console.log('[seed-db-card] 完了');
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed-db-card] 失敗:', e);
  process.exit(1);
});
