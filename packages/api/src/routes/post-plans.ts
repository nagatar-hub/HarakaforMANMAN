import { Hono } from 'hono';
import type { Database } from '@haraka/shared';
import { createSupabaseClient } from '../lib/supabase.js';
import { generatePostPlans } from '../lib/plan-generator.js';
import { getXCredentials } from '../lib/x-auth.js';
import { uploadMedia, postTweet } from '../lib/x-client.js';
import {
  getOwnedPostItem,
  getOwnedPostPlan,
  getOwnedRun,
  hasForbiddenFields,
  pickAllowedFields,
  STORE_NAME,
} from '../lib/store-scope.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const PLAN_MUTABLE_FIELDS = ['template_id', 'banner_id', 'banner_position', 'x_credential_id', 'header_text', 'status'] as const;
const PLAN_FORBIDDEN_FIELDS = ['id', 'store', 'run_id', 'franchise', 'post_plan_id', 'thread_head_tweet_id', 'created_at', 'updated_at'] as const;
const ITEM_MUTABLE_FIELDS = ['tweet_text'] as const;
const ITEM_FORBIDDEN_FIELDS = ['id', 'store', 'run_id', 'post_plan_id', 'position', 'is_header', 'tweet_id', 'status', 'error_message', 'created_at'] as const;

type StoreOwnedReferenceTable = 'post_template' | 'post_banner' | 'x_credential';

