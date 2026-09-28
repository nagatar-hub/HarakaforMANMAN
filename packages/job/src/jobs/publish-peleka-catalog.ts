import { getRequiredEnvOrSecret } from '../lib/env.js';
import { publishCurrentTokyoPelekaCatalog } from '../lib/peleka-catalog.js';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';

export async function runPublishPelekaCatalog() {
  const runId = process.env.RUN_ID;
  if (!runId) throw new Error('RUN_ID が未設定です');
  const [supabase, endpoint, token] = await Promise.all([
    createSupabaseClientFromSecrets(),
    getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_URL'),
    getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_TOKEN'),
  ]);
  const payload = await publishCurrentTokyoPelekaCatalog(supabase, runId, endpoint, token);
  console.log(`[publish-peleka-catalog] 完了: run=${runId} revision=${payload.revision} ${payload.count}商品 sha256=${payload.productsSha256}`);
}
