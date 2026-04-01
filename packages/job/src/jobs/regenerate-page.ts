/**
 * 単一ページ再生成ジョブ
 *
 * 指定された generated_page ID の画像を再生成する。
 * カードデータは prepared_card から最新の値を取得するため、
 * 価格や画像URLの変更後に再生成すれば反映される。
 */

import { createSupabaseClient } from '../lib/supabase.js';
import { getAccessToken } from '../lib/auth.js';
import { composePage } from '../lib/image-composer.js';
import { downloadDriveFile, downloadImagesWithConcurrency } from '../lib/google-drive.js';
import { fetchSheetValues } from '../lib/google-sheets.js';
import type {
  PreparedCardRow,
  AssetProfileRow,
  LayoutConfig,
  GeneratedPageRow,
} from '@haraka/shared';

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

export async function runRegeneratePage() {
  const pageId = process.env.PAGE_ID;
  if (!pageId) throw new Error('PAGE_ID が未設定です');

  const supabase = createSupabaseClient();
  console.log(`[regenerate-page] ページ再生成開始: ${pageId}`);

  try {
    await _runRegeneratePage(supabase, pageId);
  } catch (err) {
    // 失敗時にステータスを更新（ポーリングで検知可能に）
    await supabase.from('generated_page').update({ status: 'failed' }).eq('id', pageId);
    throw err;
  }
}

async function _runRegeneratePage(supabase: ReturnType<typeof createSupabaseClient>, pageId: string) {

  // ---- 1. ページ情報取得 ----
  const { data: page, error: pageErr } = await supabase
    .from('generated_page')
    .select('*')
    .eq('id', pageId)
    .single<GeneratedPageRow>();

  if (pageErr || !page) throw new Error(`ページが見つかりません: ${pageErr?.message}`);

  // ---- 2. カードデータ取得 ----
  const { data: cards, error: cardErr } = await supabase
    .from('prepared_card')
    .select('*')
    .in('id', page.card_ids)
    .returns<PreparedCardRow[]>();

  if (cardErr) throw new Error(`カード取得失敗: ${cardErr.message}`);

  // card_ids の順序を保持
  const cardMap = new Map((cards || []).map(c => [c.id, c]));
  const orderedCards = page.card_ids.map(id => cardMap.get(id)!).filter(Boolean);

  console.log(`[regenerate-page] カード数: ${orderedCards.length}`);

  // ---- 3. アセットプロファイル取得 ----
  const { data: profile, error: profileErr } = await supabase
    .from('asset_profile')
    .select('*')
    .eq('franchise', page.franchise as 'Pokemon' | 'ONE PIECE' | 'YU-GI-OH!')
    .single<AssetProfileRow>();

  if (profileErr || !profile) throw new Error(`プロファイルが見つかりません: ${profileErr?.message}`);

  const layout: LayoutConfig = profile.layout_config as LayoutConfig;

  // ---- 4. アセットダウンロード ----
  const accessToken = await getAccessToken();

  // テンプレート
  const label = page.page_label ?? '';
  const isBOX = label === 'BOX' || label.startsWith('BOX-');

  // layout_config に BOX用テンプレートID が埋め込まれている場合がある
  const extendedLayout = layout as LayoutConfig & {
    templateFileId_BOX?: string;
    cardBackId_BOX?: string;
  };

  let templateBuffer: Buffer;
  let cardBackBuffer: Buffer;

  if (isBOX && extendedLayout.templateFileId_BOX) {
    try {
      const results = await Promise.all([
        downloadDriveFile(accessToken, extendedLayout.templateFileId_BOX),
        extendedLayout.cardBackId_BOX
          ? downloadDriveFile(accessToken, extendedLayout.cardBackId_BOX)
          : downloadDriveFile(accessToken, profile.card_back_image!),
      ]);
      templateBuffer = results[0];
      cardBackBuffer = results[1];
    } catch {
      // BOXテンプレDL失敗時は通常テンプレート
      templateBuffer = await downloadDriveFile(accessToken, profile.template_image!);
      cardBackBuffer = await downloadDriveFile(accessToken, profile.card_back_image!);
    }
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
    for (const card of orderedCards) {
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

  // ---- 5. カード画像ダウンロード ----
  const imageUrls = orderedCards.map(c => c.image_url || c.alt_image_url || null);
  const imageBuffers = await downloadImagesWithConcurrency(accessToken, imageUrls, 8);

  const cardImageBuffers = new Map<string, Buffer>();
  orderedCards.forEach((card, i) => {
    const buf = imageBuffers[i];
    if (buf) cardImageBuffers.set(card.id, buf);
  });

  console.log(`[regenerate-page] カード画像: ${cardImageBuffers.size}/${orderedCards.length}枚ダウンロード`);

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

  const today = new Date();
  const dateText = `${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

  // ---- 7. 画像合成 ----
  console.log(`[regenerate-page] 画像合成開始...`);
  const imageBuffer = await composePage({
    templateBuffer,
    cardBackBuffer,
    cards: orderedCards,
    layout,
    assetProfile: profile,
    rarityIconBuffers,
    cardImageBuffers,
    dateText,
    skipPriceLow: isBOX,
    layoutAdjust,
    rowPriceAdjust,
    rowCardAdjust,
    totalSlots: profile.total_slots,
  });

  // ---- 8. Storage アップロード ----
  // 既存のimage_keyがあればそのまま上書き、なければ新規作成
  const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
  const safeFranchise = page.franchise.replace(/[^a-zA-Z0-9._-]/g, '') || 'franchise';
  const safeLabel = romanizeLabel(label);
  const storageKey = page.image_key || `generated/${datePath}/${safeFranchise}/page_${page.page_index}_${safeLabel}.png`;

  const { error: uploadError } = await supabase.storage
    .from('haraka-images')
    .upload(storageKey, imageBuffer, {
      contentType: 'image/png',
      upsert: true,
    });

  if (uploadError) throw new Error(`Storage アップロード失敗: ${uploadError.message}`);

  const { data: publicUrl } = supabase.storage
    .from('haraka-images')
    .getPublicUrl(storageKey);

  // ---- 9. generated_page 更新 ----
  await supabase.from('generated_page').update({
    status: 'generated',
    image_key: storageKey,
    image_url: publicUrl.publicUrl,
  }).eq('id', pageId);

  console.log(`[regenerate-page] 完了: ${storageKey}`);
}
