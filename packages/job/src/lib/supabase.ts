import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@haraka/shared';

export function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return createClient<Database>(url, key);
}

/**
 * 環境変数を優先し、なければ Secret Manager から取得するフォールバック版。
 * Cloud Run Jobs 環境で環境変数が未設定でも動作する。
 */
export async function createSupabaseClientFromSecrets(): Promise<SupabaseClient<Database>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (url && key) {
    return createClient<Database>(url, key);
  }

  // Secret Manager フォールバック
  const { getSecret } = await import('./secret-manager.js');
  const smUrl = await getSecret('supabase-url');
  const smKey = await getSecret('supabase-service-role-key');

  if (!smUrl || !smKey) {
    throw new Error('SUPABASE credentials not found in env vars or Secret Manager');
  }

  return createClient<Database>(smUrl, smKey);
}
