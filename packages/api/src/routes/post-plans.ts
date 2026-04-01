import { Hono } from 'hono';
import { createSupabaseClient } from '../lib/supabase.js';
import { generatePostPlans } from '../lib/plan-generator.js';
import { getXCredentials } from '../lib/x-auth.js';
import { uploadMedia, postTweet } from '../lib/x-client.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const postPlanRoutes = new Hono();

// F7: Generate plans for a run
postPlanRoutes.post('/post/plan/generate', async (c) => {
  const { run_id } = await c.req.json<{ run_id: string }>();
  try {
    const planIds = await generatePostPlans(run_id);
    return c.json({ plan_ids: planIds, count: planIds.length }, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// F8: Get plans for a run
postPlanRoutes.get('/post/plans', async (c) => {
  const runId = c.req.query('run_id');
  const supabase = createSupabaseClient();
  let query = supabase.from('post_plan').select('*').order('created_at', { ascending: false });
  if (runId) query = query.eq('run_id', runId);
  const { data, error } = await query;
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// F8: Get single plan with items and assets
postPlanRoutes.get('/post/plan/:id', async (c) => {
  const id = c.req.param('id');
  const supabase = createSupabaseClient();

  const { data: plan, error: planErr } = await supabase
    .from('post_plan')
    .select('*')
    .eq('id', id)
    .single();
  if (planErr) return c.json({ error: planErr.message }, 500);

  const { data: items } = await supabase
    .from('post_item')
    .select('*')
    .eq('post_plan_id', id)
    .order('position');

  const itemsAny = (items || []) as any[];
  const itemIds = itemsAny.map((i: any) => i.id);
  let assets: any[] = [];
  if (itemIds.length > 0) {
    const { data: assetData } = await supabase
      .from('post_item_asset')
      .select('*')
      .in('post_item_id', itemIds)
      .order('slot_index');
    assets = (assetData || []) as any[];
  }

  const itemsWithAssets = itemsAny.map((item: any) => ({
    ...item,
    assets: assets.filter((a: any) => a.post_item_id === item.id),
  }));

  return c.json({ ...plan, items: itemsWithAssets });
});

// F8: Update plan
postPlanRoutes.patch('/post/plan/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_plan')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// F8: Update item (tweet_text edit)
postPlanRoutes.patch('/post/item/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_item')
    .update(body)
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

// F8: Reorder items
postPlanRoutes.patch('/post/plan/:id/reorder', async (c) => {
  const planId = c.req.param('id');
  const { item_ids } = await c.req.json<{ item_ids: string[] }>();
  const supabase = createSupabaseClient();

  for (let i = 0; i < item_ids.length; i++) {
    await supabase.from('post_item').update({ position: i + 1 }).eq('id', item_ids[i]);
  }

  return c.json({ success: true });
});

// F10: Execute posting
postPlanRoutes.post('/post/plan/:id/execute', async (c) => {
  const planId = c.req.param('id');
  const supabase = createSupabaseClient();

  const { data: planRaw } = await supabase
    .from('post_plan')
    .select('*')
    .eq('id', planId)
    .single();
  const plan = planRaw as any;
  if (!plan) return c.json({ error: 'Plan not found' }, 404);
  if (!plan.x_credential_id) return c.json({ error: 'No X credential assigned' }, 400);

  let accessToken: string;
  try {
    ({ accessToken } = await getXCredentials(plan.x_credential_id));
  } catch (e: any) {
    return c.json({ error: 'Failed to get credentials: ' + e.message }, 500);
  }

  await supabase.from('post_plan').update({ status: 'posting', updated_at: new Date().toISOString() }).eq('id', planId);

  const { data: execItems } = await supabase
    .from('post_item')
    .select('*')
    .eq('post_plan_id', planId)
    .order('position');
  const items = (execItems || []) as any[];

  let lastTweetId: string | null = null;
  let hasFailure = false;

  for (const item of items) {
    await supabase.from('post_item').update({ status: 'posting' } as any).eq('id', item.id);

    try {
      const { data: assetsRaw } = await supabase
        .from('post_item_asset')
        .select('*')
        .eq('post_item_id', item.id)
        .order('slot_index');
      const assets = (assetsRaw || []) as any[];

      const mediaIds: string[] = [];
      for (const asset of assets) {
        if (asset.image_url) {
          const imgRes = await fetch(asset.image_url);
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          const mediaId = await uploadMedia(accessToken, imgBuffer);
          mediaIds.push(mediaId);
          await supabase.from('post_item_asset').update({ media_id: mediaId } as any).eq('id', asset.id);
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
      } as any).eq('id', item.id);

      if (!lastTweetId) {
        await supabase.from('post_plan').update({ thread_head_tweet_id: tweetResult.id } as any).eq('id', planId);
      }
      lastTweetId = tweetResult.id;

      await sleep(1500);
    } catch (e: any) {
      hasFailure = true;
      await supabase.from('post_item').update({
        status: 'failed',
        error_message: e.message,
      } as any).eq('id', item.id);
    }
  }

  const finalStatus = hasFailure ? 'partial' : 'completed';
  await supabase.from('post_plan').update({
    status: finalStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', planId);

  return c.json({ status: finalStatus, plan_id: planId });
});

// F10: Retry failed items
postPlanRoutes.post('/post/plan/:id/retry', async (c) => {
  const planId = c.req.param('id');
  const supabase = createSupabaseClient();

  const { data: planRetryRaw } = await supabase
    .from('post_plan')
    .select('*')
    .eq('id', planId)
    .single();
  const plan = planRetryRaw as any;
  if (!plan || !plan.x_credential_id) return c.json({ error: 'Invalid plan' }, 400);

  const { accessToken } = await getXCredentials(plan.x_credential_id);

  const { data: failedItemsRaw } = await supabase
    .from('post_item')
    .select('*')
    .eq('post_plan_id', planId)
    .eq('status', 'failed')
    .order('position');
  const failedItems = (failedItemsRaw || []) as any[];

  if (failedItems.length === 0) {
    return c.json({ message: 'No failed items to retry' });
  }

  const { data: postedItemsRaw } = await supabase
    .from('post_item')
    .select('tweet_id, position')
    .eq('post_plan_id', planId)
    .eq('status', 'posted')
    .order('position', { ascending: false })
    .limit(1);
  const postedItems = (postedItemsRaw || []) as any[];
  let lastTweetId = postedItems[0]?.tweet_id || plan.thread_head_tweet_id;

  let retrySuccess = 0;
  for (const item of failedItems) {
    await supabase.from('post_item').update({ status: 'posting', error_message: null } as any).eq('id', item.id);

    try {
      const { data: retryAssetsRaw } = await supabase
        .from('post_item_asset')
        .select('*')
        .eq('post_item_id', item.id)
        .order('slot_index');
      const assets = (retryAssetsRaw || []) as any[];

      const mediaIds: string[] = [];
      for (const asset of assets) {
        if (asset.image_url && !asset.media_id) {
          const imgRes = await fetch(asset.image_url);
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          const mediaId = await uploadMedia(accessToken, imgBuffer);
          mediaIds.push(mediaId);
          await supabase.from('post_item_asset').update({ media_id: mediaId } as any).eq('id', asset.id);
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
      } as any).eq('id', item.id);

      lastTweetId = tweetResult.id;
      retrySuccess++;
      await sleep(1500);
    } catch (e: any) {
      await supabase.from('post_item').update({
        status: 'failed',
        error_message: e.message,
      } as any).eq('id', item.id);
    }
  }

  const { data: remaining } = await supabase
    .from('post_item')
    .select('id')
    .eq('post_plan_id', planId)
    .neq('status', 'posted');

  const newStatus = (remaining?.length === 0) ? 'completed' : 'partial';
  await supabase.from('post_plan').update({
    status: newStatus,
    updated_at: new Date().toISOString(),
  }).eq('id', planId);

  return c.json({ retried: failedItems.length, success: retrySuccess, status: newStatus });
});

// F8: Resolve unknown item
postPlanRoutes.patch('/post/item/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const { status } = await c.req.json<{ status: 'posted' | 'failed' }>();
  const supabase = createSupabaseClient();
  const { data, error } = await supabase
    .from('post_item')
    .update({ status })
    .eq('id', id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});
