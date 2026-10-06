import type { PreparedCardRow } from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getRequiredEnvOrSecret } from '../lib/env.js';
import { fetchTokyoPelekaPostalSnapshot, assertTokyoPelekaPostalUnchanged } from '../lib/peleka-postal.js';
import { renderTokyoPelekaPostalPages } from '../lib/tokyo-peleka-postal-render.js';

export async function runGeneratePelekaPostal() {
  const runId = process.env.RUN_ID;
  const revision = process.env.PELEKA_CATALOG_REVISION ?? '';
  const businessDate = process.env.EXPECTED_BUSINESS_DATE ?? '';
  if (process.env.STORE_NAME !== 'manman-akihabara' || !runId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
    || !/^(0|[1-9]\d*)$/.test(revision) || Number(revision) > 2147483647
    || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('Tokyo RUN_ID, PELEKA_CATALOG_REVISION and EXPECTED_BUSINESS_DATE are required');
  const [supabase, endpoint, token] = await Promise.all([
    createSupabaseClientFromSecrets(), getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_URL'),
    getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_TOKEN'),
  ]);
  const { data: run, error: runError } = await supabase.from('run').select('*')
    .eq('id', runId).eq('store', 'manman-akihabara').single();
  if (runError || !run || run.status !== 'completed' || !run.generate_done_at || !run.tokyo_snapshot_id) {
    throw new Error('Tokyo store generation must already be completed');
  }
  const { data: pages, error: pageError } = await supabase.from('generated_page')
    .select('id,kind,status,card_ids').eq('run_id', runId);
  if (pageError || !pages?.length || pages.some(page => page.kind !== 'store' || page.status !== 'generated')) {
    throw new Error('Store pages must be complete and postal pages must not exist');
  }
  const ids = pages.flatMap(page => page.card_ids);
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Store card coverage is invalid');
  const cards: PreparedCardRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    const { data, error } = await supabase.from('prepared_card').select('*').eq('run_id', runId).in('id', chunk);
    if (error || data?.length !== chunk.length) throw new Error('Store cards are incomplete');
    cards.push(...data);
  }
  const expected = { runId, revision: Number(revision) };
  const snapshot = await fetchTokyoPelekaPostalSnapshot(endpoint, token, expected);
  if (snapshot.snapshotId !== run.tokyo_snapshot_id || snapshot.businessDate !== businessDate) {
    throw new Error('Peleka snapshot or business date does not match');
  }
  if (snapshot.products.length === 0) throw new Error('No eligible postal products; no pages were added');
  const count = await renderTokyoPelekaPostalPages({
    supabase, runId, snapshot, preparedCards: cards, datePath: businessDate.replaceAll('-', '/'),
    generationVersion: Date.now(),
    publishTogether: async postalPages => {
      assertTokyoPelekaPostalUnchanged(snapshot, await fetchTokyoPelekaPostalSnapshot(endpoint, token, expected));
      const { error } = await supabase.rpc('insert_tokyo_peleka_postal_pages' as never, {
        p_run_id: runId, p_snapshot_id: snapshot.snapshotId, p_business_date: businessDate,
        p_pages: postalPages,
      } as never);
      if (error) throw new Error(`Postal publication failed: ${error.message}`);
    },
  });
  console.log(`[generate-peleka-postal] run=${runId} revision=${revision} pages=${count} products=${snapshot.products.length} fingerprint=${snapshot.fingerprint}`);
}
