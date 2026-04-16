/**
 * Watchdog ジョブ — 朝9時ジョブの実行監視＋自動リトライ
 *
 * 毎朝 9:10 JST に Cloud Scheduler から起動される。
 * 本日の scheduler トリガーの run を Supabase で検索し、
 * 未実行・失敗の場合は Sync → Generate を自動リトライする。
 */

import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { sendDiscordNotification, COLOR } from '../lib/discord.js';
import { runSync } from './sync.js';
import { runGenerate } from './generate.js';
import type { Database } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];

export async function runWatchdog() {
  const supabase = await createSupabaseClientFromSecrets();

  // 本日 00:00 JST を計算
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const todayJST = new Date(now.getTime() + jstOffset);
  todayJST.setUTCHours(0, 0, 0, 0);
  const todayStart = new Date(todayJST.getTime() - jstOffset);

  console.log(`[watchdog] 本日の scheduler run を検索 (since ${todayStart.toISOString()})`);

  // 本日の scheduler run を検索
  const { data: runs, error: runsError } = await supabase
    .from('run')
    .select('*')
    .eq('triggered_by', 'scheduler')
    .gte('started_at', todayStart.toISOString())
    .order('started_at', { ascending: false })
    .returns<RunRow[]>();

  if (runsError) {
    throw new Error(`run テーブル検索失敗: ${runsError.message}`);
  }

  // Sync + Generate の両方が完了しているか確認
  const completedRun = runs?.find(r => r.status === 'completed' && r.generate_done_at);

  if (completedRun) {
    console.log(`[watchdog] 朝ジョブ正常完了確認済み (run_id=${completedRun.id})`);
    return;
  }

  // Sync は完了したが Generate がまだの場合
  const syncDoneRun = runs?.find(r => r.status === 'completed' && !r.generate_done_at);
  const failedRun = runs?.find(r => r.status === 'failed');
  const runningRun = runs?.find(r => r.status === 'running');

  // まだ実行中の場合はスキップ
  if (runningRun) {
    console.log(`[watchdog] ジョブ実行中 (run_id=${runningRun.id}), スキップ`);
    await sendDiscordNotification({
      title: '⏳ ウォッチドッグ: ジョブ実行中',
      description: `朝ジョブがまだ実行中です (run_id=${runningRun.id})。次回チェックまで待機します。`,
      color: COLOR.WARNING,
    });
    return;
  }

  // 失敗・未実行の理由を特定
  let reason: string;
  if (failedRun) {
    reason = `朝9時ジョブが失敗しています: ${failedRun.error_message?.substring(0, 200) ?? '不明'}`;
  } else if (syncDoneRun) {
    reason = 'Sync は完了しましたが Generate が実行されていません';
  } else {
    reason = '朝9時ジョブが実行されていません';
  }

  console.log(`[watchdog] ${reason}`);

  await sendDiscordNotification({
    title: '⚠️ 朝ジョブ未完了検知',
    description: `${reason}\n自動リトライを実行します。`,
    color: COLOR.WARNING,
  });

  // リトライ: Sync が完了済みなら Generate のみ、それ以外は両方
  try {
    if (syncDoneRun) {
      console.log('[watchdog] Generate のみリトライ');
      await runGenerate();
    } else {
      console.log('[watchdog] Sync → Generate リトライ');
      await runSync();
      await runGenerate();
    }
    await sendDiscordNotification({
      title: '🟢 ウォッチドッグ: リトライ成功',
      description: '自動リトライが正常に完了しました。',
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
