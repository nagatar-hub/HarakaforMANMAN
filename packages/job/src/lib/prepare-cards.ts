import type { Franchise, Database } from '@haraka/shared';
import {
  calculateBuyPriceHigh,
  calculateBuyPriceLow,
  calculateBoxPrice,
  DEFAULT_BOX_DISCOUNT_RATES,
  DEFAULT_PSA10_DISCOUNT_RATES,
  type BoxDiscountRates,
  type Psa10DiscountRates,
} from '@haraka/shared';
import type { LookupMap, LookupResult } from './db-lookup.js';
import { lookupCard } from './db-lookup.js';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type PreparedCardInsert = Database['public']['Tables']['prepared_card']['Insert'];

function calculateNonBoxPriceLow(priceHigh: number, franchise: Franchise): number {
  return calculateBuyPriceLow(priceHigh, franchise);
}

function resolveNonBoxDiscountRate(franchise: Franchise, psa10DiscountRates?: Psa10DiscountRates): number {
  return psa10DiscountRates?.[franchise] ?? DEFAULT_PSA10_DISCOUNT_RATES[franchise];
}

function normalizeBoxDiscountRates(ratesOrLegacyRate: BoxDiscountRates | number | undefined): BoxDiscountRates {
  if (typeof ratesOrLegacyRate === 'number') {
    return {
      shrink: DEFAULT_BOX_DISCOUNT_RATES.shrink,
      no_shrink: ratesOrLegacyRate,
    };
  }
  return {
    shrink: ratesOrLegacyRate?.shrink ?? DEFAULT_BOX_DISCOUNT_RATES.shrink,
    no_shrink: ratesOrLegacyRate?.no_shrink ?? DEFAULT_BOX_DISCOUNT_RATES.no_shrink,
  };
}

/**
 * RawImport 配列を PreparedCard の Insert 配列に変換
 *
 * 1. DB 照合（lookupCard）で tag / imageUrl / rarityIcon を付与
 * 2. 非BOXカードは商材別減額率を price_high に反映
 * 3. BOXカード（card_name に【BOX】を含む）は BOX 用の割引率を使う
 * 4. price_low は price_high から内部計算（BOXはシュリンク無し価格）
 * 5. DB 照合でマッチしなかった場合は tag = null
 *
 * @param rawImports - raw_import テーブルのレコード
 * @param lookupMap - buildLookupMap() で構築したマップ
 * @param franchise - 商材
 * @param boxDiscountRates - BOXの割引率。shrink=シュリンク有り、no_shrink=シュリンク無し
 * @param psa10DiscountRates - 非BOXカードの商材別減額率
 */
export function prepareCards(
  rawImports: RawImportRow[],
  lookupMap: LookupMap,
  franchise: Franchise,
  boxDiscountRates: BoxDiscountRates | number = DEFAULT_BOX_DISCOUNT_RATES,
  psa10DiscountRates?: Psa10DiscountRates,
): PreparedCardInsert[] {
  const normalizedBoxDiscountRates = normalizeBoxDiscountRates(boxDiscountRates);
  const nonBoxDiscountRate = resolveNonBoxDiscountRate(franchise, psa10DiscountRates);

  return rawImports.map((rawImport) => {
    const matched: LookupResult | null = lookupCard(lookupMap, {
      card_name: rawImport.card_name,
      grade: rawImport.grade,
      list_no: rawImport.list_no,
    });

    // kecak_price が null または 0 の場合は price_high / price_low ともに 0
    const sourcePrice = rawImport.kecak_price ?? 0;
    const isBox = rawImport.card_name?.includes('【BOX】') ?? false;
    const priceHigh = sourcePrice > 0
      ? isBox
        ? calculateBoxPrice(sourcePrice, normalizedBoxDiscountRates.shrink)
        : calculateBuyPriceHigh(sourcePrice, nonBoxDiscountRate)
      : 0;
    const priceLow = sourcePrice > 0
      ? isBox
        ? calculateBoxPrice(sourcePrice, normalizedBoxDiscountRates.no_shrink)
        : calculateNonBoxPriceLow(priceHigh, franchise)
      : 0;

    return {
      run_id: rawImport.run_id,
      raw_import_id: rawImport.id,
      franchise: rawImport.franchise,
      card_name: rawImport.card_name,
      grade: rawImport.grade,
      list_no: rawImport.list_no,
      image_url: rawImport.image_url,
      alt_image_url: matched?.imageUrl ?? null,
      rarity: rawImport.rarity,
      rarity_icon_url: matched?.rarityIcon ?? null,
      tag: matched?.tag ?? null,
      price_high: priceHigh,
      price_low: priceLow,
      image_status: 'unchecked',
      source: 'kecak',
    };
  });
}
