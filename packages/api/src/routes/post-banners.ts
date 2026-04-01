import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import type { BannerPositionType } from '@haraka/shared';

export const postBannerRoutes = new Hono();

postBannerRoutes.get('/post/banners', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postBannerRoutes.post('/post/banners', async (c) => {
  const body = await c.req.json<{
    name: string;
    franchise?: string;
    image_url: string;
    position_type?: string;
    is_default?: boolean;
  }>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .insert({
      name: body.name,
      franchise: body.franchise || null,
      image_url: body.image_url,
      position_type: (body.position_type || 'last') as BannerPositionType,
      is_default: body.is_default ?? false,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postBannerRoutes.patch('/post/banners/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_banner')
    .update(body)
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postBannerRoutes.delete('/post/banners/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('post_banner').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
