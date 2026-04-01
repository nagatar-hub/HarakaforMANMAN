/**
 * 画像ヘルスチェック
 *
 * prepared_card の image_url / alt_image_url に対してリクエストを行い、
 * image_status を 'ok' / 'fallback' / 'dead' に更新する。
 *
 * ロジック:
 *   1. image_url が ok → 'ok'
 *   2. image_url が dead → alt_image_url があれば確認
 *   3. alt_image_url が ok → 'fallback'
 *   4. 両方 dead or なし → 'dead'
 *
 * 注意:
 *   - Cloudflare JS Challenge (403 + cf-mitigated: challenge) は
 *     「URL自体は存在するがボット対策で弾かれている」ので OK 扱いとする。
 *   - Node.js の fetch では JS Challenge を解けないため。
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, PreparedCardRow, ImageStatus } from '@haraka/shared';
import { updateProgress } from './progress.js';

const CONCURRENCY = 20;
const TIMEOUT_MS = 8000;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
};

/**
 * URL の有効性を確認。
 * - 200/206 → true
 * - 403 + Cloudflare challenge → true（URL自体は存在する）
 * - 404/5xx/タイムアウト → false
 */
async function isUrlAlive(url: string): Promise<boolean> {
  // 1. HEAD で試行
  try {
    const c1 = new AbortController();
    const t1 = setTimeout(() => c1.abort(), TIMEOUT_MS);
    const r1 = await fetch(url, {
      method: 'HEAD',
      signal: c1.signal,
      redirect: 'follow',
      headers: BROWSER_HEADERS,
    });
    clearTimeout(t1);
    if (r1.ok) return true;
    // Cloudflare JS Challenge: URL は存在するがボット対策
    if (r1.status === 403 && r1.headers.get('cf-mitigated') === 'challenge') return true;
    // 404 などは明確に dead
    if (r1.status === 404 || r1.status === 410) return false;
  } catch {
    // ネットワークエラー → GET フォールバック
  }

  // 2. GET フォールバック
  try {
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), TIMEOUT_MS);
    const r2 = await fetch(url, {
      method: 'GET',
      signal: c2.signal,
      redirect: 'follow',
      headers: { ...BROWSER_HEADERS, Range: 'bytes=0-0' },
    });
    clearTimeout(t2);
    if (r2.ok || r2.status === 206) return true;
    // Cloudflare challenge on GET
    if (r2.status === 403 && r2.headers.get('cf-mitigated') === 'challenge') return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * 画像URLの有効性を検証し、image_status を更新する。
 *
 * @returns dead 件数
 */
export async function checkImageHealth(
  supabase: SupabaseClient<Database>,
  runId: string,
  cards: PreparedCardRow[],
): Promise<number> {
  // image_url または alt_image_url があるカードのみ対象
  const targets = cards.filter(c => c.image_url || c.alt_image_url);
  if (targets.length === 0) return 0;

  let deadCount = 0;
  let processed = 0;

  // バッチ処理（並列度制限付き）
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (card): Promise<{ id: string; status: ImageStatus }> => {
        // 1. image_url をチェック
        if (card.image_url) {
          const primaryOk = await isUrlAlive(card.image_url);
          if (primaryOk) return { id: card.id, status: 'ok' };
        }

        // 2. image_url が無効 → alt_image_url をチェック
        if (card.alt_image_url) {
          const altOk = await isUrlAlive(card.alt_image_url);
          if (altOk) return { id: card.id, status: 'fallback' };
        }

        // 3. 両方無効
        return { id: card.id, status: 'dead' };
      }),
    );

    // 結果をDBに反映
    const byStatus: Record<ImageStatus, string[]> = {
      ok: [],
      fallback: [],
      dead: [],
      unchecked: [],
    };

    for (const result of results) {
      if (result.status === 'fulfilled') {
        byStatus[result.value.status].push(result.value.id);
      }
    }

    for (const [status, ids] of Object.entries(byStatus)) {
      if (ids.length > 0 && status !== 'unchecked') {
        await supabase.from('prepared_card')
          .update({ image_status: status as ImageStatus })
          .in('id', ids);
      }
    }

    deadCount += byStatus.dead.length;
    processed += batch.length;
    await updateProgress(supabase, runId, processed, targets.length, `画像チェック ${processed}/${targets.length}`);
  }

  return deadCount;
}
