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

import { createSupabaseClient } from '../lib/supabase.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import { getAccessToken } from '../lib/auth.js';
import { composePage } from '../lib/image-composer.js';
import { downloadDriveFile, downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { updateProgress, clearProgress } from '../lib/progress.js';
import { planPages } from '../lib/page-planner.js';
import { batchInsert } from '../lib/batch.js';
import type {
  Database,
  PreparedCardRow,
  AssetProfileRow,
  LayoutConfig,
  GeneratedPageRow,
  RuleRow,
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

export async function runGenerate() {
  const supabase = createSupabaseClient();
  const t0 = Date.now();

  // ---- 1. 最新の completed run を取得 ----
  const { data: run, error: runFindError } = await supabase
    .from('run')
    .select('*')
    .eq('status', 'completed')
    .order('started_at', { ascending: false })
    .limit(1)
    .single<RunRow>();
  if (runFindError || !run) throw new Error(`completed Run が見つかりません: ${runFindError?.message}`);
  console.log(`[generate] Run 使用: ${run.id}`);

  // Run を再度 running に更新（generate フェーズ開始）
  await supabase.from('run').update({ status: 'running' }).eq('id', run.id);

  // 日付ベースのストレージパス (YYYY/MM/DD)
  const today = new Date();
  const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

  try {
    // ---- 2. Storage クリーンアップ ----
    await updateProgress(supabase, run.id, 0, 100, 'クリーンアップ中...');
    console.log('[generate] Storage クリーンアップ中...');
    for (const folder of ['Pokemon', 'ONEPIECE', 'YU-GI-OH']) {
      const prefix = `generated/${datePath}/${folder}`;
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

      // 価格フィルター（sync と同じロジック）
      const validCards = allCards.filter(
        c => c.tag && c.price_high != null && c.price_high > 0 && c.price_low != null && c.price_low > 0,
      );
      const priceMissing = allCards.filter(c => c.tag && (!c.price_high || !c.price_low));
      if (priceMissing.length > 0) {
        console.log(`[generate]   ${franchise}: 価格なし ${priceMissing.length}件（除外）`);
      }
      if (validCards.length === 0) continue;

      // asset_profile + rule 取得
      const { data: profile } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('franchise', franchise)
        .single<AssetProfileRow>();
      if (!profile) continue;

      const { data: rules } = await supabase
        .from('rule')
        .select('*')
        .eq('franchise', franchise)
        .returns<RuleRow[]>();

      const pagePlans = planPages(validCards, rules ?? [], profile.total_slots);
      console.log(`[generate]   ${franchise}: ${validCards.length}枚 → ${pagePlans.length}ページ`);

      if (pagePlans.length === 0) continue;

      const pageInserts: GeneratedPageInsert[] = pagePlans.map((plan, index) => ({
        run_id: run.id,
        franchise,
        page_index: index,
        page_label: plan.label,
        card_ids: plan.cardIds,
        status: 'pending' as const,
      }));
      await batchInsert(supabase, 'generated_page', pageInserts as unknown as Record<string, unknown>[]);
      totalPages += pagePlans.length;
    }
    console.log(`[generate] ページプラン再生成完了: ${totalPages}ページ (${Date.now() - t0}ms)`);

    // ---- 3. OAuth access token 取得 ----
    const accessToken = await getAccessToken();
    console.log('[generate] Access token 取得完了');

    const harakaDbSpreadsheetId = process.env.HARAKA_DB_SPREADSHEET_ID;
    if (!harakaDbSpreadsheetId) throw new Error('HARAKA_DB_SPREADSHEET_ID が未設定です');

    // ---- 4. franchise ごとに画像生成 ----
    let pagesGenerated = 0;

    const dateText = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
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

      const cardById = new Map((cards ?? []).map(c => [c.id, c]));

      // asset_profile 取得
      const { data: profile, error: profileError } = await supabase
        .from('asset_profile')
        .select('*')
        .eq('franchise', franchise)
        .single<AssetProfileRow>();
      if (profileError || !profile) throw new Error(`asset_profile 取得失敗 (${franchise}): ${profileError?.message}`);
      if (!profile.layout_config) throw new Error(`layout_config が未設定 (${franchise})`);

      const layout = profile.layout_config as LayoutConfig;

      // テンプレート + カード裏面ダウンロード
      const templateFileId = profile.template_image;
      const cardBackFileId = profile.card_back_image;
      if (!templateFileId || !cardBackFileId) {
        console.log(`[generate]   テンプレート/カード裏面未設定（スキップ）`);
        continue;
      }

      const tTemplate = Date.now();
      console.log(`[generate]   テンプレート/カード裏面ダウンロード中...`);
      const [templateBuffer, cardBackBuffer] = await Promise.all([
        downloadDriveFile(accessToken, templateFileId),
        downloadDriveFile(accessToken, cardBackFileId),
      ]);
      console.log(`[generate]   テンプレートDL: ${Date.now() - tTemplate}ms`);

      // BOX テンプレート
      const extendedLayout = profile.layout_config as LayoutConfig & {
        templateFileId_BOX?: string;
        cardBackId_BOX?: string;
      };
      let templateBufferBOX: Buffer | null = null;
      let cardBackBufferBOX: Buffer | null = null;
      if (extendedLayout.templateFileId_BOX) {
        try {
          [templateBufferBOX, cardBackBufferBOX] = await Promise.all([
            downloadDriveFile(accessToken, extendedLayout.templateFileId_BOX),
            extendedLayout.cardBackId_BOX
              ? downloadDriveFile(accessToken, extendedLayout.cardBackId_BOX)
              : Promise.resolve(cardBackBuffer),
          ]);
        } catch {
          console.log(`[generate]   BOXテンプレートダウンロード失敗（通常テンプレートを使用）`);
        }
      }

      // レアリティアイコンダウンロード
      const rarityIconBuffers = new Map<string, Buffer>();
      if (!rarityIconMap) {
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

      const neededRarities = new Set((cards ?? []).map(c => c.rarity_icon_url).filter(Boolean) as string[]);
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

      // レイアウト微調整（franchise共通）
      const layoutAdjust = franchise === 'YU-GI-OH!'
        ? { cardYDelta: 4, priceYDelta: 0 }
        : { cardYDelta: -2, priceYDelta: 3 };

      const rowPriceAdjust: Record<number, { priceHighYDelta?: number; priceLowYDelta?: number }> = {
        1: { priceHighYDelta: 4, priceLowYDelta: 5 },
        2: { priceLowYDelta: 2 },
        3: { priceHighYDelta: 3, priceLowYDelta: 1.5 },
        4: { priceHighYDelta: 4, priceLowYDelta: 3 },
      };

      const rowCardAdjust = franchise === 'YU-GI-OH!'
        ? { 1: 8, 2: 3, 3: 3, 4: 3 } as Record<number, number>
        : undefined;

      const safeFranchise = franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
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
        const isBOX = label === 'BOX' || label.startsWith('BOX-');
        const currentTemplate = (isBOX && templateBufferBOX) ? templateBufferBOX : templateBuffer;
        const currentCardBack = (isBOX && cardBackBufferBOX) ? cardBackBufferBOX : cardBackBuffer;

        // カード画像のダウンロード
        const tDl = Date.now();
        const imageUrls = pageCards.map(c => c.image_url || c.alt_image_url || null);
        const imageBuffers = await downloadImagesWithConcurrency(accessToken, imageUrls, 8);
        const dlMs = Date.now() - tDl;

        let dlOk = 0;
        let dlFail = 0;
        const cardImageBuffers = new Map<string, Buffer>();
        pageCards.forEach((card, i) => {
          const buf = imageBuffers[i];
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
            rarityIconBuffers,
            cardImageBuffers,
            dateText,
            skipPriceLow: isBOX,
            layoutAdjust,
            rowPriceAdjust,
            rowCardAdjust,
            totalSlots: assetProfile.total_slots,
          });
          const composeMs = Date.now() - tCompose;

          const safeLabel = romanizeLabel(label);
          const storageKey = `generated/${datePath}/${safeFranchise}/page_${pageIdx}_${safeLabel}.png`;

          const { error: uploadError } = await supabase.storage
            .from('haraka-images')
            .upload(storageKey, imageBuffer, {
              contentType: 'image/png',
              upsert: true,
            });

          if (uploadError) {
            console.log(`[generate]     Storage アップロード失敗: ${uploadError.message}`);
            await supabase.from('generated_page').update({
              status: 'failed',
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
          }).eq('id', generatedPage.id);

          console.log(`[generate]     → 生成完了: ${storageKey} (DL=${dlMs}ms, 合成=${composeMs}ms, 計=${Date.now() - tPage}ms)`);
        } catch (composeErr) {
          console.error(`[generate]     → 合成失敗:`, composeErr);
          await supabase.from('generated_page').update({
            status: 'failed',
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
    console.log(`[generate] 完了: total_pages=${totalPages}, 総時間=${Date.now() - t0}ms`);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase.from('run').update({
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    await clearProgress(supabase, run.id);
    throw err;
  }
}
