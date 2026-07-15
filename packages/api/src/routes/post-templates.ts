import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { hasForbiddenFields, pickAllowedFields, STORE_NAME } from '../lib/store-scope.js';

export const postTemplateRoutes = new Hono();

const TEMPLATE_MUTABLE_FIELDS = ['name', 'franchise', 'header_template', 'item_template', 'is_default'] as const;
const TEMPLATE_FORBIDDEN_FIELDS = ['id', 'store', 'created_at', 'updated_at'] as const;

postTemplateRoutes.get('/post/templates', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .select('*')
    .eq('store', STORE_NAME)
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
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Template not found' }, 404);
  return c.json(data);
});

postTemplateRoutes.post('/post/templates', async (c) => {
  const body = await c.req.json<{
    name: string;
    franchise?: string;
    header_template: string;
    item_template?: string;
    is_default?: boolean;
    store?: unknown;
  }>();
  if (hasForbiddenFields(body, TEMPLATE_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Store and server-managed fields cannot be supplied' }, 400);
  }
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .insert({
      name: body.name,
      franchise: body.franchise || null,
      header_template: body.header_template,
      item_template: body.item_template || null,
      is_default: body.is_default ?? false,
      store: STORE_NAME,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postTemplateRoutes.patch('/post/templates/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (hasForbiddenFields(body, TEMPLATE_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Store and server-managed fields cannot be changed' }, 400);
  }
  const update = pickAllowedFields<Record<string, unknown>>(body, TEMPLATE_MUTABLE_FIELDS);
  if (Object.keys(update).length === 0) return c.json({ error: 'No editable fields supplied' }, 400);
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_template')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('store', STORE_NAME)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Template not found' }, 404);
  return c.json(data);
});

postTemplateRoutes.delete('/post/templates/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase.from('post_template').delete().eq('id', id).eq('store', STORE_NAME).select('id').maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Template not found' }, 404);
  return c.json({ success: true });
});
