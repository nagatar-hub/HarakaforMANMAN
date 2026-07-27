/**
 * 単一ページ再生成ジョブ
 *
 * 指定された generated_page ID の画像を再生成する。
 * カードデータは prepared_card から最新の値を取得するため、
 * 価格や画像URLの変更後に再生成すれば反映される。
 */

import sharp from 'sharp';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { getAccessToken, getBuybackSheetAccessToken } from '../lib/auth.js';
import { publishManmanBuybackSheet } from '../lib/buyback-sheet.js';
import { composePage } from '../lib/image-composer.js';
import { downloadDriveFile, downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { downloadTemplateAsset } from '../lib/asset-storage.js';
import { makeBoxLayout } from '../lib/box-layout.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { applyCurrentPsa10DiscountRates, loadPsa10DiscountRates } from '../lib/pricing-settings.js';
import {
  formatGenerationDate,
  getJstDateParts,
  resolveGenerationDisplayDate,
} from '../lib/generation-date.js';
import type {
  Database,
  PreparedCardRow,
  AssetProfileRow,
  LayoutConfig,
  GeneratedPageRow,
  LayoutTemplateRow,
} from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type OwnedPageRun = Pick<RunRow, 'id' | 'order_list_import_id'>;

const LABEL_MAP: Record<string, string> = {
  'ピカチュウ': 'pikachu',
  'イーブイ': 'eevee',
  'リザードン': 'charizard',
  'サポート': 'support',
  'ゲンガー': 'gengar',
  '青眼': 'blue-eyes',
  'ブラックマジシャン': 'dark-magician',
};

function romanizeLabel(label: string): string {
  for (const [jp, en] of Object.entries(LABEL_MAP)) {
    label = label.replace(jp, en);
  }
  return label.replace(/[^a-zA-Z0-9._-]/g, '') || 'page';
}

const FRANCHISE_STORAGE_SLUG: Record<string, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

const STORE_NAME = process.env.STORE_NAME?.trim() || 'manman';

const BOX_TEMPLATE_DRIVE_ID: Record<string, string> = {
  Pokemon: '1ZiS1Xci3Dlc5i9SJrYoEEUUwiRuCzjZk',
  'ONE PIECE': '1RiAdjVUyDhpJyb8YxmZsZdSh6PxxEeHy',
  'YU-GI-OH!': '1uhJt5rFJyZgOX9wMvl4vLAckotKpmC_n',
};

export function resolveRegenerateAdjustments(params: {
  layout: LayoutConfig;
  isBOX: boolean;
  fallbackLayoutAdjust: { cardYDelta: number; priceYDelta: number };
  fallbackRowPriceAdjust: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }>;
  fallbackRowCardAdjust?: Record<number, number>;
}) {
  const {
    layout,
    isBOX,
    fallbackLayoutAdjust,
    fallbackRowPriceAdjust,
    fallbackRowCardAdjust,
  } = params;

  const shouldUseLegacyRowFallback = !isBOX && !layout.layoutAdjust;

  return {
    layoutAdjust: layout.layoutAdjust ?? fallbackLayoutAdjust,
    rowPriceAdjust: layout.rowPriceAdjust ?? (shouldUseLegacyRowFallback ? fallbackRowPriceAdjust : undefined),
    rowCardAdjust: layout.rowCardAdjust ?? (shouldUseLegacyRowFallback ? fallbackRowCardAdjust : undefined),
  };
}

async function findOwnedPageRunId(
  supabase: Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>,
  pageId: string,
): Promise<OwnedPageRun> {
  const { data: page, error: pageError } = await supabase
    .from('generated_page')
    .select('run_id')
    .eq('id', pageId)
    .maybeSingle<{ run_id: string }>();
  if (pageError || !page) throw new Error(`ページが見つかりません: ${pageError?.message ?? '該当なし'}`);

  const { data: run, error: runError } = await supabase
    .from('run')
    .select('id, order_list_import_id')
    .eq('id', page.run_id)
    .eq('store', STORE_NAME)
    .maybeSingle<OwnedPageRun>();
  if (runError || !run) throw new Error(`この店舗のページではありません: ${runError?.message ?? pageId}`);
  return run;
}

