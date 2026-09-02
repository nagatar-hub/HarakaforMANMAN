import { getBuybackSheetAccessToken } from '../lib/auth.js';
import { publishManmanBuybackSheet } from '../lib/buyback-sheet.js';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { STORE_NAME } from '../lib/store.js';

export async function runPublishBuybackSheet(): Promise<void> {
  const supabase = await createSupabaseClientFromSecrets();
  const runId = process.env.RUN_ID?.trim();
  if (!runId) throw new Error('RUN_ID is required for buyback-sheet publishing');

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
