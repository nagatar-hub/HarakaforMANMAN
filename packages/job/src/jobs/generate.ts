/**
 * Generate ジョブ — 画像生成パイプライン
 *
 * 処理フロー:
 * 1. 最新の completed run を取得
 * 2. Storage クリーンアップ（同日画像削除）
 * 3. OAuth access token 取得
 * 4. 各 franchise: ページプラン再生成 → テンプレDL → レアリティアイコンDL → 画像合成 → Storage upload
 * 5. Run 完了更新
 *
 * ページプランは毎回 prepared_card から再生成し、最新の価格フィルターを適用する。
 */

import sharp from 'sharp';
import { createSupabaseClientFromSecrets } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { composePage } from '../lib/image-composer.js';
import { downloadDriveFile, downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { downloadTemplateAsset } from '../lib/asset-storage.js';
import { makeBoxLayout } from '../lib/box-layout.js';
import { updateProgress, clearProgress } from '../lib/progress.js';
import { planPages, type PagePlan } from '../lib/page-planner.js';
import { batchInsert } from '../lib/batch.js';
import { sendDiscordNotification, COLOR } from '../lib/discord.js';
import { getOptionalEnvOrSecret } from '../lib/env.js';
import { applyCurrentPsa10DiscountRates, loadPsa10DiscountRates } from '../lib/pricing-settings.js';
import type {
  Database,
  PreparedCardRow,
  AssetProfileRow,
  LayoutConfig,
  GeneratedPageRow,
  RuleRow,
  LayoutTemplateRow,
} from '@haraka/shared';
import { FRANCHISES } from '@haraka/shared';

type RunRow = Database['public']['Tables']['run']['Row'];
type GeneratedPageInsert = Database['public']['Tables']['generated_page']['Insert'];

// ---------------------------------------------------------------------------
// ヘルパー関数
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

const STORE_NAME = process.env.STORE_NAME ?? 'oripark';

const FRANCHISE_STORAGE_SLUG: Record<string, string> = {
  Pokemon: 'pokemon',
  'ONE PIECE': 'onepiece',
  'YU-GI-OH!': 'yugioh',
};

const BOX_TEMPLATE_DRIVE_ID: Record<string, string> = {
  Pokemon: '1ZiS1Xci3Dlc5i9SJrYoEEUUwiRuCzjZk',
  'ONE PIECE': '1RiAdjVUyDhpJyb8YxmZsZdSh6PxxEeHy',
  'YU-GI-OH!': '1uhJt5rFJyZgOX9wMvl4vLAckotKpmC_n',
};

function getJstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
  };
}

function isBoxLabel(label: string | null): boolean {
  return label === 'BOX' || !!label?.startsWith('BOX-');
}

function isBoxCard(card: PreparedCardRow): boolean {
  return card.card_name?.includes('【BOX】') === true || card.tag === 'BOX';
}

function makeFixedBoxPlans(cards: PreparedCardRow[], totalSlots: number): PagePlan[] {
  if (cards.length === 0) return [];
  const sorted = [...cards].sort((a, b) => (b.price_high ?? 0) - (a.price_high ?? 0));
  const plans: PagePlan[] = [];
  for (let i = 0; i < sorted.length; i += totalSlots) {
    const idx = Math.floor(i / totalSlots);
    const chunk = sorted.slice(i, i + totalSlots);
    plans.push({
      label: idx === 0 ? 'BOX' : `BOX-${idx + 1}`,
      cardIds: chunk.map(c => c.id),
      layoutTemplateId: '',
    });
  }
  return plans;
}