export async function runRegeneratePage() {
  const pageId = process.env.PAGE_ID;
  if (!pageId) throw new Error('PAGE_ID が未設定です');

  const supabase = await createSupabaseClientFromSecrets();
  console.log(`[regenerate-page] ページ再生成開始: ${pageId}`);
  const ownedRun = await findOwnedPageRunId(supabase, pageId);

  try {
    await _runRegeneratePage(supabase, pageId, ownedRun);
  } catch (err) {
    // 失敗時: status は 'generated' を維持（ギャラリーから消えないように）し、error_message に記録
    const errMsg = err instanceof Error ? err.message : String(err);
    await supabase.from('generated_page').update({
      status: 'generated',
      error_message: `再生成失敗: ${errMsg}`,
    }).eq('id', pageId).eq('run_id', ownedRun.id);
    throw err;
  }
}

async function _runRegeneratePage(
  supabase: Awaited<ReturnType<typeof createSupabaseClientFromSecrets>>,
  pageId: string,
  ownedRun: OwnedPageRun,
) {

  // ---- 1. ページ情報取得 ----
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .eq('run_id', ownedRun.id)
    .single<GeneratedPageRow>();

  if (pageErr || !page) throw new Error(`ページが見つかりません: ${pageErr?.message}`);

  const regenerationStartedAt = new Date();
  // Storage は従来どおり再生成日のJSTパスを維持し、画像表示日は元RunのExcel業務日を使う。
  const storageDate = getJstDateParts(regenerationStartedAt);
  const displayDate = await resolveGenerationDisplayDate({
    orderListImportId: ownedRun.order_list_import_id,
    now: regenerationStartedAt,
    loadBusinessDate: async (importId) => {
      const { data, error } = await supabase
        .from('order_list_import')
        .select('business_date')
        .eq('id', importId)
        .eq('store', STORE_NAME)
        .maybeSingle<{ business_date: string }>();
      if (error) {
        throw new Error(`オーダーリスト業務日取得失敗: ${error.message}`);
      }
      return data?.business_date ?? null;
    },
  });

  // ---- 2. カードデータ取得 ----
  const { data: cards, error: cardErr } = await supabase
    .from('prepared_card')
    .select('*')
    .in('id', page.card_ids)
    .returns<PreparedCardRow[]>();

  if (cardErr) throw new Error(`カード取得失敗: ${cardErr.message}`);

  // 別Runから追加したカードも許可するが、共有DB上の他店舗カードは拒否する。
  const cardMap = new Map((cards || []).map(c => [c.id, c]));
  const expectedCardCount = new Set(page.card_ids).size;
  if (cardMap.size !== expectedCardCount) throw new Error('ページ内カードの一部が見つかりません');
  const cardRunIds = [...new Set((cards || []).map(card => card.run_id))];
  if (cardRunIds.length > 0) {
    const { data: ownedCardRuns, error: cardRunError } = await supabase
      .from('run')
      .select('id')
      .in('id', cardRunIds)
      .eq('store', STORE_NAME);
    if (cardRunError || (ownedCardRuns?.length ?? 0) !== cardRunIds.length) {
      throw new Error(`他店舗のカードを含むページは再生成できません: ${cardRunError?.message ?? pageId}`);
    }
  }

  // card_ids の順序を保持
  const orderedCards = page.card_ids.map(id => cardMap.get(id)!).filter(Boolean);
  const psa10DiscountRates = await loadPsa10DiscountRates(supabase, STORE_NAME);
  const orderedCardsWithCurrentPrices = applyCurrentPsa10DiscountRates(orderedCards, psa10DiscountRates);

  console.log(`[regenerate-page] カード数: ${orderedCardsWithCurrentPrices.length}`);

  // ---- 3. アセットプロファイル取得 ----
  const { data: profileArr, error: profileErr } = await supabase
    .from('asset_profile')
    .select('*')
    .eq('store', STORE_NAME)
    .eq('franchise', page.franchise as 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!')
    .limit(1)
    .returns<AssetProfileRow[]>();
  const profile = profileArr?.[0] ?? null;

  if (profileErr || !profile) throw new Error(`プロファイルが見つかりません: ${profileErr?.message}`);

  let layoutTemplate: LayoutTemplateRow | null = null;
  if (page.layout_template_id) {
    const { data: layoutRow, error: layoutErr } = await supabase
      .from('layout_template')
      .select('*')
      .eq('id', page.layout_template_id)
      .eq('store', STORE_NAME)
      .single<LayoutTemplateRow>();
    if (layoutErr || !layoutRow) throw new Error(`layout_template 取得失敗: ${layoutErr?.message ?? '該当なし'}`);
    layoutTemplate = layoutRow;
  }

  const profileLayout = profile.layout_config as LayoutConfig;

  // ---- 4. アセットダウンロード ----
  const accessToken = await getAccessToken();

  const label = page.page_label ?? '';
  const isBOX = label === 'BOX' || label.startsWith('BOX-');
  const layout: LayoutConfig = layoutTemplate?.layout_config ?? (isBOX ? makeBoxLayout(profileLayout) : profileLayout);

  // layout_config に BOX用テンプレートID が埋め込まれている場合がある
  const extendedLayout = profileLayout;

  let templateBuffer: Buffer;
  let cardBackBuffer: Buffer;

  if (layoutTemplate) {
    templateBuffer = await downloadTemplateAsset({
      supabase,
      storagePath: layoutTemplate.template_storage_path,
      driveId: null,
      accessToken,
      label: `${page.franchise}/${layoutTemplate.slug} テンプレ`,
    });
    cardBackBuffer = await downloadTemplateAsset({
      supabase,
      storagePath: layoutTemplate.card_back_storage_path,
      driveId: profile.card_back_image,
      accessToken,
      label: `${page.franchise}/${layoutTemplate.slug} カード裏`,
    });
  } else if (isBOX) {
    const franchiseSlug = FRANCHISE_STORAGE_SLUG[page.franchise] ?? page.franchise.toLowerCase();
    [templateBuffer, cardBackBuffer] = await Promise.all([
      downloadTemplateAsset({
        supabase,
        storagePath: profile.template_box_storage_path,
        driveId: BOX_TEMPLATE_DRIVE_ID[page.franchise] ?? extendedLayout.templateFileId_BOX,
        accessToken,
        label: `${page.franchise}/BOX テンプレ`,
      }),
      downloadTemplateAsset({
        supabase,
        storagePath: profile.card_back_box_storage_path ?? extendedLayout.cardBackId_BOX ?? `card-backs/${STORE_NAME}/${franchiseSlug}_box.png`,
        driveId: profile.card_back_image,
        accessToken,
        label: `${page.franchise}/BOX カード裏`,
      }),
    ]);
  } else {
    templateBuffer = await downloadDriveFile(accessToken, profile.template_image!);
    cardBackBuffer = await downloadDriveFile(accessToken, profile.card_back_image!);
  }

  console.log(`[regenerate-page] テンプレート・カード裏面ダウンロード完了`);

  // レアリティアイコン
  const rarityIconBuffers = new Map<string, Buffer>();
  const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;

  if (harakaDbSpreadsheetId && profile.rarity_icons) {
    const rarityIcons = profile.rarity_icons as Record<string, string>;
    const neededRarities = new Set<string>();
    for (const card of orderedCardsWithCurrentPrices) {
      if (card.rarity_icon_url) neededRarities.add(card.rarity_icon_url);
    }
    for (const iconUrl of neededRarities) {
      // アイコンのDrive IDを探す
      for (const [, driveId] of Object.entries(rarityIcons)) {
        if (driveId === iconUrl || iconUrl.includes(driveId)) {
          try {
            const buf = await downloadDriveFile(accessToken, driveId);
            rarityIconBuffers.set(iconUrl, buf);
          } catch {
            console.log(`[regenerate-page] アイコンDL失敗: ${iconUrl}`);
          }
          break;
        }
      }
    }
  }

  // ---- 5. カード画像ダウンロード（alt_image_url バリデーション付きフォールバック） ----
  const primaryUrls = orderedCardsWithCurrentPrices.map(c => c.image_url || c.alt_image_url || null);
  const primaryBuffers = await downloadImagesWithConcurrency(accessToken, primaryUrls, 8);

  // DL成功でも sharp で読めなければ alt_image_url でリトライ
  const altRetryIndices: number[] = [];
  for (let ci = 0; ci < orderedCardsWithCurrentPrices.length; ci++) {
    const buf = primaryBuffers[ci];
    if (!buf && orderedCardsWithCurrentPrices[ci].alt_image_url && orderedCardsWithCurrentPrices[ci].image_url) {
      altRetryIndices.push(ci);
    } else if (buf) {
      try {
        await sharp(buf).metadata();
      } catch {
        primaryBuffers[ci] = null;
        if (orderedCardsWithCurrentPrices[ci].alt_image_url) {
          altRetryIndices.push(ci);
        }
      }
    }
  }

  if (altRetryIndices.length > 0) {
    const altUrls = altRetryIndices.map(ci => orderedCardsWithCurrentPrices[ci].alt_image_url!);
    const altBuffers = await downloadImagesWithConcurrency(accessToken, altUrls, 8);
    altRetryIndices.forEach((ci, ai) => {
      if (altBuffers[ai]) {
        primaryBuffers[ci] = altBuffers[ai];
        console.log(`[regenerate-page] alt_image_url で復旧: ${orderedCardsWithCurrentPrices[ci].card_name}`);
      }
    });
  }

  const cardImageBuffers = new Map<string, Buffer>();
  orderedCardsWithCurrentPrices.forEach((card, i) => {
    const buf = primaryBuffers[i];
    if (buf) cardImageBuffers.set(card.id, buf);
  });

  console.log(`[regenerate-page] カード画像: ${cardImageBuffers.size}/${orderedCardsWithCurrentPrices.length}枚ダウンロード`);

  // ---- 6. レイアウト微調整 ----
  const layoutAdjust = page.franchise === 'YU-GI-OH!'
    ? { cardYDelta: 4, priceYDelta: 0 }
    : { cardYDelta: -2, priceYDelta: 3 };

  const rowPriceAdjust: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }> = {
    1: { priceHighYDelta: 4, priceLowYDelta: 5 },
    2: { priceLowYDelta: 2 },
    3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },
    4: { priceHighYDelta: 4, priceLowYDelta: 3 },
  };

  const rowCardAdjust = page.franchise === 'YU-GI-OH!'
    ? { 1: 8, 2: 3, 3: 3, 4: 3 } as Record<number, number>
    : undefined;

  const dateText = formatGenerationDate(displayDate);
  const adjustments = resolveRegenerateAdjustments({
    layout,
    isBOX,
    fallbackLayoutAdjust: layoutAdjust,
    fallbackRowPriceAdjust: rowPriceAdjust,
    fallbackRowCardAdjust: rowCardAdjust,
  });

  // ---- 7. 画像合成 ----
  console.log(`[regenerate-page] 画像合成開始...`);
  const imageBuffer = await composePage({
    templateBuffer,
    cardBackBuffer,
    cards: orderedCardsWithCurrentPrices,
    layout,
    assetProfile: profile,
    gridCols: layoutTemplate?.grid_cols,
    rarityIconBuffers,
    cardImageBuffers,
    dateText,
    skipPriceLow: isBOX ? false : layoutTemplate?.skip_price_low ?? false,
    layoutAdjust: adjustments.layoutAdjust,
    rowPriceAdjust: adjustments.rowPriceAdjust,
    rowCardAdjust: adjustments.rowCardAdjust,
    totalSlots: layoutTemplate?.total_slots ?? profile.total_slots,
  });

  // ---- 8. Storage アップロード ----
  // 既存のimage_keyがあればそのまま上書き、なければ新規作成
  const datePath = `${storageDate.year}/${storageDate.month}/${storageDate.day}`;
  const safeFranchise = page.franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
  const safeLabel = romanizeLabel(label);
  const storageKey = `generated/${STORE_NAME}/${datePath}/${safeFranchise}/page_${page.page_index}_${safeLabel}_${Date.now()}.png`;

  const { error: uploadError } = await supabase.storage
    .from('haraka-images')
    .upload(storageKey, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (uploadError) throw new Error(`Storage アップロード失敗: ${uploadError.message}`);
  if (page.image_key && page.image_key !== storageKey) {
    await supabase.storage.from('haraka-images').remove([page.image_key]);
  }

  const { data: publicUrl } = supabase.storage
    .from('haraka-images')
    .getPublicUrl(storageKey);

  // ---- 9. generated_page 更新 ----
  await supabase.from('generated_page').update({
    status: 'generated',
    image_key: storageKey,
    image_url: publicUrl.publicUrl,
    error_message: null,
  }).eq('id', pageId);

  try {
    const buybackSheetAccessToken = await getBuybackSheetAccessToken();
    const publishResult = await publishManmanBuybackSheet({
      supabase,
      runId: page.run_id,
      accessToken: buybackSheetAccessToken,
    });
    if (publishResult.status === 'completed') {
      console.log(`[regenerate-page] Google Sheet更新完了: ${publishResult.rowCount}商品`);
    }
  } catch (sheetError) {
    const message = sheetError instanceof Error ? sheetError.message : String(sheetError);
    console.error(`[regenerate-page] Google Sheet更新失敗（再生成画像は完了状態を維持）: ${message}`);
  }

  console.log(`[regenerate-page] 完了: ${storageKey}`);
}
