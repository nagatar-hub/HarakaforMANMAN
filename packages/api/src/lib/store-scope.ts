import type { createSupabaseClient } from './supabase.js';

export const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';

type SupabaseClient = ReturnType<typeof createSupabaseClient>;

export type OwnedRun = {
  id: string;
  store: string;
};

export type OwnedPostPlan = {
  id: string;
  store: string;
  run_id: string | null;
  [key: string]: unknown;
};

export type OwnedPostItem = {
  id: string;
  post_plan_id: string;
  [key: string]: unknown;
};

function throwQueryError(resource: string, error: { message: string } | null): void {
  if (error) throw new Error(`Failed to fetch ${resource}: ${error.message}`);
}

/**
 * Tables without a direct store column must only be accessed after their
 * store-owning parent has been verified. A missing row and a row from another
 * store are deliberately indistinguishable to callers.
 */
export async function getOwnedRun(
  supabase: SupabaseClient,
  runId: string,
): Promise<OwnedRun | null> {
  const { data, error } = await supabase
    .from('run')
    .select('id, store')
    .eq('id', runId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  throwQueryError('run', error);
  return data as OwnedRun | null;
}

export async function getOwnedPostPlan(
  supabase: SupabaseClient,
  planId: string,
): Promise<OwnedPostPlan | null> {
  const { data, error } = await supabase
    .from('post_plan')
    .select('*')
    .eq('id', planId)
    .eq('store', STORE_NAME)
    .maybeSingle();
  throwQueryError('post plan', error);
  const plan = data as OwnedPostPlan | null;
  if (!plan) return null;
  if (plan.run_id && !await getOwnedRun(supabase, plan.run_id)) return null;
  return plan;
}

export async function getOwnedPostItem(
  supabase: SupabaseClient,
  itemId: string,
): Promise<OwnedPostItem | null> {
  const { data, error } = await supabase
    .from('post_item')
    .select('*')
    .eq('id', itemId)
    .maybeSingle();
  throwQueryError('post item', error);
  const item = data as OwnedPostItem | null;
  if (!item) return null;

  const plan = await getOwnedPostPlan(supabase, item.post_plan_id);
  return plan ? item : null;
}

export async function getOwnedPostAsset(
  supabase: SupabaseClient,
  assetId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('post_item_asset')
    .select('*')
    .eq('id', assetId)
    .maybeSingle();
  throwQueryError('post item asset', error);
  const asset = data as { post_item_id?: string } | null;
  if (!asset?.post_item_id) return null;

  const item = await getOwnedPostItem(supabase, asset.post_item_id);
  return item ? data as Record<string, unknown> : null;
}

export function hasForbiddenFields(
  body: unknown,
  forbidden: readonly string[],
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return forbidden.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

export function pickAllowedFields<T extends Record<string, unknown>>(
  body: unknown,
  allowed: readonly string[],
): Partial<T> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const source = body as Record<string, unknown>;
  return Object.fromEntries(
    allowed
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, source[key]]),
  ) as Partial<T>;
}
