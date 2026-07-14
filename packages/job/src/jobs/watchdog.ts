/**
 * Watchdog ジョブ — 朝9時ジョブの実行監視＋自動リトライ
 *
 * 1 Run を 2 Task が共有する Tasks 並列モデルでは、kind 別に
 * postal_done_at / store_done_at を見て片寄り未完 / 両方未完を判定する。
 * リトライは Cloud Run Jobs API 経由で haraka-generate を再実行する。
 */

import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { sendDiscordNotification, COLOR } from '../lib/discord.js';
import { runCloudRunJob, fetchMetadataAccessToken } from '../lib/cloud-run.js';

import type { Database } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'] & {
  postal_done_at: string | null;
  store_done_at: string | null;
};

const STORE_NAME = process.env.STORE_NAME ?? 'oripark';
const JOB_NAME = process.env.GENERATE_JOB_NAME?.trim() || 'haraka-manman-generate';

/**
 * Cloud Run Jobs Admin API の `containerOverrides[]` は **タスク別ではなくコンテナ別** override。
 * したがって両 kind retry は taskCount=2 + RUN_ID broadcast（KIND は CLOUD_RUN_TASK_INDEX が決める）、
 * 単 kind retry は taskCount=1 + KIND 明示、と分岐する必要がある。
 */
async function retryGenerate(runId: string, missingKinds: Array<'postal' | 'store'>): Promise<void> {
  if (missingKinds.length === 2) {
    await runCloudRunJob({
      jobName: JOB_NAME,
      taskCount: 2,
      containerOverrides: [{ env: [{ name: 'RUN_ID', value: runId }] }],
      tokenFetcher: fetchMetadataAccessToken,
    });
  } else {
    const kind = missingKinds[0];
    await runCloudRunJob({
      jobName: JOB_NAME,
      taskCount: 1,
      containerOverrides: [{ env: [
        { name: 'KIND', value: kind },
        { name: 'RUN_ID', value: runId },
      ] }],
      tokenFetcher: fetchMetadataAccessToken,
    });
  }
}

export async function runWatchdog() {
  const supabase = await createSupabaseClientFromSecrets();

  // 本日 00:00 JST を計算
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayJST = new Date(now.getTime() + jstOffset);
  todayJST.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(todayJST.getTime() - jstOffset);

  console.log(`[watchdog] 本日のオーダーリスト Run を検索 (since ${todayStart.toISOString()})`);

  const { data: runs, error: runsError } = await supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME)
    .not('order_list_import_id', 'is', null)
    .gte('started_at', todayStart.toISOString())
    .order('started_at', { ascending: false })
    .returns<RunRow[]>();

  if (runsError) throw new Error(`run テーブル検索失敗: ${runsError.message}`);

  // 正常: 両 kind 完了
  const normalRun = runs?.find(
    (r) => r.status === 'completed' && r.generate_done_at && r.postal_done_at && r.store_done_at
  );
  if (normalRun) {
    console.log(`[watchdog] 朝ジョブ正常完了確認済み (run_id=${normalRun.id})`);
    return;
  }

  // 実行中の Run があれば待機
  const runningRun = runs?.find((r) => r.status === 'running');
  if (runningRun) {
    console.log(`[watchdog] ジョブ実行中 (run_id=${runningRun.id}), スキップ`);
    await sendDiscordNotification({
      title: '⏳ ウォッチドッグ: ジョブ実行中',
      description: `朝ジョブがまだ実行中です (run_id=${runningRun.id})。次回チェックまで待機します。`,
      color: COLOR.WARNING,
    });
    return;
  }

  // 候補 Run（最新の completed/failed を採用、なければ最新）
  const targetRun = runs?.[0];

  if (!targetRun) {
    // Excel 取込は人が選択・確認する操作を伴うため、取込IDなしで Sync を
    // 自動実行してはいけない。旧 KECAK 同期への暗黙フォールバックも行わない。
    console.log('[watchdog] 朝の Run が未生成。オーダーリスト取込待ちとして停止');
    await sendDiscordNotification({
      title: '⚠️ 本日のオーダーリスト未反映',
      description: '本日の Run が見つかりません。管理画面でExcelを読み込み、内容を確認して反映してください。',
      color: COLOR.WARNING,
    });
    return;
  }

  // 候補 Run があるが完了していない → 未完 kind を特定
  const missingKinds: Array<'postal' | 'store'> = [];
  if (!targetRun.postal_done_at) missingKinds.push('postal');
  if (!targetRun.store_done_at) missingKinds.push('store');

  if (missingKinds.length === 0) {
    // 両 kind 完了済みだが status が completed 以外。atomic finalizer の取りこぼし可能性
    console.log(`[watchdog] 両 kind 完了済みだが status=${targetRun.status}, generate_done_at=${targetRun.generate_done_at ?? 'null'}. 手動確認を推奨`);
    await sendDiscordNotification({
      title: '⚠️ ウォッチドッグ: 整合性異常',
      description: `Run ${targetRun.id} は両 kind 完了済みですが status=${targetRun.status} のままです (generate_done_at=${targetRun.generate_done_at ?? 'null'})。手動確認を推奨します。`,
      color: COLOR.WARNING,
    });
    return;
  }

  const failedRun = targetRun.status === 'failed' ? targetRun : undefined;

  let reason: string;
  if (failedRun) {
    reason = `朝ジョブが失敗 (status=failed): ${failedRun.error_message?.substring(0, 200) ?? '不明'}`;
  } else if (missingKinds.length === 2) {
    reason = '両 kind とも未完了です';
  } else {
    reason = `kind=${missingKinds[0]} のみ未完了です（片寄り完了）`;
  }

  console.log(`[watchdog] ${reason} → ${missingKinds.join(',')} を再キック`);

  await sendDiscordNotification({
    title: '⚠️ 朝ジョブ未完了検知',
    description: `${reason}\n自動リトライを実行します（kind=${missingKinds.join(',')}）。`,
    color: COLOR.WARNING,
  });

  try {
    await retryGenerate(targetRun.id, missingKinds);
    await sendDiscordNotification({
      title: '🟢 ウォッチドッグ: リトライキック成功',
      description: `Run ${targetRun.id} の kind=${missingKinds.join(',')} を再キックしました。実行結果は Cloud Run Jobs 側の通知を待ちます。`,
      color: COLOR.SUCCESS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendDiscordNotification({
      title: '🔴 ウォッチドッグ: リトライ失敗',
      description: `自動リトライも失敗しました。手動対応が必要です。\n${message.substring(0, 500)}`,
      color: COLOR.ERROR,
    });
    throw err;
  }
}
