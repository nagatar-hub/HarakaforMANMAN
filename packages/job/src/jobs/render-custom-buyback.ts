/**
 * Render one isolated custom buyback sheet. This path never writes prepared_card,
 * generated_page, or the public Google Sheet.
 */
import sharp from 'sharp';
import {
  planCustomBuybackPages,
} from '@haraka/shared';
import type {
  AssetProfileRow,
  CustomBuybackItemRow,
  CustomBuybackPageRow,
  CustomBuybackSheetRow,
  LayoutTemplateRow,
  PreparedCardRow,
  RarityIconRow,
} from '@haraka/shared';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getAccessToken } from '../lib/auth.js';
import { composePage } from '../lib/image-composer.js';
import { downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { downloadTemplateAsset } from '../lib/asset-storage.js';
import { CUSTOM_BUYBACK_STORAGE_PREFIX, STORE_NAME } from '../lib/store.js';

type Supabase = Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>;

export function customItemToPreparedCard(
  item: CustomBuybackItemRow,
  sheet: CustomBuybackSheetRow,
): PreparedCardRow {
  return {
    id: item.id,
    run_id: sheet.price_snapshot_run_id,
    raw_import_id: null,
    order_list_item_id: null,
    excel_product_id: item.excel_product_id,
    db_card_id: item.source_db_card_id,
    franchise: sheet.franchise,
    card_name: item.card_name,
    grade: item.grade,
    list_no: item.list_no,
    image_url: item.image_url,
    alt_image_url: item.alt_image_url,
    rarity: item.rarity,
    rarity_icon_url: item.rarity_icon_url,
    tag: item.tag,
    price_high: item.final_price_high,
    price_low: sheet.product_type === 'box' ? null : item.final_price_low,
    image_status: item.image_status,
    source: 'manual',
    price_source: item.price_source,
    price_source_date: item.price_source_date,
    created_at: item.created_at,
  };
}

export function customBuybackDisplayDateText(displayDate: string): string {
  return displayDate.slice(5).replace('-', '/');
}

export async function runRenderCustomBuyback(): Promise<void> {
  const sheetId = process.env.CUSTOM_BUYBACK_SHEET_ID?.trim();
  const revision = Number(process.env.CUSTOM_BUYBACK_REVISION);
  if (!sheetId) throw new Error('CUSTOM_BUYBACK_SHEET_ID が未設定です');
  if (!Number.isInteger(revision) || revision <= 0) throw new Error('CUSTOM_BUYBACK_REVISION が不正です');

  const supabase = await createSupabaseClientFromSecrets();
  const { data: sheet, error: sheetError } = await supabase
    .from('custom_buyback_sheet')
    .select('*')
    .eq('id', sheetId)
    .eq('store', STORE_NAME)
    .eq('status', 'rendering')
    .eq('revision', revision)
    .maybeSingle<CustomBuybackSheetRow>();
  if (sheetError) throw new Error(`カスタム買取表取得失敗: ${sheetError.message}`);
  if (!sheet) throw new Error(`対象のrenderingリビジョンがありません: ${sheetId}/${revision}`);

  try {
    await renderSheet(supabase, sheet, revision);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from('custom_buyback_sheet').update({
      status: 'failed',
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq('id', sheet.id).eq('store', STORE_NAME).eq('revision', revision);
    throw error;
  }
}

async function renderSheet(supabase: Supabase, sheet: CustomBuybackSheetRow, revision: number): Promise<void> {
  const [itemsResult, layoutsResult, profilesResult] = await Promise.all([
    supabase.from('custom_buyback_item').select('*')
      .eq('sheet_id', sheet.id).order('position').returns<CustomBuybackItemRow[]>(),
    supabase.from('layout_template').select('*')
      .eq('store', STORE_NAME)
      .eq('franchise', sheet.franchise)
      .eq('kind', sheet.kind)
      .eq('is_active', true)
      .returns<LayoutTemplateRow[]>(),
    supabase.from('asset_profile').select('*')
      .eq('store', STORE_NAME)
      .eq('franchise', sheet.franchise)
      .limit(1)
      .returns<AssetProfileRow[]>(),
  ]);
  if (itemsResult.error) throw new Error(`項目取得失敗: ${itemsResult.error.message}`);
  if (layoutsResult.error) throw new Error(`レイアウト取得失敗: ${layoutsResult.error.message}`);
  if (profilesResult.error) throw new Error(`アセット取得失敗: ${profilesResult.error.message}`);
  const items = itemsResult.data ?? [];
  const layouts = layoutsResult.data ?? [];
  const profile = profilesResult.data?.[0];
  if (items.length === 0) throw new Error('カードが1件もありません');
  if (!profile) throw new Error(`asset_profile がありません: ${sheet.franchise}`);
  if (items.some((item) => !item.final_price_high || (sheet.product_type === 'psa' && !item.final_price_low))) {
    throw new Error('表示価格が未設定のカードがあります');
  }

  const plans = planCustomBuybackPages(items.map((item) => item.id), layouts, sheet.product_type);
  if (!plans || plans.length === 0) throw new Error('利用できるレイアウトがありません');
  const itemById = new Map(items.map((item) => [item.id, item]));
  const accessToken = await getAccessToken();
  const templateCache = new Map<string, Buffer>();
  const cardBackCache = new Map<string, Buffer>();
  const rarityIconBuffers = await loadRarityIcons(supabase, items, sheet.franchise, accessToken);

  for (const plan of plans) {
    const pageItems = plan.itemIds.map((id) => itemById.get(id)).filter((item): item is CustomBuybackItemRow => Boolean(item));
    if (pageItems.length !== plan.itemIds.length) throw new Error(`ページ${plan.pageIndex + 1}の商品参照が壊れています`);
    await renderOnePage({
      supabase,
      sheet,
      revision,
      pageIndex: plan.pageIndex,
      layout: plan.layout,
      items: pageItems,
      profile,
      accessToken,
      rarityIconBuffers,
      templateCache,
      cardBackCache,
    });
  }

  const { error: stalePageError } = await supabase.from('custom_buyback_page').delete()
    .eq('sheet_id', sheet.id).gte('page_index', plans.length);
  if (stalePageError) throw new Error(`旧ページ整理失敗: ${stalePageError.message}`);

  const { data: completed, error: completeError } = await supabase
    .from('custom_buyback_sheet')
    .update({
      status: 'ready',
      last_rendered_revision: revision,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sheet.id)
    .eq('store', STORE_NAME)
    .eq('revision', revision)
    .eq('status', 'rendering')
    .select('id')
    .maybeSingle();
  if (completeError) throw new Error(`完了更新失敗: ${completeError.message}`);
  if (!completed) throw new Error('新しいリビジョンが開始されたため完了状態を更新しませんでした');
}

type RenderOnePageParams = {
  supabase: Supabase;
  sheet: CustomBuybackSheetRow;
  revision: number;
  pageIndex: number;
  layout: LayoutTemplateRow;
  items: CustomBuybackItemRow[];
  profile: AssetProfileRow;
  accessToken: string;
  rarityIconBuffers: Map<string, Buffer>;
  templateCache: Map<string, Buffer>;
  cardBackCache: Map<string, Buffer>;
};

async function renderOnePage(params: RenderOnePageParams): Promise<void> {
  const {
    supabase, sheet, revision, pageIndex, layout, items, profile, accessToken,
    rarityIconBuffers, templateCache, cardBackCache,
  } = params;
  const existing = await existingPage(supabase, sheet.id, pageIndex);
  await upsertPage(supabase, {
    sheet_id: sheet.id,
    page_index: pageIndex,
    layout_template_id: layout.id,
    item_ids: items.map((item) => item.id),
    status: 'pending',
    rendered_revision: revision,
    image_key: existing?.image_key ?? null,
    image_url: existing?.image_url ?? null,
    error_message: null,
    created_at: existing?.created_at ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  try {
    let templateBuffer = templateCache.get(layout.id);
    let cardBackBuffer = cardBackCache.get(layout.id);
    if (!templateBuffer || !cardBackBuffer) {
      [templateBuffer, cardBackBuffer] = await Promise.all([
        downloadTemplateAsset({
          supabase,
          storagePath: layout.template_storage_path,
          driveId: null,
          accessToken,
          label: `${sheet.franchise}/${layout.slug} テンプレ`,
        }),
        downloadTemplateAsset({
          supabase,
          storagePath: layout.card_back_storage_path,
          driveId: null,
          accessToken,
          label: `${sheet.franchise}/${layout.slug} カード裏`,
        }),
      ]);
      templateCache.set(layout.id, templateBuffer);
      cardBackCache.set(layout.id, cardBackBuffer);
    }

    const cards = items.map((item) => customItemToPreparedCard(item, sheet));
    const primaryUrls = cards.map((card) => card.image_url || card.alt_image_url || null);
    const primaryBuffers = await downloadImagesWithConcurrency(accessToken, primaryUrls, 8);
    const retryIndices: number[] = [];
    for (let index = 0; index < cards.length; index += 1) {
      const buffer = primaryBuffers[index];
      if (!buffer && cards[index].alt_image_url && cards[index].image_url) {
        retryIndices.push(index);
      } else if (buffer) {
        try {
          await sharp(buffer).metadata();
        } catch {
          primaryBuffers[index] = null;
          if (cards[index].alt_image_url) retryIndices.push(index);
        }
      }
    }
    if (retryIndices.length > 0) {
      const retries = await downloadImagesWithConcurrency(
        accessToken,
        retryIndices.map((index) => cards[index].alt_image_url!),
        8,
      );
      retryIndices.forEach((cardIndex, retryIndex) => {
        if (retries[retryIndex]) primaryBuffers[cardIndex] = retries[retryIndex];
      });
    }
    const cardImageBuffers = new Map<string, Buffer>();
    cards.forEach((card, index) => {
      const buffer = primaryBuffers[index];
      if (buffer) cardImageBuffers.set(card.id, buffer);
    });

    const dateText = customBuybackDisplayDateText(sheet.display_date);
    const imageBuffer = await composePage({
      templateBuffer,
      cardBackBuffer,
      cards,
      layout: layout.layout_config,
      assetProfile: profile,
      gridCols: layout.grid_cols,
      rarityIconBuffers,
      cardImageBuffers,
      dateText,
      skipPriceLow: sheet.product_type === 'box' || layout.skip_price_low,
      layoutAdjust: layout.layout_config.layoutAdjust,
      rowPriceAdjust: layout.layout_config.rowPriceAdjust,
      rowCardAdjust: layout.layout_config.rowCardAdjust,
      totalSlots: layout.total_slots,
    });

    const safeFranchise = sheet.franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
    const storageKey = `${CUSTOM_BUYBACK_STORAGE_PREFIX}/${sheet.id}/revision_${revision}/${safeFranchise}_${sheet.product_type}_${sheet.kind}_${String(pageIndex + 1).padStart(2, '0')}.png`;
    const { error: uploadError } = await supabase.storage.from('haraka-images').upload(storageKey, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });
    if (uploadError) throw new Error(`Storageアップロード失敗: ${uploadError.message}`);
    const { data: publicUrl } = supabase.storage.from('haraka-images').getPublicUrl(storageKey);

    await upsertPage(supabase, {
      sheet_id: sheet.id,
      page_index: pageIndex,
      layout_template_id: layout.id,
      item_ids: items.map((item) => item.id),
      status: 'generated',
      rendered_revision: revision,
      image_key: storageKey,
      image_url: publicUrl.publicUrl,
      error_message: null,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await upsertPage(supabase, {
      sheet_id: sheet.id,
      page_index: pageIndex,
      layout_template_id: layout.id,
      item_ids: items.map((item) => item.id),
      status: 'failed',
      rendered_revision: revision,
      image_key: existing?.image_key ?? null,
      image_url: existing?.image_url ?? null,
      error_message: message,
      created_at: existing?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    throw new Error(`ページ${pageIndex + 1}: ${message}`);
  }
}

async function existingPage(supabase: Supabase, sheetId: string, pageIndex: number): Promise<CustomBuybackPageRow | null> {
  const { data, error } = await supabase.from('custom_buyback_page').select('*')
    .eq('sheet_id', sheetId).eq('page_index', pageIndex).maybeSingle<CustomBuybackPageRow>();
  if (error) throw new Error(`既存ページ取得失敗: ${error.message}`);
  return data;
}

type CustomBuybackPageUpsert = Omit<CustomBuybackPageRow, 'id'> & { id?: string };

async function upsertPage(supabase: Supabase, page: CustomBuybackPageUpsert): Promise<void> {
  const { error } = await supabase.from('custom_buyback_page').upsert(page, {
    onConflict: 'sheet_id,page_index',
  });
  if (error) throw new Error(`ページ状態保存失敗: ${error.message}`);
}

async function loadRarityIcons(
  supabase: Supabase,
  items: CustomBuybackItemRow[],
  franchise: string,
  accessToken: string,
): Promise<Map<string, Buffer>> {
  const names = new Set(items.map((item) => item.rarity_icon_url).filter((value): value is string => Boolean(value)));
  const buffers = new Map<string, Buffer>();
  if (names.size === 0) return buffers;
  const { data, error } = await supabase.from('rarity_icon').select('*')
    .or(`franchise.eq.${franchise},franchise.is.null`)
    .returns<RarityIconRow[]>();
  if (error) throw new Error(`レアリティアイコン一覧取得失敗: ${error.message}`);
  const rowByName = new Map((data ?? []).map((row) => [row.name, row]));
  for (const name of names) {
    const row = rowByName.get(name);
    if (!row) continue;
    try {
      const buffer = await downloadTemplateAsset({
        supabase,
        storagePath: row.storage_path,
        driveId: row.drive_id,
        accessToken,
        label: `rarity/${name}`,
      });
      buffers.set(name, buffer);
    } catch (error) {
      console.warn(`[custom-buyback] rarity icon skipped: ${name}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return buffers;
}
