import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { appendTagToHarakaDB } from '../lib/haraka-db-sheet.js';

export const cardRoutes = new Hono();

/** タグ未設定カード一覧（最新run） */
cardRoutes.get('/cards/untagged', async (c) => {
  const supabase = createSupabaseClient();

  // 最新の completed run を取得
  const { data: latestRun } = await supabase
    .from('run')
    .select('id')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRun) return c.json([]);

  const { data, error } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, price_high, image_url, rarity, source')
    .eq('run_id', latestRun.id)
    .is('tag', null)
    .order('franchise')
    .order('price_high', { ascending: false });

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data || []);
});

/** 既存タグ一覧（サジェスト用） */
cardRoutes.get('/cards/tags', async (c) => {
  const franchise = c.req.query('franchise');
  const supabase = createSupabaseClient();

  // 最新の completed run
  const { data: latestRun } = await supabase
    .from('run')
    .select('id')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRun) return c.json([]);

  let query = supabase
    .from('prepared_card')
    .select('tag')
    .eq('run_id', latestRun.id)
    .not('tag', 'is', null);

  if (franchise) query = query.eq('franchise', franchise);

  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);

  // DISTINCT tags
  const tags = [...new Set((data || []).map((r) => r.tag as string))].sort();
  return c.json(tags);
});

/** タグ更新 + Haraka DBシートへ書き戻し */
cardRoutes.patch('/cards/:id/tag', async (c) => {
  const id = c.req.param('id');
  const { tag } = await c.req.json<{ tag: string }>();

  if (!tag || !tag.trim()) return c.json({ error: 'tag is required' }, 400);

  const trimmedTag = tag.trim();
  const supabase = createSupabaseClient();

  // 1. カード情報を取得（シート書き戻しに必要）
  const { data: card, error: fetchError } = await supabase
    .from('prepared_card')
    .select('id, franchise, card_name, grade, list_no, image_url, tag')
    .eq('id', id)
    .single();

  if (fetchError || !card) return c.json({ error: fetchError?.message || 'Card not found' }, 500);

  // 2. prepared_card のタグを更新
  const { data, error } = await supabase
    .from('prepared_card')
    .update({ tag: trimmedTag })
    .eq('id', id)
    .select('id, tag')
    .single();

  if (error) return c.json({ error: error.message }, 500);

  // 3. Haraka DBシートに非同期で書き戻し（失敗してもタグ保存自体は成功）
  appendTagToHarakaDB(card, trimmedTag).catch((err) => {
    console.error('Haraka DBシート書き戻し失敗:', err instanceof Error ? err.message : err);
  });

  return c.json(data);
});
