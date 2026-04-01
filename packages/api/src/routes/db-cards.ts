import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { updateDbSheetCell } from '../lib/haraka-db-sheet.js';

export const dbCardRoutes = new Hono();

/** db_card 一覧取得（フランチャイズ・エラーフィルタ対応） */
dbCardRoutes.get('/db-cards', async (c) => {
  const franchise = c.req.query('franchise');
  const tab = c.req.query('tab'); // 'error' でエラーカードのみ
  const supabase = createSupabaseClient();

  let query = supabase
    .from('db_card')
    .select('id, franchise, tag, card_name, grade, list_no, image_url, alt_image_url, rarity_icon, sheet_row_number, image_status')
    .order('franchise')
    .order('card_name')
    .limit(2000);

  if (franchise && franchise !== 'all') {
    query = query.eq('franchise', franchise);
  }

  if (tab === 'error') {
    // エラー: tag が null OR image_url が null OR image_status が dead
    query = query.or('tag.is.null,image_url.is.null,image_status.eq.dead');
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || []);
});

/** フランチャイズ別統計（件数 + エラー件数） */
dbCardRoutes.get('/db-cards/stats', async (c) => {
  const supabase = createSupabaseClient();

  // フランチャイズ別にカウント（1000件制限を回避）
  const franchises = ['Pokemon', 'ONE PIECE', 'YU-GI-OH!'];
  const byFranchise: Record<string, number> = {};
  let total = 0;
  let errorCount = 0;

  for (const f of franchises) {
    const { count: fCount } = await supabase
      .from('db_card')
      .select('*', { count: 'exact', head: true })
      .eq('franchise', f);
    byFranchise[f] = fCount ?? 0;
    total += fCount ?? 0;
  }

  // エラー件数: tag IS NULL OR image_url IS NULL OR image_status = 'dead'
  const { count: errCount } = await supabase
    .from('db_card')
    .select('*', { count: 'exact', head: true })
    .or('tag.is.null,image_url.is.null,image_status.eq.dead');
  errorCount = errCount ?? 0;

  // dead link 件数
  const { count: deadCount } = await supabase
    .from('db_card')
    .select('*', { count: 'exact', head: true })
    .eq('image_status', 'dead');

  return c.json({ total, byFranchise, errorCount, deadCount: deadCount ?? 0 });
});

/** フランチャイズ別タグ一覧 */
dbCardRoutes.get('/db-cards/tags', async (c) => {
  const supabase = createSupabaseClient();

  const { data, error } = await supabase
    .from('db_card')
    .select('franchise, tag')
    .not('tag', 'is', null)
    .limit(2000);

  if (error) return c.json({ error: error.message }, 500);

  // フランチャイズ別にユニークなタグを集約
  const byFranchise: Record<string, string[]> = {};
  for (const row of data || []) {
    if (!row.tag) continue;
    if (!byFranchise[row.franchise]) byFranchise[row.franchise] = [];
    if (!byFranchise[row.franchise].includes(row.tag)) {
      byFranchise[row.franchise].push(row.tag);
    }
  }

  // ソート
  for (const f of Object.keys(byFranchise)) {
    byFranchise[f].sort();
  }

  return c.json(byFranchise);
});

