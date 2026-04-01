/**
 * 進捗更新ヘルパー
 *
 * ジョブの各ステップから呼び出し、run テーブルの progress_* を更新する。
 * フロントエンドはポーリングでこの値を読み取り、進捗バーを表示する。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haraka/shared';

export async function updateProgress(
  supabase: SupabaseClient<Database>,
  runId: string,
  current: number,
  total: number,
  message: string,
): Promise<void> {
  await supabase.from('run').update({
    progress_current: current,
    progress_total: total,
    progress_message: message,
  }).eq('id', runId);
}

export async function clearProgress(
  supabase: SupabaseClient<Database>,
  runId: string,
): Promise<void> {
  await supabase.from('run').update({
    progress_current: 0,
    progress_total: 0,
    progress_message: null,
  }).eq('id', runId);
}
