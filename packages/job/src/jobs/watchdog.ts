/**
 * Watchdog ジョブ — 満満のオーダーリスト画像生成を監視し、安全に再実行する。
 *
 * 画像生成は 1 Run / 1 Task。generate_claim_token を fencing token として使い、
 * 同じ Run の二重起動を防ぐ。Oripark の Run は一切参照・更新しない。
 */

import { randomUUID } from 'node:crypto';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { sendDiscordNotification, COLOR } from '../lib/discord.js';
import { runCloudRunJob, fetchMetadataAccessToken } from '../lib/cloud-run.js';

import type { Database } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type ClaimedRun = Pick<RunRow, 'id' | 'generate_claimed_at' | 'generate_claim_token'>;
type Supabase = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;

const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
const JOB_NAME = process.env.GENERATE_JOB_NAME?.trim() || `haraka-${STORE_NAME}-generate`;
export const GENERATE_CLAIM_LEASE_MS = 75 * 60 * 1000;

export function isStaleGenerateClaim(
  run: Pick<RunRow, 'status' | 'generate_done_at' | 'generate_claimed_at'>,
  now: Date,
): boolean {
  if (run.status !== 'running' || run.generate_done_at || !run.generate_claimed_at) return false;
  const claimedAt = Date.parse(run.generate_claimed_at);
  return Number.isFinite(claimedAt) && now.getTime() - claimedAt >= GENERATE_CLAIM_LEASE_MS;
}

function isFreshClaim(run: RunRow, now: Date): boolean {
  return Boolean(run.generate_claim_token && run.generate_claimed_at && !isStaleGenerateClaim(run, now));
}

async function claimGenerateRun(
  supabase: Supabase,
  run: RunRow,
  now: Date,
): Promise<ClaimedRun | null> {
  const claimedAt = now.toISOString();
  const claimToken = randomUUID();
  let query = supabase
    .from('run')
    .update({
      status: 'running',
      error_message: null,
      generate_claimed_at: claimedAt,
      generate_claim_token: claimToken,
    })
    .eq('id', run.id)
    .eq('store', STORE_NAME)
    .not('plan_done_at', 'is', null)
    .is('generate_done_at', null);

  if (run.status === 'running') {
    query = query.eq('status', 'running');
    query = run.generate_claim_token
      ? query.eq('generate_claim_token', run.generate_claim_token)
      : query.is('generate_claim_token', null);
    query = run.generate_claimed_at
      ? query.eq('generate_claimed_at', run.generate_claimed_at)
      : query.is('generate_claimed_at', null);
  } else {
    query = query.in('status', ['completed', 'failed']);
  }

  const { data, error } = await query
    .select('id, generate_claimed_at, generate_claim_token')
    .maybeSingle<ClaimedRun>();
  if (error) throw new Error(`画像生成Runのclaimに失敗しました: ${error.message}`);
  return data;
}

async function launchGenerate(run: ClaimedRun): Promise<void> {
  if (!run.generate_claim_token) throw new Error('画像生成claim tokenが保存されていません');
  await runCloudRunJob({
    jobName: JOB_NAME,
    taskCount: 1,
    containerOverrides: [{
      env: [
        { name: 'RUN_ID', value: run.id },
        { name: 'GENERATE_CLAIM_TOKEN', value: run.generate_claim_token },
        { name: 'STORE_NAME', value: STORE_NAME },
      ],
    }],
    tokenFetcher: fetchMetadataAccessToken,
  });
}

type GlobalRecoveryResult = {
  handledRunIds: Set<string>;
  launchErrors: unknown[];
};

/**
 * 日付やorder_list_import_idに依存せず、全期間の期限切れgeneration claimを回収する。
 * store + old token + old claimed_at のCAS後にだけ再起動する。
 */
async function recoverGlobalStaleGenerationClaims(
  supabase: Supabase,
  now: Date,
): Promise<GlobalRecoveryResult> {
  const staleBefore = new Date(now.getTime() - GENERATE_CLAIM_LEASE_MS).toISOString();
  const handledRunIds = new Set<string>();
  const launchErrors: unknown[] = [];
  const { data: staleRuns, error } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .eq('status', 'running')
    .not('plan_done_at', 'is', null)
    .is('generate_done_at', null)
    .not('generate_claimed_at', 'is', null)
    .lte('generate_claimed_at', staleBefore)
    .order('generate_claimed_at', { ascending: true })
    .returns<RunRow[]>();
  if (error) throw new Error(`stale generate claim検索失敗: ${error.message}`);

  for (const staleRun of staleRuns || []) {
    if (!isStaleGenerateClaim(staleRun, now)) continue;
    const claimedRun = await claimGenerateRun(supabase, staleRun, now);
    if (!claimedRun) {
      console.log(`[watchdog] stale claimは別プロセスが更新済み (run_id=${staleRun.id})`);
      continue;
    }
    handledRunIds.add(staleRun.id);

    try {
      await launchGenerate(claimedRun);
      await sendDiscordNotification({
        title: '🟢 ウォッチドッグ: stale Run再起動成功',
        description: `Run ${staleRun.id} の画像生成を単一タスクで再起動しました。`,
        color: COLOR.SUCCESS,
      });
    } catch (launchError) {
      // 起動結果が不明でもジョブだけ開始済みの可能性があるため、renew済みclaimを維持する。
      launchErrors.push(launchError);
      const message = launchError instanceof Error ? launchError.message : String(launchError);
      await sendDiscordNotification({
        title: '🔴 ウォッチドッグ: stale Run再起動結果不明',
        description: `二重起動防止のためclaimを維持します。Run ${staleRun.id}\n${message.substring(0, 500)}`,
        color: COLOR.ERROR,
      });
    }
  }

  return { handledRunIds, launchErrors };
}

