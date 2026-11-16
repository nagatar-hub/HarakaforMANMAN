import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { tokyoBusinessDate } from '@haraka/shared';
import { loadOriparkCoverage, readCoverageReport } from '../lib/oripark-coverage.js';
import { runCloudRunJob, fetchMetadataAccessToken } from '../lib/cloud-run.js';

/** Reuses the existing transactional resync lease; concurrent schedulers cannot launch two syncs. */
export async function reconcileTokyoCoverage(db: SupabaseClient, now = new Date()): Promise<boolean> {
  const store = 'manman-akihabara';
  const { data: order, error } = await db.from('order_list_import').select('id,status,business_date')
    .eq('store', store).order('business_date', { ascending: false }).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!order || !['applied', 'confirmed', 'failed'].includes(order.status)) return false;
  const age = (Date.parse(tokyoBusinessDate(now)) - Date.parse(order.business_date)) / 86400000;
  if (age < 0 || age > 1) return false;
  const { data: run, error: runError } = await db.from('run').select('id,status,plan_done_at,generate_done_at,tokyo_snapshot_id')
    .eq('store', store).eq('order_list_import_id', order.id).order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (runError) throw new Error(runError.message);
  if (!run || run.status === 'running' || (!run.generate_done_at && run.plan_done_at)) return false;
  let previousFingerprint: string | undefined;
  if (run.generate_done_at && run.tokyo_snapshot_id) {
    const { data: snapshot, error: snapshotError } = await db.from('tokyo_buyback_snapshot').select('report')
      .eq('store', store).eq('id', run.tokyo_snapshot_id).single();
    if (snapshotError) throw new Error(snapshotError.message);
    previousFingerprint = readCoverageReport(snapshot.report)?.fingerprint;
  }
  const baseline = await loadOriparkCoverage(db);
  if (previousFingerprint === baseline.fingerprint) return false;
  const fingerprint = createHash('sha256').update(JSON.stringify(['oripark-coverage-v1', order.id, run.id, baseline.fingerprint])).digest('hex');
  const requestId = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-5${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
  const { data: queued, error: queueError } = await db.rpc('queue_order_list_import_resync', {
    p_import_id: order.id, p_request_id: requestId, p_request_fingerprint: fingerprint,
    p_mappings: [], p_new_cards: [], p_exclusions: [], p_allow_unresolved: true,
  });
  if (queueError) {
    if (queueError.code === '55000') return true; // a concurrent operator or worker owns the lease
    throw new Error(queueError.message);
  }
  if (queued?.action === 'start_job') {
    await runCloudRunJob({ jobName: 'haraka-manman-akihabara-sync', taskCount: 1,
      tokenFetcher: fetchMetadataAccessToken, containerOverrides: [{ env: [
        { name: 'STORE_NAME', value: store }, { name: 'ORDER_LIST_IMPORT_ID', value: order.id },
        { name: 'ORDER_LIST_SYNC_REQUEST_ID', value: requestId },
        { name: 'ORDER_LIST_SYNC_REQUEST_FINGERPRINT', value: fingerprint },
        { name: 'DISCORD_NOTIFICATIONS_DISABLED', value: 'true' },
      ] }] });
    console.log(`[coverage] Oripark ${baseline.runId}への追従同期を開始: ${order.id}`);
  }
  return true;
}
