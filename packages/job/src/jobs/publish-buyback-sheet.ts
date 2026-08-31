import type { Database } from '@haraka/shared';
import { getBuybackSheetAccessToken } from '../lib/auth.js';
import { publishManmanBuybackSheet } from '../lib/buyback-sheet.js';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { STORE_NAME } from '../lib/store.js';

export async function runPublishBuybackSheet(): Promise<void> {
  const supabase = await createSupabaseClientFromSecrets();
  const requestedRunId = process.env.RUN_ID?.trim();

  let runId = requestedRunId;
  if (!runId) {
    const { data: latestRun, error } = await supabase
      .from('run')
      .select('id')
      .eq('store', STORE_NAME)
      .eq('status', 'completed')
      .not('generate_done_at', 'is', null)
      .not('order_list_import_id', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle<Pick<Database['public']['Tables']['run']['Row'], 'id'>>();
    if (error) {
      throw new Error(`最新の完了済みMANMAN実行取得に失敗しました: ${error.message}`);
    }
    if (!latestRun) {
      throw new Error('公開可能な完了済みMANMAN実行がありません');
    }
    runId = latestRun.id;
  }

  const accessToken = await getBuybackSheetAccessToken();
  const result = await publishManmanBuybackSheet({
    supabase,
    runId,
    accessToken,
  });

  console.log(
    `[publish-buyback-sheet] status=${result.status}, run=${runId}, rows=${result.rowCount}, hash=${result.contentHash ?? 'none'}`,
  );
}
