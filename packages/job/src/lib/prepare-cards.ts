import type { Franchise, Database } from '@haraka/shared';
import { calculateBuyPriceLow } from '@haraka/shared';
import type { LookupMap, LookupResult } from './db-lookup.js';
import { lookupCard } from './db-lookup.js';

type RawImportRow = Database['public']['Tables']['raw_import']['Row'];
type PreparedCardInsert = Database['public']['Tables']['prepared_card']['Insert'];

/**
 * RawImport 配列を PreparedCard の Insert 配列に変換
 *
 * 1. DB 照合（lookupCard）で tag / imageUrl / rarityIcon を付与
 * 2. calculateBuyPriceLow() で price_low を計算
 * 3. price_high = kecak_price
 * 4. DB 照合でマッチしなかった場合は tag = null
 *
 * @param rawImports - raw_import テーブルのレコード
 * @param lookupMap - buildLookupMap() で構築したマップ
 * @param franchise - 商材
 */
export function prepareCards(
  rawImports: RawImportRow[],
  lookupMap: LookupMap,
  franchise: Franchise
): PreparedCardInsert[] {
  return rawImports.map((rawImport) => {
    const matched: LookupResult | null = lookupCard(lookupMap, {
      card_name: rawImport.card_name,
      grade: rawImport.grade,
      list_no: rawImport.list_no,
    });

    // kecak_price が null または 0 の場合は price_high / price_low ともに 0
    const priceHigh = rawImport.kecak_price ?? 0;
    const priceLow = priceHigh > 0 ? calculateBuyPriceLow(priceHigh, franchise) : 0;

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
