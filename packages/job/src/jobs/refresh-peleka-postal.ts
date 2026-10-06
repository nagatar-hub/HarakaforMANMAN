import type { PreparedCardRow } from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getRequiredEnvOrSecret } from '../lib/env.js';
import {
  assertTokyoPelekaPostalUnchanged,
  fetchTokyoPelekaPostalSnapshot,
  type TokyoPelekaPostalSnapshot,
} from '../lib/peleka-postal.js';
import { renderTokyoPelekaPostalPages } from '../lib/tokyo-peleka-postal-render.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function runRefreshPelekaPostal() {
  const runId = process.env.RUN_ID ?? '';
  const requestId = process.env.POSTAL_REFRESH_REQUEST_ID ?? '';
  if (process.env.STORE_NAME !== 'manman-akihabara' || !UUID.test(runId) || !UUID.test(requestId)) {
    throw new Error('Tokyo RUN_ID and POSTAL_REFRESH_REQUEST_ID are required');
  }

  const supabase = await createSupabaseClientFromSecrets();
  try {
    const [{ data: refresh, error: refreshError }, { data: run, error: runError }] = await Promise.all([
      (supabase as any).from('tokyo_peleka_postal_refresh').select('request_id,status')
        .eq('run_id', runId).eq('request_id', requestId).maybeSingle(),
      supabase.from('run').select('id,store,status,generate_done_at,tokyo_snapshot_id')
        .eq('id', runId).eq('store', 'manman-akihabara').maybeSingle(),
    ]);
    if (refreshError || !refresh || refresh.status !== 'running') throw new Error('Tokyo postal refresh request is not running');
    if (runError || !run || run.status !== 'completed' || !run.generate_done_at || !run.tokyo_snapshot_id) {
      throw new Error('Tokyo store generation must already be completed');
    }
    const { data: sourceSnapshot, error: sourceSnapshotError } = await supabase.from('tokyo_buyback_snapshot')
      .select('business_date').eq('id', run.tokyo_snapshot_id).eq('store', 'manman-akihabara').maybeSingle();
    if (sourceSnapshotError || !sourceSnapshot) throw new Error('Tokyo source snapshot is unavailable');

    const [{ data: pages, error: pageError }, { data: revisionRow, error: revisionError }] = await Promise.all([
      supabase.from('generated_page').select('id,status,card_ids').eq('run_id', runId).eq('kind', 'store'),
      (supabase as any).from('tokyo_peleka_catalog_revisions').select('last_revision').eq('run_id', runId).maybeSingle(),
    ]);
    if (pageError || !pages?.length || pages.some(page => page.status !== 'generated')) {
      throw new Error('Store pages must be complete');
    }
    if (revisionError || !revisionRow || !Number.isSafeInteger(revisionRow.last_revision)) {
      throw new Error('Published Peleka catalog revision is unavailable');
    }
    const ids = pages.flatMap(page => page.card_ids);
    if (new Set(ids).size !== ids.length) throw new Error('Store card coverage is invalid');

    const cards: PreparedCardRow[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      const { data, error } = await supabase.from('prepared_card').select('*').in('id', chunk);
      if (error || data?.length !== chunk.length) throw new Error('Store cards are incomplete');
      cards.push(...data);
    }
    const cardRunIds = [...new Set(cards.map(card => card.run_id))];
    if (cardRunIds.length) {
      const { data: cardRuns, error: cardRunError } = await supabase.from('run').select('id')
        .in('id', cardRunIds).eq('store', 'manman-akihabara');
      if (cardRunError || cardRuns?.length !== cardRunIds.length) throw new Error('Store pages contain foreign-store cards');
    }

    const [endpoint, token] = await Promise.all([
      getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_URL'),
      getRequiredEnvOrSecret('PELEKA_TOKYO_CATALOG_TOKEN'),
    ]);
    const expected = { runId, revision: revisionRow.last_revision as number };
    let snapshot: TokyoPelekaPostalSnapshot;
    try {
      snapshot = await fetchTokyoPelekaPostalSnapshot(endpoint, token, expected);
    } catch (error) {
      if (error instanceof Error && error.message.includes('HTTP 409')) {
        throw new Error('対象の実行分とPelekaの最新カタログが一致しません。店舗側のPeleka同期完了後に再試行してください');
      }
      throw error;
    }
    if (snapshot.snapshotId !== run.tokyo_snapshot_id || snapshot.businessDate !== sourceSnapshot.business_date) {
      throw new Error('Peleka snapshot or business date does not match the run');
    }

    const count = await renderTokyoPelekaPostalPages({
      supabase,
      runId,
      snapshot,
      preparedCards: cards,
      datePath: snapshot.businessDate.replaceAll('-', '/'),
      generationVersion: requestId,
      publishTogether: async postalPages => {
        let confirmed: TokyoPelekaPostalSnapshot;
        try {
          confirmed = await fetchTokyoPelekaPostalSnapshot(endpoint, token, expected);
        } catch (error) {
          if (error instanceof Error && error.message.includes('HTTP 409')) {
            throw new Error('画像生成中にPelekaの最新カタログが変更されました。再試行してください');
          }
          throw error;
        }
        assertTokyoPelekaPostalUnchanged(snapshot, confirmed);
        const { error } = await supabase.rpc('replace_tokyo_peleka_postal_pages' as never, {
          p_run_id: runId,
          p_request_id: requestId,
          p_snapshot_id: snapshot.snapshotId,
          p_business_date: snapshot.businessDate,
          p_expected_revision: snapshot.revision,
          p_expected_fingerprint: snapshot.fingerprint,
          p_pages: postalPages,
        } as never);
        if (error) throw new Error(`Postal refresh publication failed: ${error.message}`);
      },
    });
    console.log(`[refresh-peleka-postal] run=${runId} revision=${snapshot.revision} pages=${count} products=${snapshot.products.length} fingerprint=${snapshot.fingerprint}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { error: statusError } = await supabase.rpc('fail_tokyo_peleka_postal_refresh' as never, {
      p_run_id: runId, p_request_id: requestId, p_error_message: message,
    } as never);
    if (statusError) console.error(`[refresh-peleka-postal] failure status update failed: ${statusError.message}`);
    throw error;
  }
}
