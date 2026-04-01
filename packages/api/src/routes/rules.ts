import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import type { Database } from '@haraka/shared';

type RuleInsert = Database['public']['Tables']['rule']['Insert'];
type RuleUpdate = Database['public']['Tables']['rule']['Update'];

export const ruleRoutes = new Hono();

ruleRoutes.get('/rules', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').select('*').order('priority', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

ruleRoutes.post('/rules', async (c) => {
  const body = await c.req.json<RuleInsert>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').insert(body).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

ruleRoutes.patch('/rules/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<RuleUpdate>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('rule').update(body).eq('id', id).select().single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

ruleRoutes.delete('/rules/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('rule').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

/** タグ別カード枚数統計（過去N回のrun） */
ruleRoutes.get('/tag-stats', async (c) => {
  const franchise = c.req.query('franchise') || 'Pokemon';
  const runs = parseInt(c.req.query('runs') || '5');
  const supabase = createSupabaseClient();

  // 過去N回のcompleted runを取得
  const { data: recentRuns } = await supabase
    .from('run')
    .select('id')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(runs);

  if (!recentRuns || recentRuns.length === 0) {
    return c.json({ franchise, run_count: 0, tags: [] });
  }

  const runIds = recentRuns.map(r => r.id);

  // 各runのprepared_cardからタグ別カード数を集計（1000件制限を回避するためrunごとに取得）
  const allCards: { run_id: string; tag: string | null }[] = [];
  for (const runId of runIds) {
    const { data, error: fetchError } = await supabase
      .from('prepared_card')
      .select('run_id, tag')
      .eq('run_id', runId)
      .eq('franchise', franchise)
      .not('tag', 'is', null)
      .not('price_high', 'is', null)
      .gt('price_high', 0);
    if (fetchError) return c.json({ error: fetchError.message }, 500);
    if (data) allCards.push(...data);
  }

  // メインタグ別・run別にカウント
  const tagRunCounts = new Map<string, Map<string, number>>();
  for (const card of allCards) {
    const mainTag = card.tag!.includes('/') ? card.tag!.split('/')[0] : card.tag!;
    if (!tagRunCounts.has(mainTag)) tagRunCounts.set(mainTag, new Map());
    const runMap = tagRunCounts.get(mainTag)!;
    runMap.set(card.run_id, (runMap.get(card.run_id) || 0) + 1);
  }

  // 統計算出
  const tags = Array.from(tagRunCounts.entries()).map(([tag, runMap]) => {
    const counts = Array.from(runMap.values());
    const avg = counts.reduce((a, b) => a + b, 0) / runIds.length;
    return {
      tag,
      avg_count: Math.round(avg * 10) / 10,
      min_count: Math.min(...counts),
      max_count: Math.max(...counts),
      appeared_in: counts.length,
    };
  }).sort((a, b) => b.avg_count - a.avg_count);

  return c.json({ franchise, run_count: runIds.length, tags });
});
