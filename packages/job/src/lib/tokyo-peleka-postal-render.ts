import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type {
  AssetProfileRow,
  Database,
  Franchise,
  GeneratedPageRow,
  LayoutTemplateRow,
  PreparedCardRow,
  RuleRow,
} from '@haraka/shared';
import { FRANCHISES } from '@haraka/shared';
import { downloadTemplateAsset } from './asset-storage.js';
import { batchInsert } from './batch.js';
import { formatGenerationDate, parseBusinessDate } from './generation-date.js';
import { downloadImagesWithConcurrency } from './google-drive.js';
import { composePage } from './image-composer.js';
import { planPages, type PagePlan } from './page-planner.js';
import {
  matchTokyoPelekaPostalProducts,
  pageTokyoPelekaSnapshot,
  type TokyoPelekaPostalSnapshot,
} from './peleka-postal.js';

type SupabaseClient = {
  from: (table: string) => any;
  storage: { from: (bucket: string) => any };
};
type GeneratedPageInsert = Database['public']['Tables']['generated_page']['Insert'];

function isBox(card: PreparedCardRow) {
  return card.tag === 'BOX' || card.grade === 'BOX' || card.grade === '未開封BOX';
}

export function planTokyoPelekaPostalPages(
  cards: PreparedCardRow[],
  layouts: LayoutTemplateRow[],
  rules: RuleRow[],
): PagePlan[] {
  return (['PSA10', 'BOX'] as const).flatMap(type => {
    const group = cards.filter(card => isBox(card) === (type === 'BOX'));
    const candidates = layouts.filter(layout => layout.is_active && (layout.slug.startsWith('box_') === (type === 'BOX')));
    if (group.length && !candidates.length) throw new Error(`東京郵送 ${type} レイアウトがありません`);
    if (type === 'BOX') return planPages(group.map(card => ({ ...card, tag: 'BOX' })), [], candidates)
      .map((plan, index) => ({ ...plan, label: index ? `BOX-${index + 1}` : 'BOX' }));
    return planPages(group, [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)), candidates, true);
  });
}

export function assertExactTokyoPelekaPostalCoverage(expectedIds: string[], plans: PagePlan[]) {
  const plannedIds = plans.flatMap(plan => plan.cardIds);
  if (plannedIds.length !== expectedIds.length || new Set(plannedIds).size !== expectedIds.length
    || expectedIds.some(id => !plannedIds.includes(id))) {
    throw new Error('Peleka郵送カタログの全商品を一意にページ割付できません');
  }
}

