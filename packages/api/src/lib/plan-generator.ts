import { createSupabaseClient } from './supabase.js';
import { resolveTemplate } from '@haraka/shared';
import type { PostTemplateRow, PostBannerRow } from '@haraka/shared';

type GeneratedPage = {
  id: string;
  franchise: string;
  page_index: number;
  page_label: string | null;
  image_url: string | null;
};

export async function generatePostPlans(runId: string) {
  const supabase = createSupabaseClient();

  // 1. Get generated pages grouped by franchise
  const { data: pages, error: pagesErr } = await supabase
    .from('generated_page')
    .select('id, franchise, page_index, page_label, image_url')
    .eq('run_id', runId)
    .eq('status', 'generated')
    .order('franchise')
    .order('page_index');
  if (pagesErr) throw new Error('Failed to fetch pages: ' + pagesErr.message);
  if (!pages || pages.length === 0) throw new Error('No generated pages found for run: ' + runId);

  // Group by franchise
  const byFranchise: Record<string, GeneratedPage[]> = {};
  for (const p of pages) {
    if (!byFranchise[p.franchise]) byFranchise[p.franchise] = [];
    byFranchise[p.franchise].push(p);
  }

  // 2. Get default templates, credential, banners
  const { data: templatesRaw } = await supabase
    .from('post_template')
    .select('*')
    .eq('is_default', true);
  const templates = templatesRaw as PostTemplateRow[] | null;

  const { data: defaultCred } = await supabase
    .from('x_credential')
    .select('id')
    .eq('is_default', true)
    .eq('status', 'active')
    .single();

  const { data: bannersRaw } = await supabase
    .from('post_banner')
    .select('*')
    .eq('is_default', true);
  const banners = bannersRaw as PostBannerRow[] | null;

  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const dateShort = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const weekday = weekdays[now.getDay()];

  const createdPlans: string[] = [];

  for (const [franchise, franchisePages] of Object.entries(byFranchise)) {
    // Find matching template (franchise-specific or generic)
    const template = templates?.find(t => t.franchise === franchise)
      || templates?.find(t => !t.franchise);
    
    // Find matching banner
    const banner = banners?.find(b => b.franchise === franchise)
      || banners?.find(b => !b.franchise);

    // Resolve system variables for header
    const franchiseJa: Record<string, string> = {
      'Pokemon': 'ポケモン', 'ONE PIECE': 'ワンピース', 'YU-GI-OH!': '遊戯王',
    };
    const variables: Record<string, string> = {
      date: dateStr,
      date_short: dateShort,
      franchise: franchiseJa[franchise] || franchise,
      franchise_en: franchise,
      page_count: String(franchisePages.length),
      weekday,
    };

    const headerText = template
      ? resolveTemplate(template.header_template, variables)
      : `${dateShort} ${franchise} 買取表`;

    // 3. Create post_plan
    const { data: planRaw, error: planErr } = await supabase
      .from('post_plan')
      .insert({
        run_id: runId,
        franchise,
        template_id: template?.id || null,
        banner_id: banner?.id || null,
        banner_position: banner?.position_type || 'last',
        x_credential_id: defaultCred?.id || null,
        header_text: headerText,
        status: 'draft',
      } as any)
      .select()
      .single();
    if (planErr) throw new Error('Failed to create plan: ' + planErr.message);
    const plan = planRaw as any;

    // 4. Create post_items (4 images per tweet)
    let position = 1;

    // Header tweet (text only)
    await supabase
      .from('post_item')
      .insert({
        post_plan_id: plan.id,
        position,
        tweet_text: headerText,
        is_header: true,
        status: 'pending',
      } as any);
    position++;

    // Batch pages into tweets (4 images each)
    for (let i = 0; i < franchisePages.length; i += 4) {
      const batch = franchisePages.slice(i, i + 4);
      
      const itemVars = {
        ...variables,
        page_no: String(i / 4 + 1),
        page_title: batch.map(p => p.page_label || `P${p.page_index + 1}`).join('・'),
        card_count: '', // Will be resolved at post time if needed
      };
      const tweetText = template?.item_template
        ? resolveTemplate(template.item_template, itemVars)
        : null;

      const { data: itemRaw } = await supabase
        .from('post_item')
        .insert({
          post_plan_id: plan.id,
          position,
          tweet_text: tweetText,
          is_header: false,
          status: 'pending',
        } as any)
        .select()
        .single();
      const item = itemRaw as any;

      // Create assets for each image in the batch
      for (let j = 0; j < batch.length; j++) {
        const page = batch[j];
        if (page.image_url) {
          await supabase.from('post_item_asset').insert({
            post_item_id: item!.id,
            slot_index: j,
            generated_page_id: page.id,
            image_url: page.image_url,
            asset_type: 'buylist',
          } as any);
        }
      }
      position++;
    }

    // Banner tweet (if banner exists and position is 'last')
    if (banner && banner.position_type === 'last') {
      const { data: bannerItemRaw } = await supabase
        .from('post_item')
        .insert({
          post_plan_id: plan.id,
          position,
          tweet_text: null,
          is_header: false,
          status: 'pending',
        } as any)
        .select()
        .single();
      const bannerItem = bannerItemRaw as any;

      await supabase.from('post_item_asset').insert({
        post_item_id: bannerItem!.id,
        slot_index: 0,
        image_url: banner.image_url,
        asset_type: 'banner',
      } as any);
    }

    createdPlans.push(plan.id);
  }

  return createdPlans;
}
