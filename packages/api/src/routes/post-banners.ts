import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { hasForbiddenFields, pickAllowedFields, STORE_NAME } from '../lib/store-scope.js';
import type { BannerPositionType, Database } from '@haraka/shared';

export const postBannerRoutes = new Hono();

const BANNER_MUTABLE_FIELDS = ['name', 'franchise', 'image_url', 'position_type', 'is_default'] as const;
const BANNER_FORBIDDEN_FIELDS = ['id', 'store', 'created_at'] as const;

postBannerRoutes.get('/post/banners', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .select('*')
    .eq('store', STORE_NAME)
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postBannerRoutes.get('/post/banners/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .select('*')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Banner not found' }, 404);
  return c.json(data);
});

postBannerRoutes.post('/post/banners', async (c) => {
  const body = await c.req.json<{
    name: string;
    franchise?: string;
    image_url: string;
    position_type?: string;
    is_default?: boolean;
    store?: unknown;
  }>();
  if (hasForbiddenFields(body, BANNER_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Store and server-managed fields cannot be supplied' }, 400);
  }
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .insert({
      name: body.name,
      franchise: body.franchise || null,
      image_url: body.image_url,
      position_type: (body.position_type || 'last') as BannerPositionType,
      is_default: body.is_default ?? false,
      store: STORE_NAME,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postBannerRoutes.patch('/post/banners/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (hasForbiddenFields(body, BANNER_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Store and server-managed fields cannot be changed' }, 400);
  }
  const update = pickAllowedFields<Record<string, unknown>>(body, BANNER_MUTABLE_FIELDS);
  if (Object.keys(update).length === 0) return c.json({ error: 'No editable fields supplied' }, 400);
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .update(update as Database['public']['Tables']['post_banner']['Update'])
    .eq('id', id)
    .eq('store', STORE_NAME)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Banner not found' }, 404);
  return c.json(data);
});

postBannerRoutes.delete('/post/banners/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('post_banner').delete().eq('id', id).eq('store', STORE_NAME).select('id').maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Banner not found' }, 404);
  return c.json({ success: true });
});
