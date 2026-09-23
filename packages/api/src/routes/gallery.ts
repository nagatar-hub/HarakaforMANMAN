import { Hono } from 'hono';
import { fork } from 'child_process';
import path from 'path';
import type { Database } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { loadTokyoGalleryPricing } from '../lib/gallery-pricing.js';
import { authorizeInternalApiRequest } from '../lib/internal-api-auth.js';
import {
  summarizeGalleryDates,
  utcRangeForJstDate,
  type GalleryDatePageRow,
  type GalleryRunRow,
} from '../lib/gallery-utils.js';

export const galleryRoutes = new Hono();

const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';

type StoreOwnership = { runId: string | null; error: string | null };

async function findPageRunInStore(
  supabase: ReturnType<typeof createSupabaseClient>,
  pageId: string,
): Promise<StoreOwnership> {
  const { data: page, error: pageError } = await supabase
    .from('generated_page')
    .select('run_id')
    .eq('id', pageId)
    .maybeSingle();
  if (pageError) return { runId: null, error: pageError.message };
  if (!page) return { runId: null, error: null };

  const { data: run, error: runError } = await supabase
    .from('run')
    .select('id')
    .eq('id', page.run_id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (runError) return { runId: null, error: runError.message };
  return { runId: run?.id ?? null, error: null };
}

async function findCardRunInStore(
  supabase: ReturnType<typeof createSupabaseClient>,
  cardId: string,
): Promise<StoreOwnership> {
  const { data: card, error: cardError } = await supabase
    .from('prepared_card')
    .select('run_id')
    .eq('id', cardId)
    .maybeSingle();
  if (cardError) return { runId: null, error: cardError.message };
  if (!card) return { runId: null, error: null };

  const { data: run, error: runError } = await supabase
    .from('run')
    .select('id')
    .eq('id', card.run_id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (runError) return { runId: null, error: runError.message };
  return { runId: run?.id ?? null, error: null };
}

async function findCardIdsInStore(
  supabase: ReturnType<typeof createSupabaseClient>,
  cardIds: string[],
): Promise<{ cardIds: string[]; error: string | null }> {
  const { data: cards, error: cardError } = await supabase
    .from('prepared_card')
    .select('id, run_id')
    .in('id', cardIds);
  if (cardError) return { cardIds: [], error: cardError.message };

  const runIds = [...new Set((cards || []).map(card => card.run_id))];
  if (runIds.length === 0) return { cardIds: [], error: null };
  const { data: runs, error: runError } = await supabase
    .from('run')
    .select('id')
    .in('id', runIds)
    .eq('store', STORE_NAME);
  if (runError) return { cardIds: [], error: runError.message };

  const ownedRunIds = new Set((runs || []).map(run => run.id));
  return {
    cardIds: (cards || []).filter(card => ownedRunIds.has(card.run_id)).map(card => card.id),
    error: null,
  };
}

async function fetchGeneratedPageRowsForRuns(
  supabase: ReturnType<typeof createSupabaseClient>,
  runIds: string[],
): Promise<{ rows: GalleryDatePageRow[]; error?: string }> {
  const rows: GalleryDatePageRow[] = [];
  const pageSize = 1000;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('generated_page')
      .select('run_id, franchise')
      .in('status', ['generated', 'pending', 'failed'])
      .in('run_id', runIds)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) return { rows, error: error.message };

    const chunk = (data || []) as GalleryDatePageRow[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }

  return { rows };
}

/** 日付一覧: 日付内の全 run を対象に generated_page のフランチャイズ数を集計 */
galleryRoutes.get('/gallery/dates', async (c) => {
  const supabase = createSupabaseClient();

  const { data: runs, error: runError } = await supabase
    .from('run')
    .select('id, started_at')
    .eq('store', STORE_NAME)
    .eq('status', 'completed')
    .not('generate_done_at', 'is', null)
    .order('started_at', { ascending: false })
    .limit(50);

  if (runError) return c.json({ error: runError.message }, 500);
  if (!runs || runs.length === 0) return c.json([]);

  const targetRuns = runs as GalleryRunRow[];

  const { rows: pages, error } = await fetchGeneratedPageRowsForRuns(
    supabase,
    targetRuns.map(r => r.id),
  );
  if (error) return c.json({ error }, 500);

  // run の JST 日付で集計する。Storage パスは UTC 日付になることがあるため使わない。
  return c.json(summarizeGalleryDates(targetRuns, pages || []));
});

/** 特定日の画像一覧（run情報付き） */
galleryRoutes.get('/gallery/images', async (c) => {
  const date = c.req.query('date'); // YYYY-MM-DD
  const franchise = c.req.query('franchise');

  if (!date) return c.json({ error: 'date is required' }, 400);

  const supabase = createSupabaseClient();
  const { from, to } = utcRangeForJstDate(date);

  const { data: runs, error: runError } = await supabase
    .from('run')
    .select('id, started_at')
    .eq('store', STORE_NAME)
    .eq('status', 'completed')
    .not('generate_done_at', 'is', null)
    .gte('started_at', from)
    .lt('started_at', to)
    .order('started_at', { ascending: false });

  if (runError) return c.json({ error: runError.message }, 500);
  if (!runs || runs.length === 0) return c.json([]);

  const runStartedAt = new Map(runs.map(r => [r.id, r.started_at]));

  let query = supabase
    .from('generated_page')
    .select('id, run_id, franchise, page_index, page_label, card_ids, image_key, image_url, status, error_message, created_at, run:run_id(started_at)')
    .in('status', ['generated', 'pending', 'failed'])
    .in('run_id', runs.map(r => r.id))
    .order('created_at', { ascending: false })
    .order('franchise')
    .order('page_index');

  if (franchise) {
    query = query.eq('franchise', franchise);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // run情報をフラットに展開
  const pages = (data || []).map((p: Record<string, unknown>) => {
    const run = p.run as { started_at: string } | null;
    return {
      ...p,
      run_started_at: runStartedAt.get(p.run_id as string) || run?.started_at || p.created_at,
      run: undefined,
    };
  });

  return c.json(pages);
});

/** ページ詳細: generated_page + 紐づくカードデータ取得 */
galleryRoutes.get('/gallery/pages/:pageId', async (c) => {
  const pageId = c.req.param('pageId');
  const includePricing = STORE_NAME === 'manman-akihabara'
    && authorizeInternalApiRequest(c.req.header('authorization')) === 'authorized';
  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  // card_ids の順序を保持してカード取得
  const cardIds: string[] = (page as Record<string, unknown>).card_ids as string[] || [];
  if (cardIds.length === 0) return c.json({ page, cards: [] });

  const cardOwnership = await findCardIdsInStore(supabase, cardIds);
  if (cardOwnership.error) return c.json({ error: cardOwnership.error }, 500);
  if (new Set(cardOwnership.cardIds).size !== new Set(cardIds).size) {
    return c.json({ error: 'Page contains cards outside this store' }, 409);
  }

  const cardQuery = includePricing
    ? supabase.from('prepared_card').select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, price_low, image_status, run_id, source_shinsoku_id')
    : supabase.from('prepared_card').select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, price_low, image_status');
  const { data: cards, error: cardErr } = await cardQuery.in('id', cardOwnership.cardIds);

  if (cardErr) return c.json({ error: cardErr.message }, 500);

  // card_ids の並び順にソート
  const cardMap = new Map((cards || []).map(c => [c.id, c]));
  const orderedCards = cardIds.map(id => cardMap.get(id)).filter(Boolean);

  if (includePricing) {
    try {
      const pricing = await loadTokyoGalleryPricing(supabase, orderedCards as unknown as Parameters<typeof loadTokyoGalleryPricing>[1]);
      return c.json({ page, cards: orderedCards.map(card => {
        const { run_id, source_shinsoku_id, ...publicCard } = card as unknown as Record<string, unknown>;
        return { ...publicCard, pricing: pricing.get(publicCard.id as string) };
      }) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '掲載価格の読込に失敗しました' }, 500);
    }
  }
  return c.json({ page, cards: orderedCards });
});

/** カードデータ更新 */
galleryRoutes.patch('/gallery/pages/:pageId/cards/:cardId', async (c) => {
  const { pageId, cardId } = c.req.param();
  const body = await c.req.json<{
    price_high?: number;
    price_low?: number;
    image_url?: string;
    alt_image_url?: string;
    tag?: string | null;
  }>();

  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  // ページに紐づくカードか確認
  const { data: page } = await supabase
    .from('generated_page')
    .select('card_ids')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (!page || !((page as Record<string, unknown>).card_ids as string[] || []).includes(cardId)) {
    return c.json({ error: 'Card not found in this page' }, 404);
  }
  const cardOwnership = await findCardRunInStore(supabase, cardId);
  if (cardOwnership.error) return c.json({ error: cardOwnership.error }, 500);
  if (!cardOwnership.runId) return c.json({ error: 'Card not found' }, 404);

  // 更新フィールドを構築
  const updates: Record<string, unknown> = {};
  if (body.price_high !== undefined) updates.price_high = body.price_high;
  if (body.price_low !== undefined) updates.price_low = body.price_low;
  if (body.image_url !== undefined) updates.image_url = body.image_url;
  if (body.alt_image_url !== undefined) updates.alt_image_url = body.alt_image_url;
  if (body.tag !== undefined) updates.tag = body.tag;

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  // 画像URL変更時はヘルスチェック
  if (body.image_url || body.alt_image_url) {
    const urlToCheck = body.image_url || body.alt_image_url;
    try {
      const r = await fetch(urlToCheck!, {
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok && !(r.status === 403 && r.headers.get('cf-mitigated') === 'challenge')) {
        return c.json({ error: 'Image URL is not accessible', status: r.status }, 400);
      }
    } catch {
      return c.json({ error: 'Image URL is not reachable' }, 400);
    }
  }

  const { data: updated, error } = await supabase
    .from('prepared_card')
    .update(updates as Database['public']['Tables']['prepared_card']['Update'])
    .eq('id', cardId)
    .eq('run_id', cardOwnership.runId)
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);

  return c.json(updated);
});

/** カード並び替え */
galleryRoutes.put('/gallery/pages/:pageId/reorder', async (c) => {
  const pageId = c.req.param('pageId');
  const { cardIds } = await c.req.json<{ cardIds: string[] }>();

  if (!Array.isArray(cardIds) || cardIds.length === 0) {
    return c.json({ error: 'cardIds array is required' }, 400);
  }

  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('card_ids')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  const currentIds = (page as Record<string, unknown>).card_ids as string[] || [];
  const currentSet = new Set(currentIds);
  const newSet = new Set(cardIds);
  if (currentSet.size !== newSet.size || ![...currentSet].every(id => newSet.has(id))) {
    return c.json({ error: 'cardIds must contain the same cards as current page' }, 400);
  }

  const { error } = await supabase
    .from('generated_page')
    .update({ card_ids: cardIds })
    .eq('id', pageId)
    .eq('run_id', ownership.runId);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ status: 'ok', cardIds });
});