export async function stampPostalIdentifier(image: Buffer) {
  const metadata = await sharp(image).metadata();
  const width = Math.min(360, Math.max(180, Math.floor((metadata.width ?? 1200) * 0.24)));
  const height = Math.max(52, Math.round(width * 0.22));
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" rx="12" fill="#9b1c1c"/>
    <text x="50%" y="66%" text-anchor="middle" font-family="Noto Sans CJK JP, Noto Sans JP, Meiryo, Yu Gothic, Arial, sans-serif" font-size="${Math.round(height * 0.48)}" font-weight="700" fill="white">郵送買取</text>
  </svg>`);
  return sharp(image).composite([{ input: svg, left: 24, top: 24 }]).png().toBuffer();
}

export async function renderTokyoPelekaPostalPages(params: {
  supabase: SupabaseClient;
  runId: string;
  snapshot: TokyoPelekaPostalSnapshot;
  preparedCards: PreparedCardRow[];
  cardImageBuffers?: ReadonlyMap<string, Buffer>;
  datePath: string;
  generationVersion: number | string;
  // Completed runs must publish postal pages only after every image and price check succeeds.
  publishTogether?: (pages: GeneratedPageInsert[]) => Promise<void>;
}): Promise<number> {
  const matched = matchTokyoPelekaPostalProducts(params.preparedCards, params.snapshot);
  if (matched.length === 0) {
    if (params.publishTogether) await params.publishTogether([]);
    return 0;
  }
  const matchedById = new Map(matched.map(card => [card.id, card]));
  const productByCardId = new Map(matched.map(card => [card.id, card.pelekaProduct]));
  let totalPages = 0;
  const stagedPages: GeneratedPageInsert[] = [];

  for (const franchise of FRANCHISES) {
    const cards = matched.filter(card => card.franchise === franchise);
    if (!cards.length) continue;
    const [{ data: profiles, error: profileError }, { data: allLayouts, error: layoutError }, { data: rules, error: ruleError }] = await Promise.all([
      params.supabase.from('asset_profile').select('*').eq('store', 'manman-akihabara').eq('franchise', franchise).limit(1),
      params.supabase.from('layout_template').select('*').eq('store', 'manman-akihabara').eq('franchise', franchise).in('kind', ['postal', 'store']),
      params.supabase.from('rule').select('*').eq('store', 'manman-akihabara').eq('franchise', franchise),
    ]);
    const profile = (profiles?.[0] ?? null) as AssetProfileRow | null;
    if (profileError || !profile) throw new Error(`東京郵送 asset_profile 取得失敗 (${franchise}): ${profileError?.message ?? '該当なし'}`);
    if (layoutError) throw new Error(`東京郵送 layout_template 取得失敗 (${franchise}): ${layoutError.message}`);
    if (ruleError) throw new Error(`東京郵送 rule 取得失敗 (${franchise}): ${ruleError.message}`);
    const layouts = (allLayouts ?? []) as LayoutTemplateRow[];
    const selectedLayouts = (['PSA10', 'BOX'] as const).flatMap(type => {
      const needed = cards.some(card => isBox(card) === (type === 'BOX'));
      if (!needed) return [];
      const matchesType = (layout: LayoutTemplateRow) => layout.is_active
        && (layout.slug.startsWith('box_') === (type === 'BOX'));
      const postal = layouts.filter(layout => layout.kind === 'postal' && matchesType(layout));
      return postal.length ? postal : layouts.filter(layout => layout.kind === 'store' && matchesType(layout));
    });
    const plans = planTokyoPelekaPostalPages(cards, selectedLayouts, (rules ?? []) as RuleRow[]);
    assertExactTokyoPelekaPostalCoverage(cards.map(card => card.id), plans);
    const inserts: GeneratedPageInsert[] = plans.map((plan, pageIndex) => ({
      ...(params.publishTogether ? { id: randomUUID() } : {}),
      run_id: params.runId,
      franchise,
      page_index: pageIndex,
      page_label: plan.label,
      card_ids: plan.cardIds,
      layout_template_id: plan.layoutTemplateId,
      kind: 'postal',
      status: 'pending',
      display_name: `郵送買取 ${franchise} ${plan.label || 'page'} (${pageIndex + 1}).png`,
      peleka_snapshot: pageTokyoPelekaSnapshot(params.snapshot, plan.cardIds.map(id => productByCardId.get(id)!)),
    }));
    if (!params.publishTogether) await batchInsert(params.supabase as any, 'generated_page', inserts as unknown as Record<string, unknown>[]);

    const { data: pages, error: pageError } = params.publishTogether ? { data: inserts, error: null } : await params.supabase.from('generated_page').select('*')
      .eq('run_id', params.runId).eq('franchise', franchise).eq('kind', 'postal').order('page_index', { ascending: true });
    if (pageError || pages?.length !== plans.length) {
      throw new Error(`東京郵送 generated_page 取得失敗 (${franchise}): ${pageError?.message ?? '件数不一致'}`);
    }
    const layoutById = new Map(selectedLayouts.map(layout => [layout.id, layout]));
    const assetCache = new Map<string, { template: Buffer; back: Buffer }>();
    for (const page of pages as GeneratedPageRow[]) {
      try {
        const layout = page.layout_template_id ? layoutById.get(page.layout_template_id) : undefined;
        if (!layout) throw new Error(`東京郵送レイアウトが見つかりません: page=${page.id}`);
        let assets = assetCache.get(layout.id);
        if (!assets) {
          const [template, back] = await Promise.all([
            downloadTemplateAsset({ supabase: params.supabase as any, storagePath: layout.template_storage_path,
              driveId: null, accessToken: '', label: `${franchise}/${layout.slug} 郵送テンプレ` }),
            downloadTemplateAsset({ supabase: params.supabase as any, storagePath: layout.card_back_storage_path,
              driveId: null, accessToken: '', label: `${franchise}/${layout.slug} 郵送カード裏` }),
          ]);
          assets = { template, back };
          assetCache.set(layout.id, assets);
        }
        const pageCards = page.card_ids.map(id => matchedById.get(id));
        if (pageCards.some(card => !card)) throw new Error(`東京郵送ページの商品が見つかりません: page=${page.id}`);
        const orderedCards = pageCards as typeof matched;
        const missingCards = orderedCards.filter(card => !params.cardImageBuffers?.has(card.id));
        const downloaded = missingCards.length
          ? await downloadImagesWithConcurrency('', missingCards.map(card => card.image_url), 8)
          : [];
        const downloadedById = new Map(missingCards.map((card, index) => [card.id, downloaded[index]]));
        const cardImages = new Map<string, Buffer>();
        for (const card of orderedCards) {
          const bytes = params.cardImageBuffers?.get(card.id) ?? downloadedById.get(card.id);
          if (!bytes) throw new Error(`Peleka郵送商品の画像取得失敗: sourceId=${card.pelekaProduct.sourceId}`);
          try { await sharp(bytes, { limitInputPixels: 25_000_000 }).metadata(); }
          catch { throw new Error(`Peleka郵送商品の画像が不正です: sourceId=${card.pelekaProduct.sourceId}`); }
          cardImages.set(card.id, bytes);
        }
        const composed = await composePage({
          templateBuffer: assets.template,
          cardBackBuffer: assets.back,
          cards: orderedCards,
          layout: layout.layout_config,
          assetProfile: profile,
          gridCols: layout.grid_cols,
          rarityIconBuffers: new Map(),
          cardImageBuffers: cardImages,
          requireCardImages: true,
          dateText: formatGenerationDate(parseBusinessDate(params.snapshot.businessDate)),
          skipPriceLow: params.snapshot.buyPriceDisplayMode === 'UPPER_ONLY',
          layoutAdjust: layout.layout_config.layoutAdjust,
          rowPriceAdjust: layout.layout_config.rowPriceAdjust,
          rowCardAdjust: layout.layout_config.rowCardAdjust,
          totalSlots: layout.total_slots,
        });
        const image = await stampPostalIdentifier(composed);
        const safeFranchise = franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
        const storageKey = `generated/manman-akihabara/${params.datePath}/postal/${safeFranchise}/postal_page_${page.page_index}_${params.generationVersion}.png`;
        const { error: uploadError } = await params.supabase.storage.from('haraka-images').upload(storageKey, image,
          { contentType: 'image/png', upsert: true });
        if (uploadError) throw new Error(`東京郵送 Storage アップロード失敗: ${uploadError.message}`);
        const { data: publicUrl } = params.supabase.storage.from('haraka-images').getPublicUrl(storageKey);
        const completed = {
          status: 'generated', image_key: storageKey, image_url: publicUrl.publicUrl, error_message: null,
        } as const;
        if (params.publishTogether) {
          stagedPages.push({ ...page, ...completed });
          continue;
        }
        const { error: updateError } = await params.supabase.from('generated_page').update(completed).eq('id', page.id).eq('run_id', params.runId);
        if (updateError) throw new Error(`東京郵送ページ保存失敗: ${updateError.message}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!params.publishTogether) await params.supabase.from('generated_page').update({ status: 'failed', error_message: message })
          .eq('id', page.id).eq('run_id', params.runId);
        throw error;
      }
    }
    totalPages += plans.length;
  }
  if (params.publishTogether) await params.publishTogether(stagedPages);
  return totalPages;
}
