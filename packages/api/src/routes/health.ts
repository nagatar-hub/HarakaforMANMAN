import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';

export const healthRoutes = new Hono();

healthRoutes.get('/health', async (c) => {
  const checks: Record<string, string> = {};
  try {
    const supabase = createSupabaseClient();
    const { error } = await supabase.from('run').select('id').limit(1);
    checks.supabase = error ? `error: ${error.message}` : 'ok';
  } catch (e) {
    checks.supabase = `error: ${(e as Error).message}`;
  }
  const allOk = Object.values(checks).every(v => v === 'ok');
  return c.json({ status: allOk ? 'healthy' : 'degraded', timestamp: new Date().toISOString(), checks }, allOk ? 200 : 503);
});
