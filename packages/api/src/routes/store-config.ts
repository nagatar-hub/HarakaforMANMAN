import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';

export const storeConfigRoutes = new Hono();

const STORE_NAME = process.env.STORE_NAME ?? 'oripark';

storeConfigRoutes.get('/store-config', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('store_config')
    .select('*')
    .eq('store', STORE_NAME)
    .single();

  if (error) {
    // レコードが存在しない場合はデフォルト値を返す
    return c.json({ store: STORE_NAME, settings: { box_shrink_discount_rate: 0.15 } });
  }
  return c.json(data);
});

storeConfigRoutes.patch('/store-config', async (c) => {
  const body = await c.req.json<{ settings: Record<string, unknown> }>();
  const supabase = createSupabaseClient();

  const { data: existing } = await supabase
    .from('store_config')
    .select('settings')
    .eq('store', STORE_NAME)
    .single();

  const mergedSettings = { ...(existing?.settings ?? {}), ...body.settings };

  const { data, error } = await supabase
    .from('store_config')
    .upsert({ store: STORE_NAME, settings: mergedSettings, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});
