import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';

export const postTemplateRoutes = new Hono();

postTemplateRoutes.get('/post/templates', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postTemplateRoutes.get('/post/templates/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .select('*')
    .eq('id', id)
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postTemplateRoutes.post('/post/templates', async (c) => {
  const body = await c.req.json<{
    name: string;
    franchise?: string;
    header_template: string;
    item_template?: string;
    is_default?: boolean;
  }>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .insert({
      name: body.name,
      franchise: body.franchise || null,
      header_template: body.header_template,
      item_template: body.item_template || null,
      is_default: body.is_default ?? false,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postTemplateRoutes.patch('/post/templates/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postTemplateRoutes.delete('/post/templates/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { error } = await supabase.from('post_template').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