/** カード検索（既存prepared_cardから） */
galleryRoutes.get('/gallery/cards/search', async (c) => {
  const q = c.req.query('q') || '';
  const franchise = c.req.query('franchise') || '';
  const excludeIds = c.req.query('exclude')?.split(',').filter(Boolean) || [];

  if (!q && !franchise) return c.json([]);

  const supabase = createSupabaseClient();
  const { data: storeRuns, error: storeRunsError } = await supabase
    .from('run')
    .select('id')
    .eq('store', STORE_NAME)
    .order('started_at', { ascending: false })
    .limit(100);
  if (storeRunsError) return c.json({ error: storeRunsError.message }, 500);
  if (!storeRuns || storeRuns.length === 0) return c.json([]);

  let query = supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, price_low, image_status, created_at')
    .in('run_id', storeRuns.map((run) => run.id))
    .order('created_at', { ascending: false })
    .limit(100);

  if (franchise) query = query.eq('franchise', franchise);
  if (q) query = query.ilike('card_name', `%${q}%`);

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // 同じカード名+グレード+品番の組み合わせで最新のものだけ残す
  const seen = new Set<string>();
  const deduped = (data || []).filter(card => {
    const key = `${card.card_name}|${card.grade || ''}|${card.list_no || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const results = excludeIds.length > 0
    ? deduped.filter(c => !excludeIds.includes(c.id))
    : deduped;

  return c.json(results.slice(0, 20));
});

/** ページにカード追加 */
galleryRoutes.post('/gallery/pages/:pageId/cards', async (c) => {
  const pageId = c.req.param('pageId');
  const body = await c.req.json<{
    cardId?: string;
    card_name?: string;
    tag?: string;
    price_high?: number;
    price_low?: number;
    image_url?: string;
    franchise?: string;
  }>();

  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('card_ids, franchise, run_id')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  const currentIds = (page as Record<string, unknown>).card_ids as string[] || [];
  if (currentIds.length >= 30) {
    return c.json({ error: 'ページは最大30枚です' }, 400);
  }

  let cardId = body.cardId;

  if (cardId) {
    const cardOwnership = await findCardRunInStore(supabase, cardId);
    if (cardOwnership.error) return c.json({ error: cardOwnership.error }, 500);
    if (!cardOwnership.runId) return c.json({ error: 'Card not found' }, 404);
  }

  if (!cardId) {
    // 手動追加: prepared_card にレコード作成
    if (!body.card_name) return c.json({ error: 'card_name は必須です' }, 400);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: newCard, error: insertErr } = await (supabase
      .from('prepared_card') as any)
      .insert({
        franchise: (page as Record<string, unknown>).franchise || body.franchise || 'Pokemon',
        card_name: body.card_name,
        tag: body.tag || null,
        price_high: body.price_high ?? null,
        price_low: body.price_low ?? null,
        image_url: body.image_url || null,
        alt_image_url: null,
        run_id: ownership.runId,
        raw_import_id: null,
        grade: null,
        list_no: null,
        rarity: null,
        rarity_icon_url: null,
        image_status: 'unchecked',
        source: 'manual',
      })
      .select('id')
      .single();

    if (insertErr || !newCard) return c.json({ error: `カード作成失敗: ${insertErr?.message}` }, 500);
    cardId = newCard.id;
  }

  if (!cardId) return c.json({ error: 'カードIDが不明です' }, 500);

  if (currentIds.includes(cardId)) {
    return c.json({ error: 'このカードは既にページに含まれています' }, 400);
  }

  const newIds = [...currentIds, cardId];
  const { error } = await supabase
    .from('generated_page')
    .update({ card_ids: newIds })
    .eq('id', pageId)
    .eq('run_id', ownership.runId);

  if (error) return c.json({ error: error.message }, 500);

  // 追加したカードのデータを返す
  const { data: card } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, image_url, alt_image_url, rarity, tag, price_high, price_low, image_status')
    .eq('id', cardId)
    .single();

  return c.json({ status: 'ok', card, total: newIds.length });
});

/** ページからカード削除 */
galleryRoutes.delete('/gallery/pages/:pageId/cards/:cardId', async (c) => {
  const { pageId, cardId } = c.req.param();
  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('card_ids')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  const currentIds = (page as Record<string, unknown>).card_ids as string[] || [];
  if (!currentIds.includes(cardId)) {
    return c.json({ error: 'Card not found in this page' }, 404);
  }

  const newIds = currentIds.filter(id => id !== cardId);

  const { error } = await supabase
    .from('generated_page')
    .update({ card_ids: newIds })
    .eq('id', pageId)
    .eq('run_id', ownership.runId);

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ status: 'ok', remaining: newIds.length });
});

/** 単一ページ再生成 */
galleryRoutes.post('/gallery/pages/:pageId/regenerate', async (c) => {
  const pageId = c.req.param('pageId');
  const supabase = createSupabaseClient();
  const ownership = await findPageRunInStore(supabase, pageId);
  if (ownership.error) return c.json({ error: ownership.error }, 500);
  if (!ownership.runId) return c.json({ error: 'Page not found' }, 404);
  // ページ情報取得
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .eq('run_id', ownership.runId)
    .single();

  if (pageErr || !page) return c.json({ error: 'Page not found' }, 404);

  // ステータスを pending に更新（ポーリングで完了検知するため）
  await supabase
    .from('generated_page')
    .update({ status: 'pending' })
    .eq('id', pageId)
    .eq('run_id', ownership.runId);

  // 子プロセスで再生成ジョブを起動（index.ts経由）
  const jobEntry = path.resolve(__dirname, '..', '..', '..', 'job', 'dist', 'index.js');

  const child = fork(jobEntry, [], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, JOB_NAME: 'regenerate-page', PAGE_ID: pageId, STORE_NAME },
  });
  child.unref();

  return c.json({ status: 'triggered', pageId, pid: child.pid });
});

const PRICE_HISTORY_LIMIT = 200;

type PriceHistoryEntry = {
  kind: 'regular' | 'custom';
  id: string;
  published_at: string;
  franchise: string;
  card_name: string;
  grade: string | null;
  list_no: string | null;
  tag: string | null;
  price_high: number | null;
  price_low: number | null;
  pricing?: Awaited<ReturnType<typeof loadTokyoGalleryPricing>> extends Map<string, infer P> ? P : never;
  custom?: {
    sheet_name: string;
    display_date: string;
    rendered_by: string | null;
    sheet_created_by: string | null;
    source_shop_name: string | null;
    override_reason: string | null;
    backfilled: boolean;
  };
};

/** 商品名・型番の部分一致（PostgREST or フィルタ用に引用符付きでエスケープ） */
export function buildPriceHistoryOrFilter(query: string, fields: string[]): string {
  const escaped = query.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return fields.map(field => `${field}.ilike."%${escaped}%"`).join(',');
}

/** 掲載履歴: 通常生成で画像に載ったカードと、カスタム買取表の画像生成記録を新しい順に返す */
galleryRoutes.get('/gallery/price-history', async (c) => {
  if (STORE_NAME !== 'manman-akihabara') return c.json({ error: 'Not found' }, 404);
  const auth = authorizeInternalApiRequest(c.req.header('authorization'));
  if (auth === 'misconfigured') return c.json({ error: 'API authentication is not configured' }, 503);
  if (auth !== 'authorized') return c.json({ error: 'Unauthorized' }, 401);
  const q = (c.req.query('q') ?? '').normalize('NFKC').trim();
  if (!q || q.length > 100) return c.json({ error: '検索語は1〜100文字で指定してください' }, 400);

  const supabase = createSupabaseClient();
  // ponytail: prepared_card を ILIKE で走査。遅くなったら pg_trgm インデックスを追加する
  const { data: cardRows, error: cardError } = await supabase
    .from('prepared_card')
    .select('id, run_id, franchise, card_name, grade, list_no, tag, price_high, price_low, source_shinsoku_id, run:run_id!inner(started_at)')
    .eq('run.store', STORE_NAME)
    .eq('run.status', 'completed')
    .not('run.generate_done_at', 'is', null)
    .or(buildPriceHistoryOrFilter(q, ['card_name', 'list_no']))
    .order('created_at', { ascending: false })
    .limit(PRICE_HISTORY_LIMIT);
  if (cardError) return c.json({ error: cardError.message }, 500);
  const cards = (cardRows ?? []) as unknown as Array<{
    id: string; run_id: string; franchise: string; card_name: string; grade: string | null; list_no: string | null;
    tag: string | null; price_high: number | null; price_low: number | null; source_shinsoku_id: string | null;
    run: { started_at: string };
  }>;

  // 画像に実際に載ったカードだけを掲載扱いにする
  // URL 長を抑えるため 50 件ずつ、対象カードを含むページだけを引く
  const publishedIds = new Set<string>();
  for (let i = 0; i < cards.length; i += 50) {
    const chunk = cards.slice(i, i + 50);
    const { data, error } = await supabase.from('generated_page').select('card_ids')
      .in('run_id', [...new Set(chunk.map(card => card.run_id))]).eq('status', 'generated')
      .overlaps('card_ids', chunk.map(card => card.id));
    if (error) return c.json({ error: error.message }, 500);
    for (const page of data ?? []) for (const id of page.card_ids ?? []) publishedIds.add(id);
  }
  const published = cards.filter(card => publishedIds.has(card.id));
  let pricing: Awaited<ReturnType<typeof loadTokyoGalleryPricing>>;
  try {
    pricing = await loadTokyoGalleryPricing(supabase, published);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : '掲載価格の読込に失敗しました' }, 500);
  }

  // カスタム買取表は画像生成ごとの掲載記録から引く（シートは上書き保存のため）
  const { data: logRows, error: logError } = await supabase
    .from('custom_buyback_render_log')
    .select('id, rendered_at, rendered_by, sheet_name, sheet_created_by, franchise, display_date, card_name, grade, list_no, tag, final_price_high, source_shop_name, override_reason, backfilled')
    .eq('store', STORE_NAME)
    .or(buildPriceHistoryOrFilter(q, ['card_name', 'list_no']))
    .order('rendered_at', { ascending: false })
    .limit(PRICE_HISTORY_LIMIT);
  if (logError) return c.json({ error: logError.message }, 500);
  const logs = logRows ?? [];

  const entries: PriceHistoryEntry[] = [
    ...published.map(card => ({
      kind: 'regular' as const, id: card.id, published_at: card.run.started_at, franchise: card.franchise,
      card_name: card.card_name, grade: card.grade, list_no: card.list_no, tag: card.tag,
      price_high: card.price_high, price_low: card.price_low, pricing: pricing.get(card.id),
    })),
    ...logs.map(log => ({
      kind: 'custom' as const, id: log.id, published_at: log.rendered_at, franchise: log.franchise,
      card_name: log.card_name, grade: log.grade, list_no: log.list_no, tag: log.tag,
      // カスタム画像は1価格表示（下限は描画しない）
      price_high: log.final_price_high, price_low: null,
      custom: {
        sheet_name: log.sheet_name, display_date: log.display_date, rendered_by: log.rendered_by,
        sheet_created_by: log.sheet_created_by, source_shop_name: log.source_shop_name,
        override_reason: log.override_reason, backfilled: log.backfilled,
      },
    })),
  ].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));

  return c.json({
    entries,
    truncated: cards.length >= PRICE_HISTORY_LIMIT || logs.length >= PRICE_HISTORY_LIMIT,
  });
});
