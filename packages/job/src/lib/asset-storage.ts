/**
 * Supabase Storage アセット入出力ヘルパー
 *
 * テンプレート PNG・カード裏面 PNG・レアリティアイコン PNG 等の
 * 静的アセットを Supabase Storage（バケット `haraka-images`）で扱うためのユーティリティ。
 *
 * 従来は Google Drive に置いていたが、属人化回避・Drive 非依存化のため Storage に移行。
 * Drive ID フォールバックも提供する（移行期間中の保険）。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haraka/shared';
import { downloadDriveFile } from './google-drive.js';

export const HARAKA_IMAGES_BUCKET = 'haraka-images';

type Supabase = SupabaseClient<Database>;

/**
 * Supabase Storage からファイルを Buffer として取得
 *
 * @param path バケット内のパス（例: "templates/pokemon/20.png"）
 */
export async function downloadFromStorage(
  supabase: Supabase,
  path: string,
  bucket: string = HARAKA_IMAGES_BUCKET,
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    throw new Error(`Storage download failed (${bucket}/${path}): ${error?.message ?? 'no data'}`);
  }
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Supabase Storage にファイルをアップロード（存在すれば上書き）
 */
export async function uploadToStorage(
  supabase: Supabase,
  path: string,
  buffer: Buffer,
  contentType: string = 'image/png',
  bucket: string = HARAKA_IMAGES_BUCKET,
): Promise<void> {
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert: true,
  });
  if (error) {
    throw new Error(`Storage upload failed (${bucket}/${path}): ${error.message}`);
  }
}

/**
 * Storage パスを優先し、未設定なら Drive ID にフォールバック
 *
 * 移行期間中、片方しか持っていないレコードを安全に扱うための糊。
 * storagePath が与えられていて取得に成功したらそれを返す。
 * 失敗したら Drive ID で再試行。両方失敗したら throw。
 */
export async function downloadTemplateAsset(params: {
  supabase: Supabase;
  storagePath: string | null | undefined;
  driveId: string | null | undefined;
  accessToken: string | null;
  label?: string;
}): Promise<Buffer> {
  const { supabase, storagePath, driveId, accessToken, label } = params;

  if (storagePath) {
    try {
      return await downloadFromStorage(supabase, storagePath);
    } catch (err) {
      if (!driveId) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[asset-storage] Storage fetch failed (${label ?? storagePath}): ${msg}. Drive ID にフォールバック`,
      );
    }
  }

  if (driveId && accessToken) {
    return await downloadDriveFile(accessToken, driveId);
  }

  throw new Error(
    `アセット取得失敗（${label ?? ''}）: storagePath=${storagePath ?? 'null'}, driveId=${driveId ?? 'null'}`,
  );
}