export async function runGenerate() {
  const supabase = await createSupabaseClientFromSecrets();
  const t0 = Date.now();
  const requestedRunId = process.env.RUN_ID?.trim();

  // ---- 1. 対象 run を取得 ----
  // Web API から起動される場合は、API 側で先に running 化した RUN_ID を処理する。
  const runQuery = supabase
    .from('run')
    .select('*')
    .eq('store', STORE_NAME);
  const { data: run, error: runFindError } = requestedRunId
    ? await runQuery.eq('id', requestedRunId).maybeSingle<RunRow>()
    : await runQuery
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle<RunRow>();
  if (runFindError || !run) {
    const target = requestedRunId ? `RUN_ID=${requestedRunId}` : 'completed Run';
    throw new Error(`${target} が見つかりません: ${runFindError?.message ?? 'not found'}`);
  }
  console.log(`[generate] Run 使用: ${run.id}`);

  // Run を再度 running に更新（generate フェーズ開始）
  await supabase.from('run').update({ status: 'running' }).eq('id', run.id);

  // 日付ベースのストレージパス
  const jstDate = getJstDateParts();
  const datePath = `${jstDate.year}/${jstDate.month}/${jstDate.day}`;
  const generationVersion = Date.now();

  try {
    // ---- 2. Storage クリーンアップ ----
    await updateProgress(supabase, run.id, 0, 100, 'クリーンアップ中...');
    console.log('[generate] Storage クリーンアップ中...');
    for (const folder of ['Pokemon', 'ONEPIECE', 'YU-GI-OH']) {
      const prefix = `generated/${STORE_NAME}/${datePath}/${folder}`;
      const { data: files } = await supabase.storage.from('haraka-images').list(prefix);
      if (files && files.length > 0) {
        const paths = files.map(f => `${prefix}/${f.name}`);
        await supabase.storage.from('haraka-images').remove(paths);
        console.log(`[generate]   ${folder}: ${paths.length}件削除`);
      }
    }

    // ---- 2.5. ページプランを再生成（最新の prepared_card + 価格フィルター適用） ----
    await updateProgress(supabase, run.id, 5, 100, 'ページプラン再生成中...');
    console.log('[generate] ページプラン再生成...');
    const psa10DiscountRates = await loadPsa10DiscountRates(supabase, STORE_NAME);
    const psaRateSummary = FRANCHISES
      .filter(franchise => typeof psa10DiscountRates[franchise] === 'number')
      .map(franchise => `${franchise}=${((psa10DiscountRates[franchise] ?? 0) * 100).toFixed(0)}%`)
      .join(', ');
    console.log(`[generate] PSA10減額率: ${psaRateSummary || '未設定（prepared_card の価格を使用）'}`);

    // 旧 generated_page を全削除
    await supabase.from('generated_page').delete().eq('run_id', run.id);

    let totalPages = 0;
    for (const franchise of FRANCHISES) {
      const { data: allCards } = await supabase
        .from('prepared_card')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<PreparedCardRow[]>();
      if (!allCards || allCards.length === 0) continue;
      const currentPriceCards = applyCurrentPsa10DiscountRates(allCards, psa10DiscountRates);

      // 価格フィルター（sync と同じロジック）
      const validCards = currentPriceCards.filter(
        c => c.tag && c.price_high != null && c.price_high > 0 && c.price_low != null && c.price_low > 0,
      );
      const priceMissing = currentPriceCards.filter(c => c.tag && (!c.price_high || !c.price_low));
      if (priceMissing.length > 0) {
        console.log(`[generate]   ${franchise}: 価格なし ${priceMissing.length}件（除外）`);
      }
      if (validCards.length === 0) continue;

      // asset_profile + rule 取得（store フィルタ）
      const { data: profileArr } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .limit(1)
        .returns<AssetProfileRow[]>();
      const profile = profileArr?.[0] ?? null;
      if (!profile) continue;

      const { data: rules } = await supabase
        .from('rule')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .returns<RuleRow[]>();

      const { data: layouts } = await supabase
        .from('layout_template')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .eq('kind', 'store')
        .returns<LayoutTemplateRow[]>();
      if (!layouts || layouts.length === 0) {
        throw new Error(`layout_template が未登録です (${STORE_NAME}/${franchise})。upload-manman-store-templates を先に実行してください`);
      }

      // BOX/PSA を分離してそれぞれページプランを生成
      const psaCards = validCards.filter(c => !isBoxCard(c));
      const boxCards = validCards.filter(isBoxCard);

      const psaPlans = planPages(psaCards, rules ?? [], layouts);
      const boxPlans = makeFixedBoxPlans(boxCards, profile.total_slots);
      const pagePlans = [...psaPlans, ...boxPlans];
      console.log(`[generate]   ${franchise}: PSA ${psaCards.length}枚/${psaPlans.length}ページ, BOX ${boxCards.length}枚/${boxPlans.length}ページ`);

      if (pagePlans.length === 0) continue;

      const pageInserts: GeneratedPageInsert[] = pagePlans.map((plan, index) => ({
        run_id: run.id,
        franchise,
        page_index: index,
        page_label: plan.label,
        card_ids: plan.cardIds,
        layout_template_id: plan.layoutTemplateId || null,
        kind: 'store',
        status: 'pending' as const,
        display_name: `${franchise} ${plan.label || 'page'} (${index + 1}).png`,
      }));
      await batchInsert(supabase, 'generated_page', pageInserts as unknown as Record<string, unknown>[]);
      totalPages += pagePlans.length;
    }
    console.log(`[generate] ページプラン再生成完了: ${totalPages}ページ (${Date.now() - t0}ms)`);

    // ---- 3. OAuth access token 取得 ----
    const accessToken = await getAccessToken();
    console.log('[generate] Access token 取得完了');

    const harakaDbSpreadsheetId = await getOptionalEnvOrSecret('HARAKA_DB_SPREADSHEET_ID');
    if (!harakaDbSpreadsheetId) {
      console.log('[generate] HARAKA_DB_SPREADSHEET_ID 未設定: レアリティアイコン取得をスキップ');
    }

    // ---- 4. franchise ごとに画像生成 ----
    let pagesGenerated = 0;

    const dateText = `${jstDate.month}/${jstDate.day}`;
    let rarityIconMap: Map<string, string> | null = null;
    const rarityIconCache = new Map<string, Buffer>();

    for (const franchise of FRANCHISES) {
      const tFranchise = Date.now();
      console.log(`[generate] === ${franchise} ===`);

      // generated_page を取得（↑で再生成済み）
      const { data: generatedPages } = await supabase
        .from('generated_page')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .order('page_index', { ascending: true })
        .returns<GeneratedPageRow[]>();

      if (!generatedPages || generatedPages.length === 0) {
        console.log(`[generate]   → ページ 0件（スキップ）`);
        continue;
      }
      console.log(`[generate]   ページ数: ${generatedPages.length}`);

      // このfranchiseのprepared_cardを取得（cardById マップ構築用）
      const { data: cards, error: cardsError } = await supabase
        .from('prepared_card')
        .select('*')
        .eq('run_id', run.id)
        .eq('franchise', franchise)
        .returns<PreparedCardRow[]>();
      if (cardsError) throw new Error(`prepared_card 取得失敗: ${cardsError.message}`);
      const currentPriceCards = applyCurrentPsa10DiscountRates(cards ?? [], psa10DiscountRates);

      const cardById = new Map(currentPriceCards.map(c => [c.id, c]));

      // asset_profile 取得（store フィルタ）
      const { data: profileArr2, error: profileError } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('store', STORE_NAME)
        .eq('franchise', franchise)
        .limit(1)
        .returns<AssetProfileRow[]>();
      const profile = profileArr2?.[0] ?? null;
      if (profileError || !profile) throw new Error(`asset_profile 取得失敗 (${franchise}): ${profileError?.message}`);
      if (!profile.layout_config) throw new Error(`layout_config が未設定 (${franchise})`);
      const safeFranchise = franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';

      const neededLayoutIds = Array.from(
        new Set(generatedPages.map(p => p.layout_template_id).filter((v): v is string => !!v)),
      );
      const { data: layoutRows, error: layoutErr } = await supabase
        .from('layout_template')
        .select('*')
        .in('id', neededLayoutIds.length > 0 ? neededLayoutIds : ['00000000-0000-0000-0000-000000000000'])
        .returns<LayoutTemplateRow[]>();
      if (layoutErr) throw new Error(`layout_template 取得失敗 (${franchise}): ${layoutErr.message}`);
      const layoutById = new Map<string, LayoutTemplateRow>((layoutRows ?? []).map(l => [l.id, l]));

      const tTemplate = Date.now();
      console.log(`[generate]   Storageテンプレート/カード裏面ダウンロード中...`);
      const templateCache = new Map<string, Buffer>();
      const cardBackCache = new Map<string, Buffer>();
      await Promise.all([...layoutById.values()].map(async (layoutTemplate) => {
        const [template, cardBack] = await Promise.all([
          downloadTemplateAsset({
            supabase,
            storagePath: layoutTemplate.template_storage_path,
            driveId: null,
            accessToken,
            label: `${franchise}/${layoutTemplate.slug} テンプレ`,
          }),
          downloadTemplateAsset({
            supabase,
            storagePath: layoutTemplate.card_back_storage_path,
            driveId: profile.card_back_image,
            accessToken,
            label: `${franchise}/${layoutTemplate.slug} カード裏`,
          }),
        ]);
        templateCache.set(layoutTemplate.id, template);
        cardBackCache.set(layoutTemplate.id, cardBack);
      }));

      const needsBoxAssets = generatedPages.some(p => isBoxLabel(p.page_label));
      let boxTemplateBuffer: Buffer | null = null;
      let boxCardBackBuffer: Buffer | null = null;
      if (needsBoxAssets) {
        const baseLayout = profile.layout_config as LayoutConfig;
        const franchiseSlug = FRANCHISE_STORAGE_SLUG[franchise] ?? safeFranchise.toLowerCase();
        [boxTemplateBuffer, boxCardBackBuffer] = await Promise.all([
          downloadTemplateAsset({
            supabase,
            storagePath: profile.template_box_storage_path,
            driveId: BOX_TEMPLATE_DRIVE_ID[franchise] ?? baseLayout.templateFileId_BOX,
            accessToken,
            label: `${franchise}/BOX テンプレ`,
          }),
          downloadTemplateAsset({
            supabase,
            storagePath: profile.card_back_box_storage_path ?? baseLayout.cardBackId_BOX ?? `card-backs/${STORE_NAME}/${franchiseSlug}_box.png`,
            driveId: profile.card_back_image,
            accessToken,
            label: `${franchise}/BOX カード裏`,
          }),
        ]);
      }
      console.log(`[generate]   テンプレートDL: ${Date.now() - tTemplate}ms`);

      // レアリティアイコンダウンロード
      const rarityIconBuffers = new Map<string, Buffer>();
      if (!rarityIconMap) {
        if (!harakaDbSpreadsheetId) {
          rarityIconMap = new Map();
        } else {
          try {
          const iconRows = await fetchSheetValues({
            accessToken,
            spreadsheetId: harakaDbSpreadsheetId,
            range: 'RarityIcons!A2:B100',
          });
          rarityIconMap = new Map<string, string>();
          for (const row of iconRows) {
            const name = row[0]?.trim();
            const driveId = row[1]?.trim();
            if (name && driveId) rarityIconMap.set(name, driveId);
          }
          console.log(`[generate] RarityIcons シート読込: ${rarityIconMap.size}件`);
          } catch (e) {
          console.log(`[generate] RarityIcons シート読込失敗:`, e);
          rarityIconMap = new Map();
          }
        }
      }

      const neededRarities = new Set(currentPriceCards.map(c => c.rarity_icon_url).filter(Boolean) as string[]);
      for (const rarityName of neededRarities) {
        if (rarityIconBuffers.has(rarityName)) continue;
        if (rarityIconCache.has(rarityName)) {
          rarityIconBuffers.set(rarityName, rarityIconCache.get(rarityName)!);
          continue;
        }
        const driveId = rarityIconMap.get(rarityName);
        if (!driveId) {
          console.log(`[generate]     レアリティアイコン未登録: ${rarityName}`);
          continue;
        }
        try {
          const buf = await downloadDriveFile(accessToken, driveId);
          rarityIconBuffers.set(rarityName, buf);
          rarityIconCache.set(rarityName, buf);
        } catch {
          console.log(`[generate]     アイコンダウンロード失敗: ${rarityName} (${driveId})`);
        }
      }
      if (neededRarities.size > 0) {
        console.log(`[generate]   レアリティアイコン: ${rarityIconBuffers.size}/${neededRarities.size}種ダウンロード`);
      }

      // 各ページの画像を並列生成（同時5ページ）
      const PAGE_CONCURRENCY = 5;

      const pages = generatedPages; // narrowed non-null reference
      const assetProfile = profile; // narrowed non-null reference

      async function generateOnePage(pageIdx: number) {
        const tPage = Date.now();
        const generatedPage = pages[pageIdx];
        const pageCards = generatedPage.card_ids
          .map(id => cardById.get(id))
          .filter((c): c is PreparedCardRow => {
            if (!c) return false;
            if (!c.price_high || c.price_high <= 0 || !c.price_low || c.price_low <= 0) {
              console.warn(`[generate]     価格なしカード除外: ${c.card_name} (price_high=${c.price_high})`);
              return false;
            }
            return true;
          });

        const label = generatedPage.page_label ?? '';
        const layoutTemplate = generatedPage.layout_template_id
          ? layoutById.get(generatedPage.layout_template_id)
          : null;
        const isBoxPage = isBoxLabel(label);
        if (!layoutTemplate && !isBoxPage) {
          const errMsg = `layout_template が未設定: page_id=${generatedPage.id}`;
          console.error(`[generate]     ${errMsg}`);
          await supabase.from('generated_page').update({
            status: 'failed',
            error_message: errMsg,
          }).eq('id', generatedPage.id);
          return;
        }

        const layout = isBoxPage
          ? makeBoxLayout(assetProfile.layout_config as LayoutConfig)
          : layoutTemplate!.layout_config;
        const currentTemplate = isBoxPage ? boxTemplateBuffer : templateCache.get(layoutTemplate!.id);
        const currentCardBack = isBoxPage ? boxCardBackBuffer : cardBackCache.get(layoutTemplate!.id);
        if (!currentTemplate || !currentCardBack) {
          const errMsg = `テンプレートキャッシュが未設定: ${isBoxPage ? 'BOX' : layoutTemplate!.slug}`;
          console.error(`[generate]     ${errMsg}`);
          await supabase.from('generated_page').update({
            status: 'failed',
            error_message: errMsg,
          }).eq('id', generatedPage.id);
          return;
        }

        // カード画像のダウンロード（image_url → alt_image_url バリデーション付きフォールバック）
        const tDl = Date.now();
        const primaryUrls = pageCards.map(c => c.image_url || c.alt_image_url || null);
        const primaryBuffers = await downloadImagesWithConcurrency(accessToken, primaryUrls, 8);

        // DL成功でも sharp で読めなければ alt_image_url でリトライ
        const altRetryIndices: number[] = [];
        for (let ci = 0; ci < pageCards.length; ci++) {
          const buf = primaryBuffers[ci];
          if (!buf && pageCards[ci].alt_image_url && pageCards[ci].image_url) {
            altRetryIndices.push(ci);
          } else if (buf) {
            try {
              await sharp(buf).metadata();
            } catch {
              primaryBuffers[ci] = null;
              if (pageCards[ci].alt_image_url) {
                altRetryIndices.push(ci);
              }
            }
          }
        }

        if (altRetryIndices.length > 0) {
          const altUrls = altRetryIndices.map(ci => pageCards[ci].alt_image_url!);
          const altBuffers = await downloadImagesWithConcurrency(accessToken, altUrls, 8);
          altRetryIndices.forEach((ci, ai) => {
            if (altBuffers[ai]) {
              primaryBuffers[ci] = altBuffers[ai];
              console.log(`[generate]     alt_image_url で復旧: ${pageCards[ci].card_name}`);
            }
          });
        }

        const dlMs = Date.now() - tDl;

        let dlOk = 0;
        let dlFail = 0;
        const cardImageBuffers = new Map<string, Buffer>();
        pageCards.forEach((card, i) => {
          const buf = primaryBuffers[i];
          if (buf) {
            cardImageBuffers.set(card.id, buf);
            dlOk++;
          } else {
            dlFail++;
            const url = card.image_url || card.alt_image_url || '(なし)';
            console.warn(`[generate]     画像DL失敗: ${card.card_name} url=${url}`);
          }
        });
        if (dlFail > 0) {
          console.warn(`[generate]     画像DL: ${dlOk}成功 / ${dlFail}失敗 (${dlMs}ms)`);
        }

        // 画像合成
        try {
          const tCompose = Date.now();
          const imageBuffer = await composePage({
            templateBuffer: currentTemplate,
            cardBackBuffer: currentCardBack,
            cards: pageCards,
            layout,
            assetProfile: assetProfile,
            gridCols: isBoxPage ? assetProfile.grid_cols : layoutTemplate!.grid_cols,
            rarityIconBuffers,
            cardImageBuffers,
            dateText,
            skipPriceLow: isBoxPage ? false : layoutTemplate!.skip_price_low,
            layoutAdjust: layout.layoutAdjust,
            rowPriceAdjust: layout.rowPriceAdjust,
            rowCardAdjust: layout.rowCardAdjust,
            totalSlots: isBoxPage ? assetProfile.total_slots : layoutTemplate!.total_slots,
          });
          const composeMs = Date.now() - tCompose;

          const safeLabel = romanizeLabel(label);
          const storageKey = `generated/${STORE_NAME}/${datePath}/${safeFranchise}/page_${pageIdx}_${safeLabel}_${generationVersion}.png`;

          const { error: uploadError } = await supabase.storage
            .from('haraka-images')
            .upload(storageKey, imageBuffer, {
              contentType: 'image/png',
              upsert: true,
            });

          if (uploadError) {
            const errMsg = `Storage アップロード失敗: ${uploadError.message}`;
            console.log(`[generate]     ${errMsg}`);
            await supabase.from('generated_page').update({
              status: 'failed',
              error_message: errMsg,
            }).eq('id', generatedPage.id);
            return;
          }

          const { data: publicUrl } = supabase.storage
            .from('haraka-images')
            .getPublicUrl(storageKey);

          await supabase.from('generated_page').update({
            status: 'generated',
            image_key: storageKey,
            image_url: publicUrl.publicUrl,
            error_message: null,
          }).eq('id', generatedPage.id);

          console.log(`[generate]     → 生成完了: ${storageKey} (DL=${dlMs}ms, 合成=${composeMs}ms, 計=${Date.now() - tPage}ms)`);
        } catch (composeErr) {
          const errMsg = composeErr instanceof Error ? composeErr.message : String(composeErr);
          console.error(`[generate]     → 合成失敗: ${errMsg}`);
          await supabase.from('generated_page').update({
            status: 'failed',
            error_message: `合成失敗: ${errMsg}`,
          }).eq('id', generatedPage.id);
        }
      }

      // 並列ワーカーで処理
      let pageQueue = 0;
      async function pageWorker() {
        while (pageQueue < pages.length) {
          const idx = pageQueue++;
          console.log(`[generate]   ページ ${idx + 1}/${pages.length} (${pages[idx].page_label})`);
          await generateOnePage(idx);
          pagesGenerated++;
          await updateProgress(supabase, run!.id, pagesGenerated, totalPages, `${franchise}: ページ ${pagesGenerated}/${totalPages}`);
        }
      }

      const workers = Array.from(
        { length: Math.min(PAGE_CONCURRENCY, pages.length) },
        () => pageWorker(),
      );
      await Promise.all(workers);
      console.log(`[generate]   ${franchise} 完了: ${Date.now() - tFranchise}ms`);
    }

    // ---- 5. Run 完了更新 ----
    await supabase.from('run').update({
      total_pages: totalPages,
      generate_done_at: new Date().toISOString(),
      status: 'completed',
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);

    await clearProgress(supabase, run.id);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[generate] 完了: total_pages=${totalPages}, 総時間=${Date.now() - t0}ms`);

    // 失敗ページ数を集計
    const { count: failedPageCount } = await supabase
      .from('generated_page')
      .select('*', { count: 'exact', head: true })
      .eq('run_id', run.id)
      .eq('status', 'failed');

    const failedPages = failedPageCount ?? 0;
    const hasFailures = failedPages > 0;

    if (hasFailures) {
      console.warn(`[generate] ⚠️ 失敗ページ: ${failedPages}`);
    }

    // Discord 通知: 成功（失敗ありなら警告色）
    await sendDiscordNotification({
      title: hasFailures ? '🟡 Generate ジョブ完了（一部失敗あり）' : '🟢 Generate ジョブ完了',
      description: hasFailures
        ? `画像生成完了。${failedPages}ページが失敗しました。`
        : '画像生成が正常に完了しました。',
      color: hasFailures ? COLOR.WARNING : COLOR.SUCCESS,
      fields: [
        { name: '生成ページ数', value: `${totalPages}`, inline: true },
        ...(hasFailures ? [{ name: '失敗ページ数', value: `${failedPages}`, inline: true }] : []),
        { name: '所要時間', value: `${elapsed}s`, inline: true },
      ],
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('run').update({
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    await clearProgress(supabase, run.id);

    // Discord 通知: 失敗
    await sendDiscordNotification({
      title: '🔴 Generate ジョブ失敗',
      description: message,
      color: COLOR.ERROR,
      fields: [
        { name: 'ジョブ', value: 'generate', inline: true },
        { name: 'エラー', value: message.substring(0, 1000) },
      ],
    });

    throw err;
  }
}