type PlanRecord = Record<string, any> & {
  id: string;
  run_id: string | null;
  x_credential_id: string | null;
  thread_head_tweet_id: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function storeOwnedReferenceExists(
  supabase: ReturnType<typeof createSupabaseClient>,
  table: StoreOwnedReferenceTable,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from(table)
    .select('id')
    .eq('id', id)
    .eq('store', STORE_NAME)
    .maybeSingle();
  if (error) throw new Error(`Failed to validate ${table}: ${error.message}`);
  return Boolean(data);
}

async function validatePlanReferences(
  supabase: ReturnType<typeof createSupabaseClient>,
  update: Record<string, unknown>,
): Promise<string | null> {
  const references: Array<[string, StoreOwnedReferenceTable, string]> = [
    ['template_id', 'post_template', 'Template'],
    ['banner_id', 'post_banner', 'Banner'],
    ['x_credential_id', 'x_credential', 'X credential'],
  ];
  for (const [field, table, label] of references) {
    if (!Object.prototype.hasOwnProperty.call(update, field) || update[field] === null) continue;
    if (typeof update[field] !== 'string' || !await storeOwnedReferenceExists(supabase, table, update[field])) {
      return `${label} not found`;
    }
  }
  return null;
}

async function validateGeneratedPageAssets(
  supabase: ReturnType<typeof createSupabaseClient>,
  plan: PlanRecord,
  assets: Array<Record<string, any>>,
): Promise<void> {
  const pageIds = [...new Set(assets
    .map(asset => asset.generated_page_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (pageIds.length === 0) return;
  if (!plan.run_id) throw new Error('Plan has generated page assets but no run');

  const { data, error } = await supabase
    .from('generated_page')
    .select('id')
    .eq('run_id', plan.run_id)
    .in('id', pageIds);
  if (error) throw new Error('Failed to validate generated page assets: ' + error.message);
  if ((data?.length ?? 0) !== pageIds.length) {
    throw new Error('Generated page asset does not belong to this store run');
  }
}

export const postPlanRoutes = new Hono();

// F7: Generate plans for a run
postPlanRoutes.post('/post/plan/generate', async (c) => {
  const { run_id } = await c.req.json<{ run_id?: unknown }>();
  if (typeof run_id !== 'string' || !run_id) return c.json({ error: 'run_id is required' }, 400);

  try {
    const supabase = createSupabaseClient();
    if (!await getOwnedRun(supabase, run_id)) return c.json({ error: 'Run not found' }, 404);
    const planIds = await generatePostPlans(run_id);
    return c.json({ plan_ids: planIds, count: planIds.length }, 201);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Get plans for a run
postPlanRoutes.get('/post/plans', async (c) => {
  const runId = c.req.query('run_id');
  const supabase = createSupabaseClient();

  try {
    if (runId && !await getOwnedRun(supabase, runId)) return c.json({ error: 'Run not found' }, 404);
    let query = supabase
      .from('post_plan')
      .select('*')
      .eq('store', STORE_NAME)
      .order('created_at', { ascending: false });
    if (runId) query = query.eq('run_id', runId);
    const { data, error } = await query;
    if (error) return c.json({ error: error.message }, 500);
    return c.json(data);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Get single plan with items and assets
postPlanRoutes.get('/post/plan/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();

  try {
    const plan = await getOwnedPostPlan(supabase, id) as PlanRecord | null;
    if (!plan) return c.json({ error: 'Plan not found' }, 404);

    const { data: items, error: itemsError } = await supabase
      .from('post_item')
      .select('*')
      .eq('post_plan_id', id)
      .order('position');
    if (itemsError) return c.json({ error: itemsError.message }, 500);

    const itemsAny = (items || []) as any[];
    const itemIds = itemsAny.map(item => item.id);
    let assets: any[] = [];
    if (itemIds.length > 0) {
      const { data: assetData, error: assetError } = await supabase
        .from('post_item_asset')
        .select('*')
        .in('post_item_id', itemIds)
        .order('slot_index');
      if (assetError) return c.json({ error: assetError.message }, 500);
      assets = (assetData || []) as any[];
      await validateGeneratedPageAssets(supabase, plan, assets);
    }

    const itemsWithAssets = itemsAny.map(item => ({
      ...item,
      assets: assets.filter(asset => asset.post_item_id === item.id),
    }));

    return c.json({ ...plan, items: itemsWithAssets });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Update plan
postPlanRoutes.patch('/post/plan/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (hasForbiddenFields(body, PLAN_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Plan ownership and identity fields cannot be changed' }, 400);
  }
  const update = pickAllowedFields<Record<string, unknown>>(body, PLAN_MUTABLE_FIELDS);
  if (Object.keys(update).length === 0) return c.json({ error: 'No editable fields supplied' }, 400);

  const supabase = createSupabaseClient();
  try {
    if (!await getOwnedPostPlan(supabase, id)) return c.json({ error: 'Plan not found' }, 404);
    const referenceError = await validatePlanReferences(supabase, update);
    if (referenceError) return c.json({ error: referenceError }, 400);

    const { data, error } = await supabase
      .from('post_plan')
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('store', STORE_NAME)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);
    if (!data) return c.json({ error: 'Plan not found' }, 404);
    return c.json(data);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Update item (tweet_text edit)
postPlanRoutes.patch('/post/item/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  if (hasForbiddenFields(body, ITEM_FORBIDDEN_FIELDS)) {
    return c.json({ error: 'Item ownership and server-managed fields cannot be changed' }, 400);
  }
  const update = pickAllowedFields<Record<string, unknown>>(body, ITEM_MUTABLE_FIELDS);
  if (Object.keys(update).length === 0) return c.json({ error: 'No editable fields supplied' }, 400);

  const supabase = createSupabaseClient();
  try {
    const item = await getOwnedPostItem(supabase, id);
    if (!item) return c.json({ error: 'Item not found' }, 404);
    const { data, error } = await supabase
      .from('post_item')
      .update(update as Database['public']['Tables']['post_item']['Update'])
      .eq('id', id)
      .eq('post_plan_id', item.post_plan_id)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);
    if (!data) return c.json({ error: 'Item not found' }, 404);
    return c.json(data);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Reorder items
postPlanRoutes.patch('/post/plan/:id/reorder', async (c) => {
  const planId = c.req.param('id');
  const { item_ids } = await c.req.json<{ item_ids?: unknown }>();
  if (!Array.isArray(item_ids) || item_ids.length === 0 || item_ids.some(id => typeof id !== 'string')) {
    return c.json({ error: 'item_ids must be a non-empty string array' }, 400);
  }
  const uniqueItemIds = [...new Set(item_ids as string[])];
  if (uniqueItemIds.length !== item_ids.length) return c.json({ error: 'item_ids must not contain duplicates' }, 400);

  const supabase = createSupabaseClient();
  try {
    if (!await getOwnedPostPlan(supabase, planId)) return c.json({ error: 'Plan not found' }, 404);
    const { data: ownedItems, error: ownedError } = await supabase
      .from('post_item')
      .select('id')
      .eq('post_plan_id', planId);
    if (ownedError) return c.json({ error: ownedError.message }, 500);
    const ownedItemIds = new Set((ownedItems || []).map(item => item.id));
    if (ownedItemIds.size !== uniqueItemIds.length || uniqueItemIds.some(id => !ownedItemIds.has(id))) {
      return c.json({ error: 'item_ids must exactly match this plan' }, 400);
    }

    for (let index = 0; index < uniqueItemIds.length; index++) {
      const { error } = await supabase
        .from('post_item')
        .update({ position: index + 1 })
        .eq('id', uniqueItemIds[index])
        .eq('post_plan_id', planId);
      if (error) return c.json({ error: error.message }, 500);
    }

    return c.json({ success: true });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F10: Execute posting
postPlanRoutes.post('/post/plan/:id/execute', async (c) => {
  const planId = c.req.param('id');
  const supabase = createSupabaseClient();

  try {
    const plan = await getOwnedPostPlan(supabase, planId) as PlanRecord | null;
    if (!plan) return c.json({ error: 'Plan not found' }, 404);
    if (!plan.x_credential_id) return c.json({ error: 'No X credential assigned' }, 400);

    let accessToken: string;
    try {
      ({ accessToken } = await getXCredentials(plan.x_credential_id));
    } catch (error) {
      return c.json({ error: 'Failed to get credentials: ' + errorMessage(error) }, 500);
    }

    const { error: postingError } = await supabase
      .from('post_plan')
      .update({ status: 'posting', updated_at: new Date().toISOString() })
      .eq('id', planId)
      .eq('store', STORE_NAME);
    if (postingError) return c.json({ error: postingError.message }, 500);

    const { data: execItems, error: itemsError } = await supabase
      .from('post_item')
      .select('*')
      .eq('post_plan_id', planId)
      .order('position');
    if (itemsError) return c.json({ error: itemsError.message }, 500);
    const items = (execItems || []) as any[];

    let lastTweetId: string | null = null;
    let hasFailure = false;

    for (const item of items) {
      await supabase.from('post_item').update({ status: 'posting' } as any).eq('id', item.id).eq('post_plan_id', planId);

      try {
        const { data: assetsRaw, error: assetsError } = await supabase
          .from('post_item_asset')
          .select('*')
          .eq('post_item_id', item.id)
          .order('slot_index');
        if (assetsError) throw new Error(assetsError.message);
        const assets = (assetsRaw || []) as any[];
        await validateGeneratedPageAssets(supabase, plan, assets);

        const mediaIds: string[] = [];
        for (const asset of assets) {
          if (asset.image_url) {
            const imgRes = await fetch(asset.image_url);
            if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            const mediaId = await uploadMedia(accessToken, imgBuffer);
            mediaIds.push(mediaId);
            await supabase.from('post_item_asset').update({ media_id: mediaId } as any).eq('id', asset.id).eq('post_item_id', item.id);
          }
        }

        const tweetResult = await postTweet(accessToken, {
          text: item.tweet_text || '',
          media_ids: mediaIds.length > 0 ? mediaIds : undefined,
          reply_to: lastTweetId || undefined,
        });

        await supabase.from('post_item').update({
          status: 'posted',
          tweet_id: tweetResult.id,
        } as any).eq('id', item.id).eq('post_plan_id', planId);

        if (!lastTweetId) {
          await supabase.from('post_plan').update({ thread_head_tweet_id: tweetResult.id } as any).eq('id', planId).eq('store', STORE_NAME);
        }
        lastTweetId = tweetResult.id;

        await sleep(1500);
      } catch (error) {
        hasFailure = true;
        await supabase.from('post_item').update({
          status: 'failed',
          error_message: errorMessage(error),
        } as any).eq('id', item.id).eq('post_plan_id', planId);
      }
    }

    const finalStatus = hasFailure ? 'partial' : 'completed';
    await supabase.from('post_plan').update({
      status: finalStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', planId).eq('store', STORE_NAME);

    return c.json({ status: finalStatus, plan_id: planId });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F10: Retry failed items
postPlanRoutes.post('/post/plan/:id/retry', async (c) => {
  const planId = c.req.param('id');
  const supabase = createSupabaseClient();

  try {
    const plan = await getOwnedPostPlan(supabase, planId) as PlanRecord | null;
    if (!plan) return c.json({ error: 'Plan not found' }, 404);
    if (!plan.x_credential_id) return c.json({ error: 'No X credential assigned' }, 400);

    const { accessToken } = await getXCredentials(plan.x_credential_id);

    const { data: failedItemsRaw, error: failedItemsError } = await supabase
      .from('post_item')
      .select('*')
      .eq('post_plan_id', planId)
      .eq('status', 'failed')
      .order('position');
    if (failedItemsError) return c.json({ error: failedItemsError.message }, 500);
    const failedItems = (failedItemsRaw || []) as any[];

    if (failedItems.length === 0) return c.json({ message: 'No failed items to retry' });

    const { data: postedItemsRaw, error: postedItemsError } = await supabase
      .from('post_item')
      .select('tweet_id, position')
      .eq('post_plan_id', planId)
      .eq('status', 'posted')
      .order('position', { ascending: false })
      .limit(1);
    if (postedItemsError) return c.json({ error: postedItemsError.message }, 500);
    const postedItems = (postedItemsRaw || []) as any[];
    let lastTweetId = postedItems[0]?.tweet_id || plan.thread_head_tweet_id;

    let retrySuccess = 0;
    for (const item of failedItems) {
      await supabase.from('post_item').update({ status: 'posting', error_message: null } as any).eq('id', item.id).eq('post_plan_id', planId);

      try {
        const { data: retryAssetsRaw, error: assetsError } = await supabase
          .from('post_item_asset')
          .select('*')
          .eq('post_item_id', item.id)
          .order('slot_index');
        if (assetsError) throw new Error(assetsError.message);
        const assets = (retryAssetsRaw || []) as any[];
        await validateGeneratedPageAssets(supabase, plan, assets);

        const mediaIds: string[] = [];
        for (const asset of assets) {
          if (asset.image_url && !asset.media_id) {
            const imgRes = await fetch(asset.image_url);
            if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.status}`);
            const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
            const mediaId = await uploadMedia(accessToken, imgBuffer);
            mediaIds.push(mediaId);
            await supabase.from('post_item_asset').update({ media_id: mediaId } as any).eq('id', asset.id).eq('post_item_id', item.id);
          } else if (asset.media_id) {
            mediaIds.push(asset.media_id);
          }
        }

        const tweetResult = await postTweet(accessToken, {
          text: item.tweet_text || '',
          media_ids: mediaIds.length > 0 ? mediaIds : undefined,
          reply_to: lastTweetId || undefined,
        });

        await supabase.from('post_item').update({
          status: 'posted',
          tweet_id: tweetResult.id,
        } as any).eq('id', item.id).eq('post_plan_id', planId);

        lastTweetId = tweetResult.id;
        retrySuccess++;
        await sleep(1500);
      } catch (error) {
        await supabase.from('post_item').update({
          status: 'failed',
          error_message: errorMessage(error),
        } as any).eq('id', item.id).eq('post_plan_id', planId);
      }
    }

    const { data: remaining, error: remainingError } = await supabase
      .from('post_item')
      .select('id')
      .eq('post_plan_id', planId)
      .neq('status', 'posted');
    if (remainingError) return c.json({ error: remainingError.message }, 500);

    const newStatus = remaining?.length === 0 ? 'completed' : 'partial';
    await supabase.from('post_plan').update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', planId).eq('store', STORE_NAME);

    return c.json({ retried: failedItems.length, success: retrySuccess, status: newStatus });
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});

// F8: Resolve unknown item
postPlanRoutes.patch('/post/item/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json<{ status?: unknown }>();
  if (status !== 'posted' && status !== 'failed') return c.json({ error: 'Invalid status' }, 400);

  const supabase = createSupabaseClient();
  try {
    const item = await getOwnedPostItem(supabase, id);
    if (!item) return c.json({ error: 'Item not found' }, 404);
    const { data, error } = await supabase
      .from('post_item')
      .update({ status })
      .eq('id', id)
      .eq('post_plan_id', item.post_plan_id)
      .select()
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 500);
    if (!data) return c.json({ error: 'Item not found' }, 404);
    return c.json(data);
  } catch (error) {
    return c.json({ error: errorMessage(error) }, 500);
  }
});
