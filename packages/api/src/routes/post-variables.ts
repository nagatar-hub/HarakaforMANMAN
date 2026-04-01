import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';

export const postVariableRoutes = new Hono();

postVariableRoutes.get('/post/variables', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('variable_registry')
    .select('*')
    .order('source', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postVariableRoutes.post('/post/variables', async (c) => {
  const body = await c.req.json<{ key: string; label: string; default_value?: string; description?: string }>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('variable_registry')
    .insert({
      key: body.key,
      label: body.label,
      source: 'custom',
      resolve_type: 'static',
      default_value: body.default_value || null,
      description: body.description || null,
      is_deletable: true,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postVariableRoutes.patch('/post/variables/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: existing } = await supabase
    .from('variable_registry')
    .select('source')
    .eq('id', id)
    .single();
  if (existing?.source === 'system') {
    return c.json({ error: 'System variables cannot be modified' }, 403);
  }
  const body = await c.req.json<{ label?: string; default_value?: string; description?: string }>();
  const { data, error } = await supabase
    .from('variable_registry')
    .update(body)
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postVariableRoutes.delete('/post/variables/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: existing } = await supabase
    .from('variable_registry')
    .select('is_deletable')
    .eq('id', id)
    .single();
  if (!existing?.is_deletable) {
    return c.json({ error: 'This variable cannot be deleted' }, 403);
  }
  const { error } = await supabase.from('variable_registry').delete().eq('id', id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ success: true });
});