export async function runWatchdog() {
  const supabase = await createSupabaseClientFromSecrets();
  const now = new Date();

  // 日次検索より先に、全期間のstale claimを回収する。
  const globalRecovery = await recoverGlobalStaleGenerationClaims(supabase, now);
  if (globalRecovery.launchErrors.length > 0) throw globalRecovery.launchErrors[0];
  if (process.env.WATCHDOG_MODE?.trim().toLowerCase() === 'recovery') {
    console.log('[watchdog] recovery-only完了');
    return;
  }

  // 本日 00:00 JST を計算
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayJST = new Date(now.getTime() + jstOffset);
  todayJST.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(todayJST.getTime() - jstOffset);

  console.log(`[watchdog] 本日の${STORE_NAME}オーダーリストRunを検索 (since ${todayStart.toISOString()})`);

  const { data: runs, error: runsError } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .not('order_list_import_id', 'is', null)
    .gte('started_at', todayStart.toISOString())
    .order('started_at', { ascending: false })
    .returns<RunRow[]>();

  if (runsError) throw new Error(`run テーブル検索失敗: ${runsError.message}`);

  const targetRun = runs?.[0];
  if (!targetRun && globalRecovery.handledRunIds.size > 0) {
    console.log('[watchdog] global stale回復済みのため本日Run未生成通知をスキップ');
    return;
  }
  if (targetRun && globalRecovery.handledRunIds.has(targetRun.id)) {
    console.log(`[watchdog] global stale回復済みRunの日次処理をスキップ (run_id=${targetRun.id})`);
    return;
  }
  if (!targetRun) {
    console.log('[watchdog] 本日のRunなし。オーダーリスト取込待ちとして停止');
    await sendDiscordNotification({
      title: '⚠️ 本日のオーダーリスト未反映',
      description: '本日のRunが見つかりません。管理画面でExcelを読み込み、内容を確認して反映してください。',
      color: COLOR.WARNING,
    });
    return;
  }

  if (targetRun.generate_done_at) {
    console.log(`[watchdog] 画像生成完了確認済み (run_id=${targetRun.id})`);
    return;
  }

  if (!targetRun.plan_done_at) {
    console.log(`[watchdog] Runは画像生成準備前です (run_id=${targetRun.id}, status=${targetRun.status})`);
    await sendDiscordNotification({
      title: '⏳ ウォッチドッグ: 反映処理中',
      description: `Run ${targetRun.id} はまだ画像生成準備前です。次回チェックまで待機します。`,
      color: COLOR.WARNING,
    });
    return;
  }

  if (targetRun.status === 'running' && isFreshClaim(targetRun, now)) {
    console.log(`[watchdog] 画像生成実行中 (run_id=${targetRun.id}), スキップ`);
    await sendDiscordNotification({
      title: '⏳ ウォッチドッグ: 画像生成中',
      description: `Run ${targetRun.id} はまだ画像生成中です。claim期限までは再実行しません。`,
      color: COLOR.WARNING,
    });
    return;
  }

  const claimedRun = await claimGenerateRun(supabase, targetRun, now);
  if (!claimedRun) {
    console.log(`[watchdog] 他の実行がRunを先にclaimしました (run_id=${targetRun.id})`);
    return;
  }

  const retryReason = targetRun.status === 'running'
    ? '期限切れの画像生成claimを再確保しました'
    : `画像生成未完了を検知しました (status=${targetRun.status})`;
  console.log(`[watchdog] ${retryReason}: run_id=${claimedRun.id}`);

  await sendDiscordNotification({
    title: '⚠️ 画像生成未完了を検知',
    description: `${retryReason}\n単一タスクで自動リトライします。`,
    color: COLOR.WARNING,
  });

  try {
    await launchGenerate(claimedRun);
    await sendDiscordNotification({
      title: '🟢 ウォッチドッグ: リトライ起動成功',
      description: `Run ${claimedRun.id} の画像生成を再起動しました。`,
      color: COLOR.SUCCESS,
    });
  } catch (err) {
    // Cloud Run APIの応答が失われてもジョブだけ起動している可能性があるため、
    // claimは解除しない。75分後にのみ再claimできる。
    const message = err instanceof Error ? err.message : String(err);
    await sendDiscordNotification({
      title: '🔴 ウォッチドッグ: リトライ起動結果不明',
      description: `二重起動防止のためclaimを維持します。手動確認してください。\n${message.substring(0, 500)}`,
      color: COLOR.ERROR,
    });
    throw err;
  }
}
