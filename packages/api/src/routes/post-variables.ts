import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { hasForbiddenFields, pickAllowedFields, STORE_NAME } from '../lib/store-scope.js';

export const postVariableRoutes = new Hono();

const VARIABLE_MUTABLE_FIELDS = ['label', 'default_value', 'description'] as const;
const VARIABLE_FORBIDDEN_FIELDS = ['id', 'store', 'key', 'source', 'resolve_type', 'is_deletable', 'created_at'] as const;

postVariableRoutes.get('/post/variables', async (c) => {
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('variable_registry')
    .select('*')
    .eq('store', STORE_NAME)
    .order('source', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

postVariableRoutes.get('/post/variables/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('variable_registry')
    .select('*')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Variable not found' }, 404);
  return c.json(data);
});

postVariableRoutes.post('/post/variables', async (c) => {
  const body = await c.req.json<{ key: string; label: string; default_value?: string; description?: string; store?: unknown }>();
  if (hasForbiddenFields(body, ['id', 'store', 'source', 'resolve_type', 'is_deletable', 'created_at'])) {
    return c.json({ error: 'Store and server-managed fields cannot be supplied' }, 400);
  }
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
      store: STORE_NAME,
    })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data, 201);
});

postVariableRoutes.patch('/post/variables/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: existing, error: existingError } = await supabase
    .from('variable_registry')
    .select('source')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (existingError) return c.json({ error: existingError.message }, 500);
  if (!existing) return c.json({ error: 'Variable not found' }, 404);
  if (existing?.source === 'system') {
    return c.json({ error: 'System variables cannot be modified' }, 403);
  }
  const body = await c.req.json<{ label?: string; default_value?: string; description?: string; store?: unknown }>();
  if (hasForbiddenFields(body, VARIABLE_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Store and identity fields cannot be changed' }, 400);
  }
  const update = pickAllowedFields<Record<string, unknown>>(body, VARIABLE_MUTABLE_FIELDS);
  if (Object.keys(update).length === 0) return c.json({ error: 'No editable fields supplied' }, 400);
  const { data, error } = await supabase
    .from('variable_registry')
    .update(update)
    .eq('id', id)
    .eq('store', STORE_NAME)
    .select()
    .maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Variable not found' }, 404);
  return c.json(data);
});

postVariableRoutes.delete('/post/variables/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();
  const { data: existing, error: existingError } = await supabase
    .from('variable_registry')
    .select('is_deletable')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (existingError) return c.json({ error: existingError.message }, 500);
  if (!existing) return c.json({ error: 'Variable not found' }, 404);
  if (!existing?.is_deletable) {
    return c.json({ error: 'This variable cannot be deleted' }, 403);
  }
  const { data, error } = await supabase.from('variable_registry').delete().eq('id', id).eq('store', STORE_NAME).select('id').maybeSingle();
  if (error) return c.json({ error: error.message }, 500);
  if (!data) return c.json({ error: 'Variable not found' }, 404);
  return c.json({ success: true });
});
