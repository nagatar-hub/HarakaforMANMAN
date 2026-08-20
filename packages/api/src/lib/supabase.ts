import { createClient } from '@supabase/supabase-js';
import { createSupabaseApiKeyFetch, type Database } from '@haraka/shared';

export function createSupabaseClient(fetchImpl: typeof fetch = fetch) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient<Database>(url, key, {
    global: { fetch: createSupabaseApiKeyFetch(key, fetchImpl) },
  });
}
