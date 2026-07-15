import { Hono } from 'hono';
import {
  DEFAULT_STORE_PRICING_SETTINGS,
  mergeStorePricingSettings,
  normalizeStorePricingSettings,
} from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';

export const storeConfigRoutes = new Hono();

const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';
type StoreConfigResult = {
  store?: string;
  settings?: unknown;
  updated_at?: string;
};

storeConfigRoutes.get('/store-config', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('store_config')
    .select('*')
    .eq('store', STORE_NAME)
    .single();

  if (error) {
    // レコードが存在しない場合はデフォルト値を返す
    return c.json({ store: STORE_NAME, settings: DEFAULT_STORE_PRICING_SETTINGS });
  }
  const config = data as StoreConfigResult;
  return c.json({ ...config, settings: normalizeStorePricingSettings(config.settings) });
});

storeConfigRoutes.patch('/store-config', async (c) => {
  const body = await c.req.json<{ settings: Record<string, unknown> }>();
  const supabase = createSupabaseClient();

  const { data: existing } = await supabase
    .from('store_config')
    .select('settings')
    .eq('store', STORE_NAME)
    .single();

  const mergedSettings = mergeStorePricingSettings(existing?.settings, body.settings);

  const { data, error } = await supabase
    .from('store_config')
    .upsert({ store: STORE_NAME, settings: mergedSettings, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});