/** 画像URLヘルスチェック（バッチ） */
dbCardRoutes.post('/db-cards/health-check', async (c) => {
  const supabase = createSupabaseClient();

  // image_url があるカードを全取得（Supabaseの1000件制限をページネーションで回避）
  const allCards: { id: string; image_url: string }[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data: page, error } = await supabase
      .from('db_card')
      .select('id, image_url')
      .not('image_url', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) return c.json({ error: error.message }, 500);
    if (!page || page.length === 0) break;
    allCards.push(...(page as { id: string; image_url: string }[]));
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const cards = allCards;
  if (cards.length === 0) return c.json({ checked: 0, ok: 0, dead: 0 });

  let okCount = 0;
  let deadCount = 0;

  // 並列度を制限して HEAD → GET フォールバックでチェック
  const CONCURRENCY = 20;
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
  };
  const results: { id: string; status: 'ok' | 'dead' }[] = [];

  for (let i = 0; i < cards.length; i += CONCURRENCY) {
    const batch = cards.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (card) => {
        const url = card.image_url!;
        // HEAD で試行
        try {
          const c1 = new AbortController();
          const t1 = setTimeout(() => c1.abort(), 8000);
          const r1 = await fetch(url, { method: 'HEAD', signal: c1.signal, redirect: 'follow', headers: browserHeaders });
          clearTimeout(t1);
          if (r1.ok) return { id: card.id, status: 'ok' as const };
          // Cloudflare JS Challenge: URLは存在するがボット対策
          if (r1.status === 403 && r1.headers.get('cf-mitigated') === 'challenge') return { id: card.id, status: 'ok' as const };
          if (r1.status === 404 || r1.status === 410) return { id: card.id, status: 'dead' as const };
        } catch { /* fallback */ }
        // GET フォールバック
        try {
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 8000);
          const r2 = await fetch(url, { method: 'GET', signal: c2.signal, redirect: 'follow', headers: { ...browserHeaders, Range: 'bytes=0-0' } });
          clearTimeout(t2);
          if (r2.ok || r2.status === 206) return { id: card.id, status: 'ok' as const };
          if (r2.status === 403 && r2.headers.get('cf-mitigated') === 'challenge') return { id: card.id, status: 'ok' as const };
        } catch { /* dead */ }
        return { id: card.id, status: 'dead' as const };
      })
    );
    results.push(...batchResults);
  }

  // バッチで Supabase 更新
  const okIds = results.filter((r) => r.status === 'ok').map((r) => r.id);
  const deadIds = results.filter((r) => r.status === 'dead').map((r) => r.id);

  if (okIds.length > 0) {
    // 100件ずつ更新
    for (let i = 0; i < okIds.length; i += 100) {
      const chunk = okIds.slice(i, i + 100);
      await supabase.from('db_card').update({ image_status: 'ok' }).in('id', chunk);
    }
    okCount = okIds.length;
  }

  if (deadIds.length > 0) {
    for (let i = 0; i < deadIds.length; i += 100) {
      const chunk = deadIds.slice(i, i + 100);
      await supabase.from('db_card').update({ image_status: 'dead' }).in('id', chunk);
    }
    deadCount = deadIds.length;
  }

  console.log(`[health-check] 完了: ${cards.length}件チェック, ok=${okCount}, dead=${deadCount}`);

  return c.json({ checked: cards.length, ok: okCount, dead: deadCount });
});

/** db_card 個別更新（tag / alt_image_url / card_name） + シート書き戻し */
dbCardRoutes.patch('/db-cards/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ tag?: string; alt_image_url?: string; card_name?: string }>();
  const supabase = createSupabaseClient();

  // 更新対象フィールドを構築
  const updates: Record<string, string | null> = {};
  const sheetUpdates: { field: string; value: string }[] = [];

  if (body.tag !== undefined) {
    updates.tag = body.tag || null;
    sheetUpdates.push({ field: 'tag', value: body.tag || '' });
  }
  if (body.alt_image_url !== undefined) {
    updates.alt_image_url = body.alt_image_url || null;
    sheetUpdates.push({ field: 'alt_image_url', value: body.alt_image_url || '' });
  }
  if (body.card_name !== undefined) {
    updates.card_name = body.card_name || null;
    sheetUpdates.push({ field: 'card_name', value: body.card_name || '' });
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  updates.updated_at = new Date().toISOString();

  // Supabase 更新
  const { data, error } = await supabase
    .from('db_card')
    .update(updates)
    .eq('id', id)
    .select('id, franchise, tag, card_name, grade, list_no, image_url, alt_image_url, rarity_icon, sheet_row_number, image_status')
    .single();

  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Card not found' }, 404);

  // シート書き戻し（非同期、エラーでもAPIレスポンスには影響しない）
  if (data.sheet_row_number) {
    for (const su of sheetUpdates) {
      updateDbSheetCell(data.sheet_row_number, su.field, su.value).catch((err) => {
        console.error(`[sheet] セル更新エラー: ${err.message}`);
      });
    }
  }

  return c.json(data);
});

/** db_card 削除 */
dbCardRoutes.delete('/db-cards/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();

  const { error } = await supabase
    .from('db_card')
    .delete()
    .eq('id', id);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ ok: true });
});
